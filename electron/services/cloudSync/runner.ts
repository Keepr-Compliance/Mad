/**
 * Keepr Cloud upload pass — BACKLOG-4243 PR-2 (plan §5, §8; PR-0 review R1–R10).
 *
 * One pass at a time per install (R5): a trigger while a pass runs queues one
 * more pass; passes never interleave.
 *
 * A pass is pinned to one user at its start: the validated session user, the
 * SDK user and the server state's user_id must all agree (§5.2). Every call of
 * the pass sends that pinned id as `p_expected_user_id` (R1), and before each
 * call the session epoch and the SDK user are re-checked synchronously (§5.3);
 * any change stops the pass and records nothing.
 *
 * A row counts as saved only when the envelope is ok AND its status is
 * `applied`/`unchanged` AND the returned content_hash equals the sent one (R2).
 * `cloud_mark_deal_synced` is called only after that (R3; header only until
 * PR-3 adds the child kinds). Local state for a response is written in one
 * SAVEPOINT; a dirty mark is cleared only if its generation is unchanged (R4).
 */
import type { CallResult, CloudClient } from "./cloudClient";
import { HASH_VERSION, projectDeal, type DealRow } from "./projection";
import { parseState, type ServerState } from "./stateReader";
import type { SessionIdentity, SessionUser } from "./session";
import type { SqlDb } from "../db/cloudSyncSqlDb";
import * as store from "../db/cloudSyncDbService";

export const SAVED_ROW_STATUSES = ["applied", "unchanged"] as const;
export const DEALS_PER_PASS = 200;

export type PassOutcome =
  | "done"
  | "queued"
  | "idle"
  | "signed_out"
  | "identity_mismatch"
  | "wrong_account"
  | "needs_confirmation"
  | "not_enabled"
  | "paused"
  | "offline"
  | "other_project"
  | "blocked"
  | "unknown_state"
  | "stopped";

export interface RunnerLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RunnerDeps {
  db: () => SqlDb;
  client: CloudClient;
  identity: SessionIdentity;
  getAuthUserId: () => string | null;
  projectRef: string;
  /** Install id for this project (machine binding applied). */
  installId: () => string;
  /** Why the engine must not run here (dev guard), or null. */
  blockedReason: () => string | null;
  isOnline: () => boolean;
  now?: () => Date;
  log?: RunnerLog;
  /** At most one per pass; code only. */
  reportFailure?: (code: string) => void;
}

export interface PassSummary {
  outcome: PassOutcome;
  done: number;
  failed: number;
  state?: ServerState;
}

class StopPass extends Error {
  constructor(readonly outcome: PassOutcome) {
    super(outcome);
  }
}

const noLog: RunnerLog = { info: () => undefined, warn: () => undefined };

function shortId(id: string): string {
  return id.slice(0, 8);
}

type DealResult = "done" | "failed" | "kept";

export class CloudSyncRunner {
  private running: Promise<PassSummary> | null = null;
  private queued = false;
  private stopRequested = false;
  lastSummary: PassSummary | null = null;
  /** Server writes this pass that the server accepted (upsert saved, delete, mark synced). */
  private sentThisPass = 0;

