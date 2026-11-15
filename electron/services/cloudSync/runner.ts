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
import { HASH_VERSION, projectDeal, type ChildKind, type DealRow, type ProjectedChild } from "./projection";
import {
  batches,
  CHILD_KINDS,
  hasChildWork,
  MAX_TOMBSTONES_PER_CALL,
  planChildren,
  projectChildren,
  type ChildPlan,
  type ChildTombstone,
} from "./children";
import { parseState, type ServerState } from "./stateReader";
import type { SessionIdentity, SessionUser } from "./session";
import type { SqlDb } from "../db/cloudSyncSqlDb";
import * as store from "../db/cloudSyncDbService";

export const SAVED_ROW_STATUSES = ["applied", "unchanged"] as const;

export const ONLINE_KINDS = ["deal", "party", "checklist", "checklist_item"] as const;
export type OnlineKind = (typeof ONLINE_KINDS)[number];
export interface OnlineRow {
  cloudId: string;
  cloudDealId: string | null;
  contentHash: string | null;
  removed: boolean;
}
export interface ReconcileSummary {
  /** Online deals of this install with no local record of uploading them (shown, never auto-deleted). */
  orphanDeals: number;
  deletesDeferred: number;
  marked: number;
}
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_RETRY_MS = 15 * 60 * 1000;
export const RECONCILE_PAGE_SIZE = 1000;
export const RECONCILE_MAX_PAGES = 1000;
export const RECONCILE_MIN_DELETE_CAP = 10;
export const RECONCILE_DELETE_SHARE = 0.1;
/** SQLSTATE class 23 (integrity constraint violation). */
export const INTEGRITY_SQLSTATE = /^23[0-9A-Z]{3}$/;
/** A tombstone answer that means the row is gone online. */
export const TOMBSTONE_DONE_STATUSES = ["removed", "unchanged", "not_found"] as const;
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
  /** Reconcile guards (plan §8.5 step 4). */
  launchFacts?: () => { installCreatedThisLaunch: boolean; restoredThisLaunch: boolean };
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

  /** Runs fn with the pass lock held: never at the same time as a pass (R5). */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.whenIdle();
    let release: () => void = () => undefined;
    this.running = new Promise<PassSummary>((r) => (release = () => r({ outcome: "done", done: 0, failed: 0 })));
    // A stop meant for an earlier pass does not apply to this action.
    this.stopRequested = false;
    try {
      return await fn();
    } finally {
      this.running = null;
      release();
      // A pass that was triggered while the lock was held runs now.
      if (this.queued) {
        this.queued = false;
        void this.runPass().catch(() => undefined);
      }
    }
  }

  /**
   * The user's "Delete them" for online deals of this install that this
   * database has no record of uploading. Lists them again, deletes each, and
   * records the new count. Pinned to the user, under the pass lock.
   */
  deleteOrphans(userId: string, installId: string): Promise<{ ok: boolean; code: string }> {
    return this.exclusive(async () => {
      const session = await this.deps.identity.current();
      if (!session || session.userId !== userId || this.deps.getAuthUserId() !== userId) return { ok: false, code: "signed_out" };
      const pinned: SessionUser = { userId, epoch: session.epoch };
      const db = this.deps.db();
      try {
        const deals = await this.listOnline(pinned, installId, "deal");
        if (!deals) return { ok: false, code: "unknown" };
        const recorded = new Set(
          store.readUserState(db, this.deps.projectRef, userId).filter((s) => s.entity === "deal" && s.cloud_id).map((s) => s.cloud_id),
        );
        // Read again at click time: a deal on this computer is never deleted from here.
        const here = store.readEligibleDealIds(db, userId);
        for (const [localId, on] of deals) {
          if (recorded.has(on.cloudId) || here.has(localId)) continue;
          this.guard(pinned);
          const res = await this.deps.client.deleteDeal(userId, on.cloudId);
          this.stopOn(res);
          if (!(res.kind === "ok" || (res.kind === "refused" && res.code === "not_found"))) return { ok: false, code: res.code };
        }
        store.setOrphanCount(db, this.deps.projectRef, userId, 0);
        return { ok: true, code: "" };
      } catch (error) {
        if (error instanceof StopPass) return { ok: false, code: error.outcome };
        throw error;
      }
    });
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

    store.preparePass(db, deps.projectRef, pinned.userId, state.acceptedAt, this.log);

    let done = 0;
    let failed = 0;
    try {
      if (this.reconcileDue(db, pinned.userId)) await this.reconcile(db, pinned, installId);
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
    if (res.kind === "transport" && INTEGRITY_SQLSTATE.test(res.code)) {
      // D-2: an integrity violation (SQLSTATE class 23) will not pass on retry: parked until the deal changes.
      store.recordNonRetryableFailure(db, row, res.code);
      this.log.warn("[CloudSync] Deal not saved", { code: res.code, deal: shortId(row.transaction_id) });
    } else if (res.kind === "transport") {
      store.recordRetryableFailure(db, row, res.code, this.now());
      this.log.warn("[CloudSync] Deal not saved (will retry)", { code: res.code, deal: shortId(row.transaction_id) });
    } else if (res.kind === "refused") {
      store.recordNonRetryableFailure(db, row, res.code);
      this.log.warn("[CloudSync] Deal not saved", { code: res.code, deal: shortId(row.transaction_id) });
    }
    return "failed";
  }

  // One local write each: the pass records every server answer in its own
  // transaction, and these are separated by awaited calls by design.
  private clearMark(db: SqlDb, row: store.DirtyRow): void {
    store.clearMarkIfGeneration(db, row.transaction_id, row.generation);
  }
  private park(db: SqlDb, row: store.DirtyRow, code: string): void {
    store.recordNonRetryableFailure(db, row, code);
  }
  private forgetDeal(db: SqlDb, userId: string, transactionId: string): void {
    store.deleteDealState(db, this.deps.projectRef, userId, transactionId);
  }
  private recordSynced(...a: Parameters<typeof store.recordDealSynced>): void {
    store.recordDealSynced(...a);
  }
  private forgetDeleted(...a: Parameters<typeof store.forgetDealDeletedOnline>): void {
    store.forgetDealDeletedOnline(...a);
  }
  private recordRemoved(...a: Parameters<typeof store.recordChildrenRemoved>): void {
    store.recordChildrenRemoved(...a);
  }
  private recordSaved(...a: Parameters<typeof store.recordChildrenSaved>): void {
    store.recordChildrenSaved(...a);
  }
  private forgetHashes(...a: Parameters<typeof store.forgetChildHashes>): void {
    store.forgetChildHashes(...a);
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
        this.forgetDeleted(db, projectRef, pinned.userId, row.transaction_id, row.generation);
        if (res.kind === "ok") this.sentThisPass++;
        return "done";
      }
      if (deal === null && store.anyDealStateForOtherOwner(db, projectRef, pinned.userId, row.transaction_id)) return "kept";
      this.clearMark(db, row);
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
    const plan = this.planDealChildren(db, pinned.userId, row.transaction_id);

    // The shortcut: nothing to send for the header or any child, and the server confirmed it all.
    if (state?.last_status === "synced" && unchanged && !hasChildWork(plan)) {
      this.clearMark(db, row);
      return "done";
    }

    if (!unchanged) {
      const saved = await this.upsertHeader(db, pinned, row, projected);
      if (saved.kind !== "saved") return saved.result;
      cloudId = saved.cloudId;
      cloudVersion = saved.version;
    }

    // R3: the mark call is last, after the header and every child call of this pass was accepted.
    let currentPlan = plan;
    for (let attempt = 0; attempt < 2; attempt++) {
      const children = await this.syncChildren(db, pinned, installId, row, cloudId as string, currentPlan);
      let notFound = children.kind === "not_found";
      if (children.kind === "failed") return children.result;
      if (!notFound) {
        this.guard(pinned);
        const res = await this.deps.client.markDealSynced(pinned.userId, installId, cloudId as string);
        this.stopOn(res);
        if (res.kind === "ok") {
          this.sentThisPass++;
          this.recordSynced(
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
        notFound = res.kind === "refused" && res.code === "not_found";
        if (!notFound) return this.recordFailure(db, row, res);
      }
      if (attempt > 0) break;
      // R3b: deleted online by another computer: forget this deal's records, save the header and children again.
      this.forgetDeal(db, pinned.userId, row.transaction_id);
      const again = await this.upsertHeader(db, pinned, row, projected);
      if (again.kind !== "saved") return again.result;
      cloudId = again.cloudId;
      cloudVersion = again.version;
      currentPlan = this.planDealChildren(db, pinned.userId, row.transaction_id);
    }
    this.park(db, row, "not_found");
    return "failed";
  }

  // ================================================================ reconcile (plan §8.5)

  private reconcileRetryAfter = 0;

  private reconcileDue(db: SqlDb, userId: string): boolean {
    if (this.now().getTime() < this.reconcileRetryAfter) return false;
    const last = store.lastReconcile(db, this.deps.projectRef, userId).at;
    if (!last) return true;
    const t = Date.parse(last);
    return !Number.isFinite(t) || this.now().getTime() - t >= RECONCILE_INTERVAL_MS;
  }

  /** Every online row of one kind for this install, through cloud_list_install_rows; null on any failure. */
  async listOnline(pinned: SessionUser, installId: string, kind: OnlineKind): Promise<Map<string, OnlineRow> | null> {
    const out = new Map<string, OnlineRow>();
    let after: string | null = null;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      this.guard(pinned);
      const res = await this.deps.client.listInstallRows(pinned.userId, installId, kind, after, RECONCILE_PAGE_SIZE);
      this.stopOn(res);
      if (res.kind !== "ok") {
        this.log.warn("[CloudSync] Reconcile read failed", { code: res.code, kind });
        return null;
      }
      for (const r of Array.isArray(res.body.rows) ? (res.body.rows as Array<Record<string, unknown>>) : []) {
        if (!r || typeof r !== "object" || typeof r.cloud_id !== "string" || typeof r.local_id !== "string") continue;
        // A moved child has a removed row on the old deal and a live one on the new: keep the live one.
        if (r.removed === true && out.get(r.local_id)?.removed === false) continue;
        out.set(r.local_id, {
          cloudId: r.cloud_id,
          cloudDealId: typeof r.cloud_deal_id === "string" ? r.cloud_deal_id : null,
          contentHash: typeof r.content_hash === "string" ? r.content_hash : null,
          removed: r.removed === true,
        });
      }
      after = typeof res.body.next_after === "string" ? res.body.next_after : null;
      if (!after) return out;
    }
    this.log.warn("[CloudSync] Reconcile read stopped at the page limit", { kind });
    return null;
  }

  /**
   * Compares this install's online rows with this database's records and the
   * local rows, then, in ONE local transaction: forgets recorded hashes that no
   * longer match what is online (marking alone would be cleared by the
   * unchanged-hash shortcut), marks the deals to revisit, un-parks parked marks
   * and records the run. It makes no server write itself: the pass that follows
   * sends, deletes and tombstones through its usual paths. An online deal with
   * no local record is never deleted here; it is counted for Settings.
   */
  async reconcile(db: SqlDb, pinned: SessionUser, installId: string): Promise<ReconcileSummary | null> {
    const online: Partial<Record<OnlineKind, Map<string, OnlineRow>>> = {};
    for (const kind of ONLINE_KINDS) {
      const rows = await this.listOnline(pinned, installId, kind);
      if (!rows) {
        this.reconcileRetryAfter = this.now().getTime() + RECONCILE_RETRY_MS;
        return null;
      }
      online[kind] = rows;
    }
    const { projectRef } = this.deps;
    const eligible = store.readEligibleDealIds(db, pinned.userId);
    const states = store.readUserState(db, projectRef, pinned.userId);
    const onlineDeals = online.deal as Map<string, OnlineRow>;
    const nullHashes: Array<{ entity: string; localId: string }> = [];
    const mark = new Set<string>();
    const deleteCandidates: string[] = [];
    const recordedDealCloudIds = new Set<string>();
    const dealsWithState = new Set<string>();

    for (const st of states) {
      if (st.entity !== "deal") continue;
      dealsWithState.add(st.local_id);
      if (st.cloud_id) recordedDealCloudIds.add(st.cloud_id);
      const on = onlineDeals.get(st.local_id);
      if (eligible.has(st.local_id)) {
        if (!on || on.cloudId !== st.cloud_id) {
          // Gone online: forget the deal and every child record of it, then send it all again.
          nullHashes.push({ entity: "deal", localId: st.local_id });
          for (const c of states) if (c.entity !== "deal" && c.transaction_id === st.local_id) nullHashes.push({ entity: c.entity, localId: c.local_id });
          mark.add(st.local_id);
        } else if (on.contentHash !== st.content_hash) {
          nullHashes.push({ entity: "deal", localId: st.local_id });
          mark.add(st.local_id);
        }
      } else if (on && on.cloudId === st.cloud_id) {
        deleteCandidates.push(st.local_id);
      } else {
        // Gone locally and online: the pass forgets the record (delete answers not_found).
        mark.add(st.local_id);
      }
    }
    for (const id of eligible) if (!dealsWithState.has(id)) mark.add(id);

    for (const st of states) {
      if (st.entity === "deal" || st.removed !== 0 || !st.cloud_id) continue;
      const on = (online[st.entity as OnlineKind] as Map<string, OnlineRow> | undefined)?.get(st.local_id);
      if (!on || on.cloudId !== st.cloud_id || on.removed || on.contentHash !== st.content_hash) {
        nullHashes.push({ entity: st.entity, localId: st.local_id });
        if (eligible.has(st.transaction_id)) mark.add(st.transaction_id);
      }
    }
    for (const id of store.readDealsWithUnsentChildren(db, projectRef, pinned.userId)) mark.add(id);

    // Deletes only for rows this database recorded uploading, with the plan's guards and cap.
    const facts = this.deps.launchFacts?.() ?? { installCreatedThisLaunch: false, restoredThisLaunch: false };
    const deleteAllowed =
      !facts.installCreatedThisLaunch && !facts.restoredThisLaunch && (eligible.size > 0 || onlineDeals.size === 0);
    const cap = Math.max(RECONCILE_MIN_DELETE_CAP, Math.ceil(onlineDeals.size * RECONCILE_DELETE_SHARE));
    const toDelete = deleteAllowed ? deleteCandidates.slice(0, cap) : [];
    for (const id of toDelete) mark.add(id);
    if (deleteCandidates.length > toDelete.length) {
      this.log.warn("[CloudSync] Reconcile deletes deferred", { deferred: deleteCandidates.length - toDelete.length });
    }

    let orphanDeals = 0;
    // An online deal of this install with no local record:
    // - its deal is on this computer and eligible (a first upload that crashed before the local
    //   record): ADOPT it. The server keys a deal by (owner, install, local id), so the next
    //   upsert returns this same cloud id.
    // - otherwise: counted for Settings, never deleted here.
    const adopt: Array<{ localId: string; cloudId: string }> = [];
    for (const [localId, on] of onlineDeals) {
      if (recordedDealCloudIds.has(on.cloudId)) continue;
      if (eligible.has(localId)) {
        if (!dealsWithState.has(localId)) {
          adopt.push({ localId, cloudId: on.cloudId });
          mark.add(localId);
        }
        continue;
      }
      orphanDeals++;
    }

    const summary: ReconcileSummary = {
      orphanDeals,
      deletesDeferred: deleteCandidates.length - toDelete.length,
      marked: mark.size,
    };
    store.applyReconcile(
      db,
      projectRef,
      pinned.userId,
      { nullHashes, markDeals: [...mark], adoptDeals: adopt, summaryJson: JSON.stringify(summary) },
      this.now(),
    );
    return summary;
  }

  private planDealChildren(db: SqlDb, userId: string, transactionId: string): ChildPlan {
    const { projectRef } = this.deps;
    const projectedChildren = projectChildren(store.readDealChildren(db, transactionId));
    return planChildren(
      transactionId,
      projectedChildren,
      store.getChildStatesOfDeal(db, projectRef, userId, transactionId),
      (kind, localId) => store.getChildState(db, projectRef, userId, kind, localId),
    );
  }

  /**
   * Sends one deal's children: tombstones of rows that moved away, then people,
   * checklists, items (checklists before items), then tombstones of rows gone
   * locally (items, checklists, people). Each response's accepted rows are
   * recorded in one transaction. Any rejected, missing or unknown row leaves the
   * deal not saved (parked) and no mark call is made (R3).
   */
  private async syncChildren(
    db: SqlDb,
    pinned: SessionUser,
    installId: string,
    row: store.DirtyRow,
    cloudDealId: string,
    plan: ChildPlan,
  ): Promise<{ kind: "ok" } | { kind: "not_found" } | { kind: "failed"; result: DealResult }> {
    const { projectRef } = this.deps;
    let allAccepted = true;

    const tombstone = async (list: ChildTombstone[]): Promise<"ok" | DealResult> => {
      for (const kind of [...new Set(list.map((t) => t.kind))]) {
        const ofKind = list.filter((t) => t.kind === kind);
        for (let i = 0; i < ofKind.length; i += MAX_TOMBSTONES_PER_CALL) {
          const chunk = ofKind.slice(i, i + MAX_TOMBSTONES_PER_CALL);
          this.guard(pinned);
          const res = await this.deps.client.tombstone(pinned.userId, installId, kind, chunk.map((t) => t.cloudId));
          this.stopOn(res);
          if (res.kind !== "ok") return this.recordFailure(db, row, res);
          const byCloud = new Map<string, Record<string, unknown>>();
          for (const r of Array.isArray(res.body.results) ? (res.body.results as Array<Record<string, unknown>>) : []) {
            if (r && typeof r === "object" && typeof r.cloud_id === "string") byCloud.set(r.cloud_id, r);
          }
          const gone: string[] = [];
          for (const t of chunk) {
            const st = byCloud.get(t.cloudId)?.status;
            if (typeof st === "string" && (TOMBSTONE_DONE_STATUSES as readonly string[]).includes(st)) gone.push(t.localId);
            else allAccepted = false;
          }
          if (gone.length > 0) {
            this.recordRemoved(db, projectRef, pinned.userId, kind, gone, this.now());
            this.sentThisPass++;
          }
        }
      }
      return "ok";
    };

    const upsert = async (kind: ChildKind, rows: ProjectedChild[]): Promise<{ parentMissing: ProjectedChild[] } | "not_found" | DealResult> => {
      const parentMissing: ProjectedChild[] = [];
      for (const batch of batches(rows)) {
        this.guard(pinned);
        const res = await this.deps.client.upsertChildren(kind, pinned.userId, installId, cloudDealId, batch.map((b) => b.payload));
        this.stopOn(res);
        if (res.kind === "refused" && res.code === "not_found") return "not_found";
        if (res.kind !== "ok") return this.recordFailure(db, row, res);
        const byLocal = new Map<string, Record<string, unknown>>();
        for (const r of Array.isArray(res.body.results) ? (res.body.results as Array<Record<string, unknown>>) : []) {
          if (r && typeof r === "object" && typeof r.local_id === "string") byLocal.set(r.local_id, r);
        }
        const accepted: store.AcceptedChild[] = [];
        for (const sent of batch) {
          const r = byLocal.get(sent.localId);
          const status = typeof r?.status === "string" ? r.status : "";
          if (
            r &&
            (SAVED_ROW_STATUSES as readonly string[]).includes(status) &&
            r.content_hash === sent.hash &&
            typeof r.cloud_id === "string"
          ) {
            accepted.push({ localId: sent.localId, cloudId: r.cloud_id, hash: sent.hash, version: typeof r.version === "number" ? r.version : null });
          } else if (kind === "checklist_item" && status === "rejected" && r?.reason === "parent_missing") {
            parentMissing.push(sent);
          } else {
            allAccepted = false;
            this.log.warn("[CloudSync] Row not saved", { kind, code: status || "missing", deal: shortId(row.transaction_id) });
          }
        }
        if (accepted.length > 0) {
          this.recordSaved(db, projectRef, pinned.userId, kind, row.transaction_id, cloudDealId, accepted, HASH_VERSION, this.now());
          this.sentThisPass++;
        }
      }
      return { parentMissing };
    };

    const moved = await tombstone(plan.moved);
    if (moved !== "ok") return { kind: "failed", result: moved };
    for (const kind of CHILD_KINDS) {
      const r = await upsert(kind, plan.send[kind]);
      if (r === "not_found") return { kind: "not_found" };
      if (typeof r === "string") return { kind: "failed", result: r };
      if (kind === "checklist_item" && r.parentMissing.length > 0) {
        // §8.4b: a missing parent is repaired once by sending the parent checklist again.
        const parentIds = [...new Set(r.parentMissing.map((p) => String(p.payload.local_checklist_id)))];
        this.forgetHashes(db, projectRef, pinned.userId, "checklist", parentIds);
        const parents = this.planDealChildren(db, pinned.userId, row.transaction_id).send.checklist.filter((c) =>
          parentIds.includes(c.localId),
        );
        const p1 = await upsert("checklist", parents);
        if (p1 === "not_found") return { kind: "not_found" };
        if (typeof p1 === "string") return { kind: "failed", result: p1 };
        const again = await upsert("checklist_item", r.parentMissing);
        if (again === "not_found") return { kind: "not_found" };
        if (typeof again === "string") return { kind: "failed", result: again };
        if (again.parentMissing.length > 0) allAccepted = false;
      }
    }
    const order: ChildKind[] = ["checklist_item", "checklist", "party"];
    const removed = await tombstone(order.flatMap((k) => plan.tombstone.filter((t) => t.kind === k)));
    if (removed !== "ok") return { kind: "failed", result: removed };

    if (!allAccepted) {
      this.park(db, row, "row_not_saved");
      return { kind: "failed", result: "failed" };
    }
    return { kind: "ok" };
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
