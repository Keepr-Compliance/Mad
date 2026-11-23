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
import { otherComputerActive, parseState, type ServerState } from "./stateReader";
import type { SessionIdentity, SessionUser } from "./session";
import type { SqlDb } from "../db/cloudSyncSqlDb";
import * as store from "../db/cloudSyncDbService";
import * as todoStore from "../db/cloudSyncTodoDbService";
import * as archive from "../db/cloudSyncDealArchive";
import { sendTodos, type TodoSendSummary } from "./todos/sender";
import { pullTodos, type TodoPullSummary } from "./todos/puller";

export const SAVED_ROW_STATUSES = ["applied", "unchanged"] as const;

/**
 * Kinds the daily reconcile lists and compares. Checklists and items are not here (BACKLOG-4263 PR-4a):
 * they are sent as todo changes, and the reconcile never re-sends them (plan W3).
 */
export const ONLINE_KINDS = ["deal", "party"] as const;
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
  /**
   * BACKLOG-4263 PR-6: of those, the ones the owner restored online (Settings "Online only"): their latest deal
   * history row is `restored` by `cloud_user`. Not in orphanDeals; never deleted by "Delete them".
   */
  restoredOnlineOnly?: number;
  /** PR-6: their online ids (at most RESTORED_CHECK_CAP), so "Delete them" spends no check on them again. */
  restoredOnlineIds?: string[];
  deletesDeferred: number;
  marked: number;
}
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** BACKLOG-4263 PR-6: at most this many deal history reads per "restored online" check. */
export const RESTORED_CHECK_CAP = 20;
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
  | "stopped"
  /** BACKLOG-4263 PR-4b: this computer's online copy was removed elsewhere; nothing is sent until reclaimed. */
  | "install_removed"
  /**
   * BACKLOG-4263 P2: another computer is the account's active one (state answer), or the server refused a write or
   * a claim with computer_not_active. Nothing is sent and nothing local is cleared; the next pass reads the state
   * again. Not stored in any column.
   */
  | "other_computer";

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
  /**
   * BACKLOG-4263 PR-4c: records a deal restore's TRANSACTION_CREATE audit entry inside the restore's transaction
   * (throws to cancel it). Without it no restore runs: a restore is never left unaudited.
   */
  auditRestore?: (entry: { userId: string; transactionId: string; archivedAt: string; via: "computer" | "online" }) => void;
}

/** BACKLOG-4263 PR-4c (Q8): where one "Delete for good" stands after a try. */
export type DealPurgeStatus =
  /** Erased online and here. */
  | "done"
  /** Still owed: offline, a failed call, or this computer's own removal not yet sent; retried every pass. */
  | "pending"
  /** The online copy was restored elsewhere: nothing was erased, the owed mark is cleared. */
  | "restored_elsewhere";