  constructor(private readonly deps: RunnerDeps) {
    deps.identity.onCleared(() => {
      this.stopRequested = true;
    });
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private get log(): RunnerLog {
    return this.deps.log ?? noLog;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Stops the running pass at its next check (before its next call). */
  requestStop(): void {
    this.stopRequested = true;
    this.queued = false;
  }

  /** Resolves when no pass is running. */
  whenIdle(): Promise<void> {
    return this.running ? this.running.then(() => undefined, () => undefined) : Promise.resolve();
  }

  /** Runs a pass, or queues one more after the running pass (single-flight, R5). */
  runPass(): Promise<PassSummary> {
    if (this.running) {
      this.queued = true;
      return Promise.resolve({ outcome: "queued", done: 0, failed: 0 });
    }
    const loop = async (): Promise<PassSummary> => {
      let summary: PassSummary;
      do {
        this.queued = false;
        this.stopRequested = false;
        this.sentThisPass = 0;
        summary = await this.passOnce();
      } while (this.queued && summary.outcome === "done");
      return summary;
    };
    this.running = loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async passOnce(): Promise<PassSummary> {
    const { deps } = this;
    const db = deps.db();
    const blocked = deps.blockedReason();
    if (blocked) return this.finish({ outcome: "blocked", done: 0, failed: 0 });
    if (store.otherProjectInUse(db, deps.projectRef)) return this.finish({ outcome: "other_project", done: 0, failed: 0 });

    const session = await deps.identity.current();
    if (!session) return this.finish({ outcome: "signed_out", done: 0, failed: 0 });
    if (deps.getAuthUserId() !== session.userId) return this.finish({ outcome: "identity_mismatch", done: 0, failed: 0 });

    const settings = store.getSettings(db, deps.projectRef, session.userId);
    const owed = !!settings?.turn_off_owed_at;
    if (!owed && (!settings || settings.enabled !== 1)) {
      return this.finish({ outcome: "idle", done: 0, failed: 0 });
    }
    if (!deps.isOnline()) return this.finish({ outcome: "offline", done: 0, failed: 0 });

    const installId = deps.installId();
    // The install step may have reset this computer (N1): re-read.
    const fresh = store.getSettings(db, deps.projectRef, session.userId);
    if (!fresh || (fresh.enabled !== 1 && !fresh.turn_off_owed_at)) {
      return this.finish({ outcome: "needs_confirmation", done: 0, failed: 0 });
    }

    const read = parseState(await deps.client.getState());
    if (read.kind !== "state") return this.finish({ outcome: "unknown_state", done: 0, failed: 0 });
    const state = read.state;
    if (state.userId !== session.userId) return this.finish({ outcome: "identity_mismatch", done: 0, failed: 0, state });

    const pinned: SessionUser = { userId: session.userId, epoch: session.epoch };

    // A turn-off made offline is still owed (plan §8.8).
    if (fresh.turn_off_owed_at) {
      this.guard(pinned);
      const res = await this.settleOwedTurnOff(pinned.userId);
      if (res.kind === "refused" && res.code === "wrong_account") return this.wrongAccount(state);
      return this.finish({ outcome: "not_enabled", done: 0, failed: 0, state });
    }

    switch (state.reasonClass) {
      case "entitled":
        break;
      case "not_enabled":
        // Turned off for the account elsewhere: local off, this user's state and marks cleared.
        this.applyTurnedOffElsewhere(db, pinned.userId);
        return this.finish({ outcome: "not_enabled", done: 0, failed: 0, state });
      default:
        // notice_outdated, a licence reason, or an unknown reason: paused. Nothing cleared.
        return this.finish({ outcome: "paused", done: 0, failed: 0, state });
    }
    if (!fresh.local_confirmed_at) return this.finish({ outcome: "needs_confirmation", done: 0, failed: 0, state });

    store.applyAcceptedAt(db, deps.projectRef, pinned.userId, state.acceptedAt);

    let done = 0;
    let failed = 0;
    try {
      const due = store.selectDueDirty(db, pinned.userId, this.now(), DEALS_PER_PASS);
      for (const row of due) {
        this.guard(pinned);
        const r = await this.processDeal(db, pinned, installId, row);
        if (r === "done") done++;
        else if (r === "failed") failed++;
      }
    } catch (error) {
      if (error instanceof StopPass) {
        if (error.outcome === "wrong_account") return this.wrongAccount(state, done, failed);
        return this.finish({ outcome: error.outcome, done, failed, state });
      }
      throw error;
    }
    return this.finish({ outcome: "done", done, failed, state });
  }

  private wrongAccount(state: ServerState, done = 0, failed = 0): PassSummary {
    this.deps.identity.invalidate();
    this.log.warn("[CloudSync] Pass stopped: account changed", {});
    this.deps.reportFailure?.("wrong_account");
    return this.finish({ outcome: "wrong_account", done, failed, state });
  }

  /**
   * The server half of a turn-off: `set_my_cloud_autosave(false)`; the owed
   * marker is cleared only when the server confirmed. Safe to repeat.
   */
  async settleOwedTurnOff(userId: string): Promise<CallResult> {
    const res = await this.deps.client.setAutosave(userId, false, null);
    if (res.kind === "ok") store.clearTurnOffOwed(this.deps.db(), this.deps.projectRef, userId);
    return res;
  }

  /** Turned off for the account on another computer: off here, this user's state and marks cleared. */
  private applyTurnedOffElsewhere(db: SqlDb, userId: string): void {
    store.disableForUser(db, this.deps.projectRef, userId, false, this.now());
  }

  /** §5.3: synchronously, before every call. */
  private guard(pinned: SessionUser): void {
    if (this.stopRequested) throw new StopPass("stopped");
    if (this.deps.identity.epoch !== pinned.epoch) throw new StopPass("stopped");
    if (this.deps.getAuthUserId() !== pinned.userId) throw new StopPass("identity_mismatch");
  }

  private finish(summary: PassSummary): PassSummary {
    this.lastSummary = summary;
    // "Last saved" moves only when the server accepted a write in this pass.
    if (this.sentThisPass > 0 || summary.failed > 0) {
      try {
        store.recordRun(
          this.deps.db(),
          this.deps.projectRef,
          { outcome: summary.outcome, done: this.sentThisPass, failed: summary.failed, rejected: 0, errorCode: null },
          this.now(),
        );
      } catch {
        /* counters only */
      }
    }
    if (summary.outcome === "done" || summary.failed > 0) {
      this.log.info("[CloudSync] Pass finished", { outcome: summary.outcome, done: summary.done, failed: summary.failed });
    }
    return summary;
  }

  /** Handles a call result shared by every call: stop on identity/entitlement codes. */
  private stopOn(res: CallResult): void {
    if (res.kind !== "refused") return;
    if (res.code === "wrong_account") throw new StopPass("wrong_account");
    if (res.code === "not_entitled" || res.code === "not_authorized") throw new StopPass("paused");
  }

  private recordFailure(db: SqlDb, row: store.DirtyRow, res: CallResult): DealResult {
    if (res.kind === "transport") {
      store.recordRetryableFailure(db, row, res.code, this.now());
      this.log.warn("[CloudSync] Deal not saved (will retry)", { code: res.code, deal: shortId(row.transaction_id) });
    } else if (res.kind === "refused") {
      store.recordNonRetryableFailure(db, row, res.code);
      this.log.warn("[CloudSync] Deal not saved", { code: res.code, deal: shortId(row.transaction_id) });
    }
    return "failed";
  }

  private async processDeal(db: SqlDb, pinned: SessionUser, installId: string, row: store.DirtyRow): Promise<DealResult> {
    const { projectRef } = this.deps;
    const deal = store.readDealRow(db, row.transaction_id);
    const state = store.getDealState(db, projectRef, pinned.userId, row.transaction_id);

    const eligible =
      deal !== null &&
      deal.user_id === pinned.userId &&
      (deal.status === null || deal.status !== "rejected") &&
      (deal.detection_status === null || (deal.detection_status !== "pending" && deal.detection_status !== "rejected"));

    if (deal !== null && deal.user_id !== pinned.userId) {
      // Another user's deal on this database: left for that user's pass.
      return "kept";
    }

    if (!eligible) {
      // Gone locally or no longer eligible: delete the online copy if this database uploaded it.
      if (state?.cloud_id) {
        this.guard(pinned);
        const res = await this.deps.client.deleteDeal(pinned.userId, state.cloud_id);
        this.stopOn(res);
        const gone = res.kind === "ok" || (res.kind === "refused" && res.code === "not_found");
        if (!gone) return this.recordFailure(db, row, res);
        store.forgetDealDeletedOnline(db, projectRef, pinned.userId, row.transaction_id, row.generation);
        if (res.kind === "ok") this.sentThisPass++;
        return "done";
      }
      if (deal === null && store.anyDealStateForOtherOwner(db, projectRef, pinned.userId, row.transaction_id)) return "kept";
      store.clearMarkIfGeneration(db, row.transaction_id, row.generation);
      return "done";
    }

    const projected = projectDeal(deal as unknown as DealRow, installId);
    let cloudId = state?.cloud_id ?? null;
    let cloudVersion = state?.cloud_version ?? null;
    const unchanged =
      state !== null &&
      cloudId !== null &&
      state.removed === 0 &&
      state.content_hash === projected.hash &&
      state.hash_version === HASH_VERSION;

    if (!unchanged) {
      const saved = await this.upsertHeader(db, pinned, row, projected);
      if (saved.kind !== "saved") return saved.result;
      cloudId = saved.cloudId;
      cloudVersion = saved.version;
    }

    if (state?.last_status === "synced" && unchanged) {
      store.clearMarkIfGeneration(db, row.transaction_id, row.generation);
      return "done";
    }

    // R3: every call of this deal's pass was accepted (header only until PR-3).
    for (let attempt = 0; attempt < 2; attempt++) {
      this.guard(pinned);
      const res = await this.deps.client.markDealSynced(pinned.userId, installId, cloudId as string);
      this.stopOn(res);
      if (res.kind === "ok") {
        this.sentThisPass++;
        store.recordDealSynced(
          db,
          projectRef,
          pinned.userId,
          row.transaction_id,
          row.generation,
          { cloudId: cloudId as string, hash: projected.hash, hashVersion: HASH_VERSION, cloudVersion },
          this.now(),
        );
        return "done";
      }
      if (res.kind === "refused" && res.code === "not_found" && attempt === 0) {
        // R3b: deleted online by another computer: forget it and save the header again.
        store.deleteDealState(db, projectRef, pinned.userId, row.transaction_id);
        const again = await this.upsertHeader(db, pinned, row, projected);
        if (again.kind !== "saved") return again.result;
        cloudId = again.cloudId;
        cloudVersion = again.version;
        continue;
      }
      return this.recordFailure(db, row, res);
    }
    return "failed";
  }

  private async upsertHeader(
    db: SqlDb,
    pinned: SessionUser,
    row: store.DirtyRow,
    projected: ReturnType<typeof projectDeal>,
  ): Promise<{ kind: "saved"; cloudId: string; version: number | null } | { kind: "not_saved"; result: DealResult }> {
    this.guard(pinned);
    const res = await this.deps.client.upsertDeal(pinned.userId, projected.payload);
    this.stopOn(res);
    if (res.kind !== "ok") return { kind: "not_saved", result: this.recordFailure(db, row, res) };
    const results = Array.isArray(res.body.results) ? (res.body.results as unknown[]) : [];
    const r = (results[0] && typeof results[0] === "object" ? results[0] : {}) as Record<string, unknown>;
    const status = typeof r.status === "string" ? r.status : "";
    const saved =
      (SAVED_ROW_STATUSES as readonly string[]).includes(status) &&
      r.content_hash === projected.hash &&
      typeof r.cloud_id === "string" &&
      r.local_id === projected.localId;
    if (!saved) {
      // Rejected, conflict, an unknown status or a mismatched hash: not saved (R2, tolerance).
      store.recordNonRetryableFailure(db, row, status ? `status_${status}`.slice(0, 64) : "status_missing");
      this.log.warn("[CloudSync] Deal not saved", { code: status || "status_missing", deal: shortId(row.transaction_id) });
      return { kind: "not_saved", result: "failed" };
    }
    const cloudId = r.cloud_id as string;
    const version = typeof r.version === "number" ? r.version : null;
    store.writeDealState(
      db,
      this.deps.projectRef,
      pinned.userId,
      row.transaction_id,
      { cloudId, hash: projected.hash, hashVersion: HASH_VERSION, cloudVersion: version, status: "saved" },
      this.now(),
    );
    return { kind: "saved", cloudId, version };
  }
}