export interface PassSummary {
  outcome: PassOutcome;
  done: number;
  failed: number;
  state?: ServerState;
  /** BACKLOG-4263 PR-4a: what the todo sender did in this pass. */
  todos?: TodoSendSummary;
  /** BACKLOG-4263 PR-4b: what the todo puller did, and the sender's second run after a full pull's scan. */
  pull?: TodoPullSummary;
  todosAfterPull?: TodoSendSummary;
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
  /** BACKLOG-4263 PR-4b: the user the running pass is pinned to (for the install_removed stop). */
  private passUser: string | null = null;
  /** BACKLOG-4263 PR-4b (D2): users whose install_removed stop was checked online this launch (once each). */
  private readonly installStatusChecked = new Set<string>();
  /**
   * BACKLOG-4263 P2: whether the last state answer carried `switches` (a server with migration 20261123100000);
   * null before any state read this launch. Decides whether a turn-off sends this computer's install id.
   */
  private serverHasOneComputer: boolean | null = null;
  /**
   * BACKLOG-4263 P2: users whose owed turn-off was dropped this launch because another computer became active (for
   * the screen's line). In memory only; cleared when Keepr Cloud is turned on or moved here again.
   */
  readonly turnOffDropped = new Set<string>();

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
        const candidates = [...deals].filter(([localId, on]) => !(on.removed || recorded.has(on.cloudId) || here.has(localId)));
        // BACKLOG-4263 PR-6: a deal the owner restored online is kept ("Online only"); one that could not be checked
        // (a failed read, or past the check cap) is kept too: never deleted without that answer. Deals the last
        // reconcile already found restored are kept without spending a check, so the checks go to the others.
        const known = new Set(store.lastRestoredOnlineIds(db, this.deps.projectRef, userId));
        const toCheck = candidates.filter(([, on]) => !known.has(on.cloudId)).map(([, on]) => on.cloudId);
        const checked = await this.restoredOnlineByOwner(pinned, toCheck);
        const restored = new Set([...checked.restored, ...candidates.map(([, on]) => on.cloudId).filter((id) => known.has(id))]);
        const unchecked = checked.unchecked;
        let kept = 0;
        for (const [, on] of candidates) {
          if (restored.has(on.cloudId) || unchecked.has(on.cloudId)) {
            kept++;
            continue;
          }
          this.guard(pinned);
          const res = await this.deps.client.deleteDeal(userId, on.cloudId);
          this.stopOn(res);
          if (!(res.kind === "ok" || (res.kind === "refused" && res.code === "not_found"))) return { ok: false, code: res.code };
        }
        store.setOrphanCount(db, this.deps.projectRef, userId, kept - restored.size, restored.size, [...restored]);
        return { ok: true, code: "" };
      } catch (error) {
        if (error instanceof StopPass) return { ok: false, code: error.outcome };
        throw error;
      }
    });
  }

  /**
   * BACKLOG-4263 PR-4b (D2): the user's "save this computer's deals again" after its online copy was removed
   * elsewhere. Removes this owner's register row (cloud_reclaim_install; other owners untouched), then, in one
   * local transaction, forgets this user's sync records and todo state, owes a full pull and marks this user's
   * deals; the next pass uploads them again under the same install id (the server un-removes them). Pinned to
   * the user, under the pass lock. Other local users are not touched.
   */
  reclaimInstall(userId: string, installId: string): Promise<{ ok: boolean; code: string }> {
    return this.exclusive(async () => {
      const session = await this.deps.identity.current();
      if (!session || session.userId !== userId || this.deps.getAuthUserId() !== userId) return { ok: false, code: "signed_out" };
      const pinned: SessionUser = { userId, epoch: session.epoch };
      try {
        this.guard(pinned);
        const res = await this.deps.client.reclaimInstall(userId, installId);
        if (res.kind === "refused" && res.code === "wrong_account") throw new StopPass("wrong_account");
        if (res.kind !== "ok") return { ok: false, code: res.code };
        store.reclaimInstallForUser(this.deps.db(), this.deps.projectRef, userId, this.now());
        this.installStatusChecked.delete(userId);
        return { ok: true, code: "" };
      } catch (error) {
        if (error instanceof StopPass) return { ok: false, code: error.outcome };
        throw error;
      }
    });
  }

  /**
   * BACKLOG-4263 P2 (plan §2.5, §13.1, §14 D1): "Use this computer instead", under the pass lock. Reads whether this
   * computer's online copy was removed (cloud_install_status, a read the rule allows; an unanswered read stops here
   * with nothing done), writes the move marker with that answer, then claims with p_replace = true, then:
   * - ok: the move's local transaction (applyMoveHere: email, text and file records and the marker go, every deal is
   *   marked; or the reclaim path for a computer whose copy had been removed), whatever the local enabled flag;
   * - refused (computer_not_active cannot happen with p_replace; busy, not_entitled, wrong_account, ...): only the
   *   marker goes;
   * - transport: the marker stays (whether the claim landed is unknown); the next pass reads the state and either
   *   runs the move's local transaction (this computer is active) or drops the marker.
   */
  moveHere(userId: string, installId: string): Promise<{ ok: boolean; code: string }> {
    return this.exclusive(async () => {
      const session = await this.deps.identity.current();
      if (!session || session.userId !== userId || this.deps.getAuthUserId() !== userId) return { ok: false, code: "signed_out" };
      const pinned: SessionUser = { userId, epoch: session.epoch };
      const db = this.deps.db();
      try {
        this.guard(pinned);
        const st = await this.deps.client.installStatus(userId, installId);
        if (st.kind === "refused" && st.code === "wrong_account") throw new StopPass("wrong_account");
        if (st.kind !== "ok" || typeof st.body.removed !== "boolean") return { ok: false, code: st.kind === "ok" ? "unknown" : st.code };
        const reclaim = st.body.removed;
        this.guard(pinned);
        store.writeMovePending(db, this.deps.projectRef, userId, this.now(), reclaim);
        const res = await this.deps.client.claimInstall(userId, installId, true);
        // Transport: the marker stays (whether the claim landed is unknown); the next pass settles it.
        if (res.kind !== "transport") store.settleMovePending(db, this.deps.projectRef, userId, res.kind === "ok", this.now(), reclaim);
        if (res.kind === "ok") {
          this.installStatusChecked.delete(userId);
          return { ok: true, code: "" };
        }
        if (res.kind === "refused" && res.code === "wrong_account") throw new StopPass("wrong_account");
        return { ok: false, code: res.code };
      } catch (error) {
        if (error instanceof StopPass) return { ok: false, code: error.outcome };
        throw error;
      }
    });
  }

  /**
   * BACKLOG-4263 PR-4c (plan §14, F5): restore one deal this user deleted on this computer, from its archive, in
   * one local transaction under the pass lock (never between a pass's calls). The next pass uploads it again,
   * which un-removes the online copy under the same id (F4).
   */
  restoreDeal(userId: string, transactionId: string): Promise<archive.RestoreResult | { ok: false; code: "signed_out" }> {
    return this.exclusive(async () => {
      const session = await this.deps.identity.current();
      if (!session || session.userId !== userId || this.deps.getAuthUserId() !== userId) return { ok: false, code: "signed_out" } as const;
      const audit = this.deps.auditRestore;
      if (!audit) return { ok: false, code: "restore_failed" } as const;
      return archive.restoreArchivedDeal(this.deps.db(), { userId, transactionId, now: this.now(), audit });
    });
  }

  /**
   * BACKLOG-4263 PR-4c (Q8, plan §14 "Delete for good"): server first, then local. Marks the row owed (one local
   * transaction; Restore is refused from then on), then tries to finish it under the pass lock. A try that cannot
   * finish leaves the mark: every later pass retries.
   */
  deleteDealForGood(userId: string, transactionId: string): Promise<{ ok: boolean; code: string; status?: DealPurgeStatus }> {
    return this.exclusive(async () => {
      const session = await this.deps.identity.current();
      if (!session || session.userId !== userId || this.deps.getAuthUserId() !== userId) return { ok: false, code: "signed_out" };
      const pinned: SessionUser = { userId, epoch: session.epoch };
      const db = this.deps.db();
      const marked = archive.markDealPurgeOwed(db, userId, transactionId, this.now());
      if (marked !== "ok") return { ok: false, code: marked };
      try {
        const status = await this.finishOwedPurges(db, pinned, this.deps.installId(), transactionId);
        return { ok: true, code: "", status: status.get(transactionId) ?? "pending" };
      } catch (error) {
        if (error instanceof StopPass) return { ok: true, code: error.outcome, status: "pending" };
        throw error;
      }
    });
  }

  /**
   * Tries every owed Delete for good of the pinned user (or one deal). Per row:
   * - this computer's own removal of the deal still waiting (a dirty mark): left for the deal step;
   * - the online deal id: the archive's, else this user's sync record, else this install's online rows by local
   *   id (a deal deleted before its first upload was recorded); none online at all: only the local row goes;
   * - a live online copy this computer has not removed (no confirmed removal recorded: found by that lookup, or a
   *   sync record forgotten before the removal was sent) is removed first, then purged;
   * - purged / not_found: the row goes; not_removed after a confirmed removal: restored elsewhere, the mark is
   *   cleared; anything else: kept.
   */
  private async finishOwedPurges(db: SqlDb, pinned: SessionUser, installId: string, only?: string): Promise<Map<string, DealPurgeStatus>> {
    const out = new Map<string, DealPurgeStatus>();
    const online: { rows?: Map<string, OnlineRow> | null } = {};
    for (const owed of archive.listOwedDealPurges(db, pinned.userId)) {
      if (only && owed.transactionId !== only) continue;
      const status = await this.tryOwedPurge(db, pinned, installId, owed, online);
      out.set(owed.transactionId, status);
      // One local write per deal, after its server step: the row goes (done) or its owed mark is cleared.
      if (status !== "pending") archive.settleDealPurge(db, pinned.userId, owed.transactionId, status);
    }
    return out;
  }

  /** The server step of one owed Delete for good (no local write; see finishOwedPurges). */
  private async tryOwedPurge(
    db: SqlDb,
    pinned: SessionUser,
    installId: string,
    owed: archive.OwedPurge,
    online: { rows?: Map<string, OnlineRow> | null },
  ): Promise<DealPurgeStatus> {
    if (store.isMarked(db, owed.transactionId)) return "pending";
    let cloudId = owed.cloudDealId ?? store.getDealState(db, this.deps.projectRef, pinned.userId, owed.transactionId)?.cloud_id ?? null;
    let removedOnline = owed.removedOnline;
    if (!cloudId) {
      if (online.rows === undefined) online.rows = await this.listOnline(pinned, installId, "deal");
      if (!online.rows) return "pending";
      const on = online.rows.get(owed.transactionId);
      // Nothing online for this deal: only the local row goes.
      if (!on) return "done";
      cloudId = on.cloudId;
      if (on.removed) removedOnline = true;
    }
    if (!removedOnline) {
      // Not removed online by this computer yet: remove it first (a removed deal answers ok again).
      this.guard(pinned);
      const del = await this.deps.client.deleteDeal(pinned.userId, cloudId);
      this.stopOn(del);
      if (!(del.kind === "ok" || (del.kind === "refused" && del.code === "not_found"))) return "pending";
    }
    this.guard(pinned);
    const res = await this.deps.client.purgeDealNow(pinned.userId, cloudId);
    this.stopOn(res);
    if (res.kind === "ok" && (res.body.status === "purged" || res.body.status === "not_found")) return "done";
    if (res.kind === "refused" && res.code === "not_removed") return "restored_elsewhere";
    this.log.warn("[CloudSync] Delete for good not finished (will retry)", { code: res.kind === "ok" ? "bad_answer" : res.code });
    return "pending";
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

    // BACKLOG-4263 PR-4b (R8, D2): a user stopped by install_removed makes no server call, except one
    // read-only status check per launch (the copy may have been restored elsewhere).
    if (todoStore.installRemovedAt(db, deps.projectRef, session.userId)) {
      if (this.installStatusChecked.has(session.userId)) return this.finish({ outcome: "install_removed", done: 0, failed: 0 });
      const st = await deps.client.installStatus(session.userId, installId);
      // Spent only on an answer: a failed call (offline, timeout) is tried again on the next pass.
      if (st.kind === "ok") this.installStatusChecked.add(session.userId);
      if (!(st.kind === "ok" && st.body.removed === false)) return this.finish({ outcome: "install_removed", done: 0, failed: 0 });
      todoStore.clearInstallRemoved(db, deps.projectRef, session.userId);
    }

    const read = parseState(await deps.client.getState());
    if (read.kind !== "state") return this.finish({ outcome: "unknown_state", done: 0, failed: 0 });
    const state = read.state;
    if (state.userId !== session.userId) return this.finish({ outcome: "identity_mismatch", done: 0, failed: 0, state });

    const pinned: SessionUser = { userId: session.userId, epoch: session.epoch };
    this.serverHasOneComputer = state.switches !== null;

    // BACKLOG-4263 P2 (plan §13.1): a move whose local transaction did not run (a crash after the claim, or the
    // claim's answer was lost). This computer is active now: run it. Anything else: the claim did not land.
    this.healMovePending(db, pinned.userId, state.activeInstallId === installId);

    // BACKLOG-4263 P2 (plan §2.5): another computer is active. Checked BEFORE the owed turn-off, which would
    // otherwise delete the active computer's online copy, and before any write or local preparation.
    const otherActive = otherComputerActive(state, installId);

    // A turn-off made offline is still owed (plan §8.8).
    if (fresh.turn_off_owed_at) {
      if (otherActive) return this.finishTurnOffDropped(pinned.userId, state);
      this.guard(pinned);
      const res = await this.settleOwedTurnOff(pinned.userId);
      if (res.kind === "refused" && res.code === "wrong_account") return this.wrongAccount(state);
      // The server's own check (a move committed after the state read): the newer choice wins here too.
      if (res.kind === "refused" && res.code === "computer_not_active") return this.finishTurnOffDropped(pinned.userId, state);
      return this.finish({ outcome: "not_enabled", done: 0, failed: 0, state });
    }

    if (otherActive) return this.finish({ outcome: "other_computer", done: 0, failed: 0, state });

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

    // BACKLOG-4263 P2 (plan §2.5): no computer is active yet on a server with the rule: claim before any write
    // (the server refuses every write until one is active). Any answer but ok ends the pass with no write.
    if (state.switches !== null && state.activeInstallId === null) {
      try {
        this.guard(pinned);
      } catch (error) {
        if (error instanceof StopPass) return this.finish({ outcome: error.outcome, done: 0, failed: 0, state });
        throw error;
      }
      const claim = await deps.client.claimInstall(pinned.userId, installId, false);
      if (claim.kind === "refused" && claim.code === "wrong_account") return this.wrongAccount(state);
      if (claim.kind === "refused" && claim.code === "computer_not_active") return this.finish({ outcome: "other_computer", done: 0, failed: 0, state });
      if (claim.kind === "refused" && (claim.code === "not_entitled" || claim.code === "not_authorized")) {
        return this.finish({ outcome: "paused", done: 0, failed: 0, state });
      }
      if (claim.kind !== "ok") return this.finish({ outcome: "unknown_state", done: 0, failed: 0, state });
    }

    store.preparePass(db, deps.projectRef, pinned.userId, state.acceptedAt, this.log, this.now());

    let done = 0;
    let failed = 0;
    let todoSummary: TodoSendSummary | undefined;
    let pullSummary: TodoPullSummary | undefined;
    let afterPull: TodoSendSummary | undefined;
    this.passUser = pinned.userId;
    try {
      if (this.reconcileDue(db, pinned.userId)) await this.reconcile(db, pinned, installId);
      const due = store.selectDueDirty(db, pinned.userId, this.now(), DEALS_PER_PASS);
      for (const row of due) {
        this.guard(pinned);
        const r = await this.processDeal(db, pinned, installId, row);
        if (r === "done") done++;
        else if (r === "failed") failed++;
      }
      // BACKLOG-4263 PR-4c (Q8): Delete for good still owed, after the deals (their removals went first).
      await this.finishOwedPurges(db, pinned, installId);
      // BACKLOG-4263 PR-4a: todo changes, after the deals (an op names its deal by cloud id).
      const todoDeps = {
        db,
        client: deps.client,
        projectRef: deps.projectRef,
        userId: pinned.userId,
        installId,
        now: () => this.now(),
        guard: () => this.guard(pinned),
        stopOn: (res: CallResult) => this.stopOn(res),
        log: this.log,
        auditRestore: deps.auditRestore,
      };
      todoSummary = await sendTodos(todoDeps);
      if (todoSummary.confirmed > 0) this.sentThisPass++;
      // BACKLOG-4263 PR-4b: push, then pull (plan W26). After a full pull its last page scanned (cloudSyncTodoPullDb):
      // what the scan queued goes in this same pass.
      if (todoSummary.outcome === "done" || todoSummary.outcome === "idle") {
        pullSummary = await pullTodos(todoDeps);
        if (pullSummary.scanned > 0 || pullSummary.held > 0) {
          afterPull = await sendTodos(todoDeps);
          if (afterPull.confirmed > 0) this.sentThisPass++;
        }
      }
    } catch (error) {
      if (error instanceof StopPass) {
        if (error.outcome === "wrong_account") return this.wrongAccount(state, done, failed);
        return this.finish({ outcome: error.outcome, done, failed, state, todos: todoSummary, pull: pullSummary });
      }
      throw error;
    } finally {
      this.passUser = null;
    }
    return this.finish({ outcome: "done", done, failed, state, todos: todoSummary, pull: pullSummary, todosAfterPull: afterPull });
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
    // BACKLOG-4263 P2 (plan §11.2): always this computer's install id, unless the last state answer showed a server
    // without the one-computer migration (then the 3-argument call that server has).
    const installId = this.serverHasOneComputer === false ? undefined : this.deps.installId();
    const res = await this.deps.client.setAutosave(userId, false, null, installId);
    if (res.kind === "ok") store.clearTurnOffOwed(this.deps.db(), this.deps.projectRef, userId);
    return res;
  }

  /** BACKLOG-4263 P2 (plan §13.1): settles a move marker left by a crash or a lost claim answer, if there is one. */
  private healMovePending(db: SqlDb, userId: string, activeHere: boolean): void {
    const pendingMove = store.movePending(db, this.deps.projectRef, userId);
    if (pendingMove) store.settleMovePending(db, this.deps.projectRef, userId, activeHere, this.now(), pendingMove.reclaim);
  }

  /**
   * BACKLOG-4263 P2 (plan §2.5): another computer became active before this computer's offline turn-off reached the
   * server. The newer choice (the move) wins: the owed turn-off is dropped here, nothing online is deleted, and
   * this computer stays off.
   */
  private finishTurnOffDropped(userId: string, state: ServerState): PassSummary {
    store.dropOwedTurnOff(this.deps.db(), this.deps.projectRef, userId);
    this.turnOffDropped.add(userId);
    this.log.warn("[CloudSync] Turn-off dropped: another computer is active", {});
    return this.finish({ outcome: "other_computer", done: 0, failed: 0, state });
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
    // BACKLOG-4263 P2: another computer became active during this pass (the writers' gate). Before any per-deal
    // failure is recorded, so no deal is parked for it; nothing else is sent this pass.
    if (res.code === "computer_not_active") throw new StopPass("other_computer");
    if (res.code === "install_removed") {
      // BACKLOG-4263 PR-4b (R8, D2): persisted per user, beside wrong_account; nothing else is sent this pass,
      // and later passes make no call until the status check or the user's reclaim clears it.
      if (this.passUser) todoStore.recordInstallRemoved(this.deps.db(), this.deps.projectRef, this.passUser, this.now());
      this.log.warn("[CloudSync] Pass stopped: this computer's online copy was removed", { code: res.code });
      throw new StopPass("install_removed");
    }
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
    db.transaction(() => {
      store.deleteDealState(db, this.deps.projectRef, userId, transactionId);
      // BACKLOG-4263 PR-4a: the cloud lost this deal; its todos are scanned again against an empty shadow.
      todoStore.resetTodoDeal(db, this.deps.projectRef, userId, transactionId, this.now());
    })();
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
        this.forgetDeleted(db, projectRef, pinned.userId, row.transaction_id, row.generation, this.now());
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
      // BACKLOG-4263 PR-4c: an ok answer without its rows is not "nothing online" (Delete for good would erase the
      // local copy on it; the reconcile would read every deal as gone online).
      if (!Array.isArray(res.body.rows)) {
        this.log.warn("[CloudSync] Reconcile read failed", { code: "no_rows", kind });
        return null;
      }
      for (const r of res.body.rows as Array<Record<string, unknown>>) {
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
   * BACKLOG-4263 PR-6: which of these online deals the owner restored online. Read through `cloud_todo_history`
   * (`entity = 'deal'`, limit 1): restored when the latest row has `outcome = 'restored'` and `actor_kind =
   * 'cloud_user'` (`_cloud_todo_unremove_deal`, migration 20261118110000 :507, as cloud_todo_restore's actor). At most
   * RESTORED_CHECK_CAP calls; the rest, and any id whose read fails, are `unchecked` (callers never delete those).
   */
  async restoredOnlineByOwner(pinned: SessionUser, cloudIds: string[]): Promise<{ restored: Set<string>; unchecked: Set<string> }> {
    const restored = new Set<string>();
    const unchecked = new Set<string>();
    for (const [i, id] of cloudIds.entries()) {
      if (i >= RESTORED_CHECK_CAP) {
        unchecked.add(id);
        continue;
      }
      this.guard(pinned);
      const res = await this.deps.client.todoHistory(pinned.userId, "deal", id, 1);
      if (res.kind !== "ok" || !Array.isArray(res.body.rows)) {
        unchecked.add(id);
        continue;
      }
      const top = (res.body.rows as Array<Record<string, unknown>>)[0];
      if (top && top.outcome === "restored" && top.actor_kind === "cloud_user") restored.add(id);
    }
    return { restored, unchecked };
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
    const todoResetDeals: string[] = [];

    for (const st of states) {
      if (st.entity !== "deal") continue;
      dealsWithState.add(st.local_id);
      if (st.cloud_id) recordedDealCloudIds.add(st.cloud_id);
      const on = onlineDeals.get(st.local_id);
      if (eligible.has(st.local_id)) {
        if (on && on.cloudId === st.cloud_id && on.removed) {
          // BACKLOG-4263 PR-4b: removed online but eligible here: uploaded again, which un-removes it under the
          // same id with its todos (restore by becoming eligible again, plan §2.6).
          nullHashes.push({ entity: "deal", localId: st.local_id });
          mark.add(st.local_id);
        } else if (!on || on.cloudId !== st.cloud_id) {
          // Gone online: forget the deal and every child record of it, then send it all again.
          todoResetDeals.push(st.local_id);
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
      if (!(ONLINE_KINDS as readonly string[]).includes(st.entity)) continue;
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
    const orphanCloudIds: string[] = [];
    // An online deal of this install with no local record:
    // - its deal is on this computer and eligible (a first upload that crashed before the local
    //   record): ADOPT it. The server keys a deal by (owner, install, local id), so the next
    //   upsert returns this same cloud id.
    // - otherwise: counted for Settings, never deleted here.
    const adopt: Array<{ localId: string; cloudId: string }> = [];
    for (const [localId, on] of onlineDeals) {
      // BACKLOG-4263 PR-4b: a deal removed online (kept 30 days, restorable) is neither adopted nor counted as
      // "saved online but not on this computer".
      if (on.removed) continue;
      if (recordedDealCloudIds.has(on.cloudId)) continue;
      if (eligible.has(localId)) {
        if (!dealsWithState.has(localId)) {
          adopt.push({ localId, cloudId: on.cloudId });
          mark.add(localId);
        }
        continue;
      }
      orphanCloudIds.push(on.cloudId);
    }
    // BACKLOG-4263 PR-6: deals the owner restored online are counted on their own line, not as orphans.
    const { restored } = await this.restoredOnlineByOwner(pinned, orphanCloudIds);
    orphanDeals = orphanCloudIds.length - restored.size;

    const summary: ReconcileSummary = {
      orphanDeals,
      restoredOnlineOnly: restored.size,
      restoredOnlineIds: [...restored],
      deletesDeferred: deleteCandidates.length - toDelete.length,
      marked: mark.size,
    };
    store.applyReconcile(
      db,
      projectRef,
      pinned.userId,
      { nullHashes, markDeals: [...mark], adoptDeals: adopt, summaryJson: JSON.stringify(summary), todoResetDeals },
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
   * Sends one deal's people: tombstones of rows that moved away, then people,
   * then tombstones of people gone locally. (Checklists and items are todo
   * changes since BACKLOG-4263 PR-4a: todos/sender.ts.) Each response's accepted rows are
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

    const upsert = async (kind: ChildKind, rows: ProjectedChild[]): Promise<"ok" | "not_found" | DealResult> => {
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
      return "ok";
    };

    const moved = await tombstone(plan.moved);
    if (moved !== "ok") return { kind: "failed", result: moved };
    for (const kind of CHILD_KINDS) {
      const r = await upsert(kind, plan.send[kind]);
      if (r === "not_found") return { kind: "not_found" };
      if (r !== "ok") return { kind: "failed", result: r };
    }
    const order: ChildKind[] = ["party"];
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
    db.transaction(() => {
      store.writeDealState(
        db,
        this.deps.projectRef,
        pinned.userId,
        row.transaction_id,
        { cloudId, hash: projected.hash, hashVersion: HASH_VERSION, cloudVersion: version, status: "saved" },
        this.now(),
      );
      // BACKLOG-4263 PR-4c: a todo record that names another online copy of this deal (a deal restored here from
      // its archive after its online copy was purged, or after a machine rebind) is forgotten, and the deal's
      // todos are queued again against the new copy.
      todoStore.resetTodoDealIfOtherCloudDeal(db, this.deps.projectRef, pinned.userId, row.transaction_id, cloudId, this.now());
    })();
    return { kind: "saved", cloudId, version };
  }
}
