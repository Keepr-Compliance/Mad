/**
 * Keepr Cloud local state — BACKLOG-4243 PR-2 (plan §6).
 *
 * All reads and writes of the `cloud_sync_*` tables. Every multi-row change is
 * one SAVEPOINT. Nothing here makes a network call.
 */
import { randomUUID, createHash } from "crypto";
import {
  ADOPT_DEAL_STATE_SQL,
  COUNT_PARKED_FOR_USER_SQL,
  MARK_CHILD_REMOVED_SQL,
  MARK_DEAL_SQL,
  NULL_CHILD_HASH_SQL,
  NULL_STATE_HASH_BY_CLOUD_ID_SQL,
  SELECT_CHILD_STATE_BY_LOCAL_SQL,
  SELECT_CHILD_STATE_SQL,
  SELECT_DEALS_WITH_UNSENT_CHILDREN_SQL,
  SELECT_ELIGIBLE_DEAL_IDS_SQL,
  SELECT_PARTY_CONTACTS_SQL,
  SELECT_PARTY_EMAILS_SQL,
  SELECT_PARTY_PHONES_SQL,
  SELECT_PARTY_ROWS_SQL,
  SELECT_PARTY_SOURCE_LINKS_SQL,
  SELECT_USER_STATE_SQL,
  UNPARK_USER_MARKS_SQL,
  UPSERT_CHILD_STATE_SQL,
  COUNT_PENDING_FOR_USER_SQL,
  DELETE_DIRTY_IF_GENERATION_SQL,
  MARK_ALL_ELIGIBLE_ENABLED_SQL,
  RESET_STATE_AFTER_RESTORE_SQL,
  DELETE_STATE_FOR_DEAL_SQL,
  DELETE_STATE_FOR_USER_SQL,
  MARK_ALL_ELIGIBLE_FOR_USER_SQL,
  SELECT_DEAL_FOR_PASS_SQL,
  SELECT_DEAL_STATE_SQL,
  SELECT_DUE_DIRTY_SQL,
  RESET_DIRTY_FAILURE_SQL,
  UPDATE_DIRTY_FAILURE_SQL,
  UPSERT_DEAL_STATE_SQL,
  DELETE_STATE_AFTER_MOVE_SQL,
  DELETE_SWITCH_MARKER_SQL,
  MOVE_PENDING_ID,
  SELECT_SWITCH_MARKER_SQL,
  UPSERT_SWITCH_MARKER_SQL,
} from "./cloudSyncSql";
import type { SqlDb } from "./cloudSyncSqlDb";
import { SEED_TODO_COUNTER_SQL } from "./cloudSyncTodoSql";
import { deleteDealArchiveForUser, deleteDealArchiveOtherProjects, noteDealRemovedOnline } from "./cloudSyncDealArchive";
import {
  clearInstallRemoved,
  clearTodoStateEverywhere,
  clearTodoStateForUser,
  installRemovedAt,
  forgetTodoOtherProjects,
  prepareTodoPass,
  resetTodoDeal,
  scanTodosAllEnabled,
  scanTodosIfAllowed,
  startTodoTracking,
} from "./cloudSyncTodoDbService";
import {
  applyCloudSyncTriggerRule,
  repairCloudSyncTriggersIfMissing,
  requireCloudSyncTriggers,
  type TriggerLog,
} from "./cloudSyncTriggers";

export interface SettingsRow {
  project_ref: string;
  user_id: string;
  enabled: number;
  local_confirmed_at: string | null;
  notice_version: number | null;
  accepted_at: string | null;
  turn_off_owed_at: string | null;
}

export interface DealStateRow {
  cloud_id: string | null;
  content_hash: string | null;
  hash_version: number | null;
  cloud_version: number | null;
  removed: number;
  last_status: string | null;
}

export interface DirtyRow {
  transaction_id: string;
  generation: number;
  attempts: number;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

// ---------------------------------------------------------------- install + machine binding (N1)

export const DEVICE_FALLBACK_SUFFIX = "-fallback";

export function machineHash(deviceId: string): string | null {
  if (!deviceId || deviceId.endsWith(DEVICE_FALLBACK_SUFFIX)) return null;
  return createHash("sha256").update(deviceId, "utf8").digest("hex");
}

export interface InstallResult {
  installId: string;
  /** True when this call created the install row. */
  created?: boolean;
  /** True when this database moved to a different computer and was reset. */
  rebound: boolean;
}

/**
 * The install id for this project on this computer. A different machine hash
 * mints new install ids, clears local sync state and marks, and turns Keepr
 * Cloud off locally for every user until confirmed here. A fallback device id
 * never binds, rebinds or resets.
 */
export function ensureInstall(db: SqlDb, projectRef: string, deviceId: string, now: Date = new Date()): InstallResult {
  const hash = machineHash(deviceId);
  return db.transaction(() => {
    const row = db
      .prepare("SELECT install_id, machine_hash FROM cloud_sync_install WHERE project_ref = ?")
      .get(projectRef) as { install_id: string; machine_hash: string | null } | undefined;
    const others = db
      .prepare("SELECT machine_hash FROM cloud_sync_install WHERE machine_hash IS NOT NULL")
      .all() as Array<{ machine_hash: string }>;
    const boundElsewhere = hash !== null && others.some((o) => o.machine_hash !== hash);
    if (boundElsewhere) {
      for (const r of db.prepare("SELECT project_ref FROM cloud_sync_install").all() as Array<{ project_ref: string }>) {
        db.prepare("UPDATE cloud_sync_install SET install_id = ?, machine_hash = ? WHERE project_ref = ?").run(
          randomUUID(),
          hash,
          r.project_ref,
        );
      }
      db.exec("DELETE FROM cloud_sync_state");
      db.exec("DELETE FROM cloud_sync_dirty");
      // BACKLOG-4263 D6/E1: every user's todo rows, every counter row and every stop go with the old install ids.
      clearTodoStateEverywhere(db);
      db.exec("UPDATE cloud_sync_settings SET enabled = 0, local_confirmed_at = NULL");
      // R1: no user is enabled now; the triggers go unless a turn-off is still owed.
      applyCloudSyncTriggerRule(db);
      const after = db
        .prepare("SELECT install_id FROM cloud_sync_install WHERE project_ref = ?")
        .get(projectRef) as { install_id: string } | undefined;
      if (after) return { installId: after.install_id, rebound: true };
      const id = randomUUID();
      db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, ?, ?)").run(
        projectRef,
        id,
        hash,
        nowIso(now),
      );
      return { installId: id, rebound: true };
    }
    if (!row) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_ref) DO NOTHING",
      ).run(projectRef, id, hash, nowIso(now));
      const created = db
        .prepare("SELECT install_id FROM cloud_sync_install WHERE project_ref = ?")
        .get(projectRef) as { install_id: string };
      return { installId: created.install_id, rebound: false, created: true };
    }
    if (hash !== null && row.machine_hash === null) {
      db.prepare("UPDATE cloud_sync_install SET machine_hash = ? WHERE project_ref = ?").run(hash, projectRef);
    }
    return { installId: row.install_id, rebound: false };
  })();
}

// ---------------------------------------------------------------- project guard (R10b, N4)

/** True when an enabled setting or a sync-state row exists under another project. */
export function otherProjectInUse(db: SqlDb, projectRef: string): boolean {
  const s = db
    .prepare("SELECT 1 FROM cloud_sync_settings WHERE project_ref <> ? AND (enabled = 1 OR turn_off_owed_at IS NOT NULL) LIMIT 1")
    .get(projectRef);
  if (s) return true;
  return !!db.prepare("SELECT 1 FROM cloud_sync_state WHERE project_ref <> ? LIMIT 1").get(projectRef);
}

/** Forgets every other project's local rows. No network call. */
export function forgetOtherProjects(db: SqlDb, projectRef: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM cloud_sync_install WHERE project_ref <> ?").run(projectRef);
    db.prepare("DELETE FROM cloud_sync_settings WHERE project_ref <> ?").run(projectRef);
    db.prepare("DELETE FROM cloud_sync_state WHERE project_ref <> ?").run(projectRef);
    forgetTodoOtherProjects(db, projectRef);
    // BACKLOG-4263 PR-4c: deals deleted under another project can no longer be restored here.
    deleteDealArchiveOtherProjects(db, projectRef);
    const anyEnabled = db.prepare("SELECT 1 FROM cloud_sync_settings WHERE enabled = 1 LIMIT 1").get();
    if (!anyEnabled) db.exec("DELETE FROM cloud_sync_dirty");
    applyCloudSyncTriggerRule(db);
  })();
}

// ---------------------------------------------------------------- settings

export function getSettings(db: SqlDb, projectRef: string, userId: string): SettingsRow | null {
  return (
    (db.prepare("SELECT * FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(projectRef, userId) as
      | SettingsRow
      | undefined) ?? null
  );
}

/** Any user with Keepr Cloud on (or a turn-off still owed) for this project. No network. */
export function anyActiveSettings(db: SqlDb, projectRef: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM cloud_sync_settings WHERE project_ref = ? AND (enabled = 1 OR turn_off_owed_at IS NOT NULL) LIMIT 1")
    .get(projectRef);
}

function ensureSettingsRow(db: SqlDb, projectRef: string, userId: string): void {
  db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(
    projectRef,
    userId,
  );
}

/**
 * 0 → 1: confirmed on this computer and entitled. Every 0 → 1 marks all of
 * the user's eligible deals (the triggers marked nothing while it was 0).
 */
export function enableForUser(
  db: SqlDb,
  projectRef: string,
  userId: string,
  fields: { noticeVersion: number | null; acceptedAt: string | null },
  now: Date = new Date(),
): void {
  db.transaction(() => {
    ensureSettingsRow(db, projectRef, userId);
    const before = getSettings(db, projectRef, userId);
    db.prepare(
      `UPDATE cloud_sync_settings SET enabled = 1, local_confirmed_at = ?, notice_version = ?, accepted_at = ?,
         turn_off_owed_at = NULL WHERE project_ref = ? AND user_id = ?`,
    ).run(nowIso(now), fields.noticeVersion, fields.acceptedAt, projectRef, userId);
    // R1: the triggers exist before any deal is marked, in this transaction.
    requireCloudSyncTriggers(db);
    // BACKLOG-4263 R3: this computer's todo edit counter (no-op without an install row, or when present).
    db.prepare(SEED_TODO_COUNTER_SQL).run(projectRef);
    if (!before || before.enabled !== 1) {
      // A fresh enable trusts no earlier record of what was saved online.
      db.prepare(DELETE_STATE_FOR_USER_SQL).run(projectRef, userId);
      db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
      // BACKLOG-4263 N3 / D6: the user's todos start afresh (clear, counter, full pull owed) and the initial
      // scan queues every checklist and item, all in this transaction.
      startTodoTracking(db, projectRef, userId, now);
    }
  })();
}

/** Local turn-off, at once and even offline. `owed`: the server call is still to be made. */
export function disableForUser(db: SqlDb, projectRef: string, userId: string, owed: boolean, now: Date = new Date()): void {
  db.transaction(() => {
    ensureSettingsRow(db, projectRef, userId);
    db.prepare(
      `UPDATE cloud_sync_settings SET enabled = 0, local_confirmed_at = NULL, accepted_at = NULL,
         turn_off_owed_at = ? WHERE project_ref = ? AND user_id = ?`,
    ).run(owed ? nowIso(now) : null, projectRef, userId);
    clearUserSyncState(db, projectRef, userId);
    // R1: an owed turn-off keeps the triggers until the server step is settled.
    applyCloudSyncTriggerRule(db);
  })();
}

/**
 * BACKLOG-4263 PR-4b (D2): after cloud_reclaim_install answered ok, for THIS user only, in one transaction:
 * forget the user's sync records (the next pass uploads every deal again under the same install id, which
 * un-removes them online), clear the user's todo state and stop (D6 / E1), seed the counter, owe a full pull,
 * and mark the user's eligible deals. Other local users and the install row are untouched.
 */
export function reclaimInstallForUser(db: SqlDb, projectRef: string, userId: string, now: Date = new Date()): void {
  db.transaction(() => {
    db.prepare(DELETE_STATE_FOR_USER_SQL).run(projectRef, userId);
    db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
    startTodoTracking(db, projectRef, userId, now);
  })();
}

/** The server confirmed the turn-off: clear the owed marker, then apply the trigger rule, together. */
export function clearTurnOffOwed(db: SqlDb, projectRef: string, userId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE cloud_sync_settings SET turn_off_owed_at = NULL WHERE project_ref = ? AND user_id = ?").run(
      projectRef,
      userId,
    );
    applyCloudSyncTriggerRule(db);
  })();
}

/** Drops this user's sync state and the marks of this user's deals. */
export function clearUserSyncState(db: SqlDb, projectRef: string, userId: string): void {
  db.transaction(() => {
    db.prepare(DELETE_STATE_FOR_USER_SQL).run(projectRef, userId);
    db.prepare("DELETE FROM cloud_sync_dirty WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)").run(
      userId,
    );
    // BACKLOG-4263 D6/E1: outbox, shadow, cursor, parked rows, notices, trash and the stop.
    clearTodoStateForUser(db, projectRef, userId);
    // BACKLOG-4263 PR-4c (plan §14 F6): turning Keepr Cloud off ends the 30-day restore of this user's deleted
    // deals (a Delete for good still owed goes too: turning off deletes the online copy anyway).
    deleteDealArchiveForUser(db, userId);
  })();
}

/**
 * Before a pass sends anything, in one transaction: apply a changed server
 * `accepted_at` (R3a), and the R1 self-check: "no marks" means "nothing to
 * upload" only while every trigger exists, so a missing one is recreated and
 * every eligible deal marked.
 */
export function preparePass(
  db: SqlDb,
  projectRef: string,
  userId: string,
  acceptedAt: string | null,
  log?: TriggerLog,
  now: Date = new Date(),
): void {
  db.transaction(() => {
    if (applyAcceptedAt(db, projectRef, userId, acceptedAt)) {
      // The account was turned off and on elsewhere: everything online is new, so the todos start afresh.
      startTodoTracking(db, projectRef, userId, now);
    }
    // A repaired trigger may have missed todo changes: the gated scan (refused while a full pull is owed, E4).
    if (repairCloudSyncTriggersIfMissing(db, log) > 0) scanTodosAllEnabled(db, now);
    // BACKLOG-4263 N1a (once per user) and N1b (counter seed).
    prepareTodoPass(db, projectRef, userId, now);
  })();
}

/** Server `accepted_at` differs from the stored one: drop state, mark every eligible deal (R3a). */
export function applyAcceptedAt(db: SqlDb, projectRef: string, userId: string, acceptedAt: string | null): boolean {
  return db.transaction(() => {
    const s = getSettings(db, projectRef, userId);
    if (!s || s.accepted_at === acceptedAt) return false;
    db.prepare(DELETE_STATE_FOR_USER_SQL).run(projectRef, userId);
    db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
    db.prepare("UPDATE cloud_sync_settings SET accepted_at = ? WHERE project_ref = ? AND user_id = ?").run(
      acceptedAt,
      projectRef,
      userId,
    );
    return true;
  })();
}

// ---------------------------------------------------------------- dirty marks (R4)

export function selectDueDirty(db: SqlDb, userId: string, now: Date, limit: number): DirtyRow[] {
  return db.prepare(SELECT_DUE_DIRTY_SQL).all(userId, userId, nowIso(now), limit) as DirtyRow[];
}

/** BACKLOG-4263 PR-4c: the deal has a dirty mark (a change, or its removal, still to be sent). */
export function isMarked(db: SqlDb, transactionId: string): boolean {
  return !!db.prepare("SELECT 1 FROM cloud_sync_dirty WHERE transaction_id = ?").get(transactionId);
}

export function clearMarkIfGeneration(db: SqlDb, transactionId: string, generation: number): boolean {
  return db.transaction(() => {
    const r = db.prepare(DELETE_DIRTY_IF_GENERATION_SQL).run(transactionId, generation) as { changes?: number };
    if ((r?.changes ?? 0) > 0) return true;
    db.prepare(RESET_DIRTY_FAILURE_SQL).run(transactionId);
    return false;
  })();
}

/** Back-off schedule (minutes) for retryable failures; capped at the last value. */
export const BACKOFF_MINUTES = [1, 2, 5, 15, 60] as const;

/** Far future: parked until the deal changes again or the daily reconcile. */
export const PARKED_UNTIL = "9999-12-31T00:00:00.000Z";

export function recordRetryableFailure(db: SqlDb, row: DirtyRow, code: string, now: Date): void {
  const minutes = BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length - 1)];
  db.prepare(UPDATE_DIRTY_FAILURE_SQL).run(new Date(now.getTime() + minutes * 60_000).toISOString(), code, row.transaction_id);
}

/** Non-retryable for this call: parked until the next change bumps the generation. */
export function recordNonRetryableFailure(db: SqlDb, row: DirtyRow, code: string): void {
  db.prepare(UPDATE_DIRTY_FAILURE_SQL).run(`${PARKED_UNTIL}#${row.generation}`, code, row.transaction_id);
}

// ---------------------------------------------------------------- deal state

export function getDealState(db: SqlDb, projectRef: string, userId: string, localId: string): DealStateRow | null {
  return (db.prepare(SELECT_DEAL_STATE_SQL).get(projectRef, userId, localId) as DealStateRow | undefined) ?? null;
}

export function anyDealStateForOtherOwner(db: SqlDb, projectRef: string, userId: string, transactionId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id <> ? AND transaction_id = ? LIMIT 1")
    .get(projectRef, userId, transactionId);
}

export function writeDealState(
  db: SqlDb,
  projectRef: string,
  userId: string,
  localId: string,
  v: { cloudId: string; hash: string; hashVersion: number; cloudVersion: number | null; status: "saved" | "synced" },
  now: Date,
): void {
  db.prepare(UPSERT_DEAL_STATE_SQL).run(
    projectRef,
    userId,
    localId,
    localId,
    v.cloudId,
    v.cloudId,
    v.hash,
    v.hashVersion,
    v.cloudVersion,
    v.status,
    nowIso(now),
  );
}

export function deleteDealState(db: SqlDb, projectRef: string, userId: string, transactionId: string): void {
  db.prepare(DELETE_STATE_FOR_DEAL_SQL).run(projectRef, userId, transactionId);
}

export function readDealRow(db: SqlDb, transactionId: string): Record<string, unknown> | null {
  return (db.prepare(SELECT_DEAL_FOR_PASS_SQL).get(transactionId) as Record<string, unknown> | undefined) ?? null;
}

// ---------------------------------------------------------------- runs

export function startRun(db: SqlDb, projectRef: string, now: Date): number {
  const r = db.prepare("INSERT INTO cloud_sync_runs (project_ref, started_at) VALUES (?, ?)").run(projectRef, nowIso(now)) as {
    lastInsertRowid?: number | bigint;
  };
  return Number(r?.lastInsertRowid ?? 0);
}

export function finishRun(
  db: SqlDb,
  id: number,
  v: { outcome: string; done: number; failed: number; rejected: number; errorCode: string | null },
  now: Date,
): void {
  db.prepare(
    "UPDATE cloud_sync_runs SET finished_at = ?, outcome = ?, deals_done = ?, deals_failed = ?, rows_rejected = ?, error_code = ? WHERE id = ?",
  ).run(nowIso(now), v.outcome, v.done, v.failed, v.rejected, v.errorCode, id);
  db.prepare("DELETE FROM cloud_sync_runs WHERE id NOT IN (SELECT id FROM cloud_sync_runs ORDER BY id DESC LIMIT 50)").run();
}

// ---------------------------------------------------------------- status (Settings)

export function countPendingDeals(db: SqlDb, userId: string): number {
  const r = db.prepare(COUNT_PENDING_FOR_USER_SQL).get(userId) as { n: number } | undefined;
  return r?.n ?? 0;
}

export function countParkedDeals(db: SqlDb, userId: string): number {
  const r = db.prepare(COUNT_PARKED_FOR_USER_SQL).get(userId) as { n: number } | undefined;
  return r?.n ?? 0;
}

export function lastSavedAt(db: SqlDb, projectRef: string): string | null {
  const r = db
    .prepare("SELECT MAX(finished_at) AS at FROM cloud_sync_runs WHERE project_ref = ? AND outcome = 'done' AND deals_done > 0")
    .get(projectRef) as { at: string | null } | undefined;
  return r?.at ?? null;
}

/** One counters row per pass that did work; keeps the last 50. */
export function recordRun(
  db: SqlDb,
  projectRef: string,
  v: { outcome: string; done: number; failed: number; rejected: number; errorCode: string | null },
  now: Date,
): void {
  finishRun(db, startRun(db, projectRef, now), v, now);
}

/** The online copy is gone: drop this deal's state and its mark (this generation), together. */
export function forgetDealDeletedOnline(
  db: SqlDb,
  projectRef: string,
  userId: string,
  transactionId: string,
  generation: number,
  now: Date = new Date(),
): void {
  db.transaction(() => {
    deleteDealState(db, projectRef, userId, transactionId);
    clearMarkIfGeneration(db, transactionId, generation);
    // BACKLOG-4263: the deal's todo shadow names the old online copy; forget it and queue the deal's todos
    // again (unknowable times), so a deal that returns under a new online id gets its todos created.
    resetTodoDeal(db, projectRef, userId, transactionId, now);
    // BACKLOG-4263 PR-4c: the deal's archive (if any) records that its removal online was confirmed.
    noteDealRemovedOnline(db, transactionId);
  })();
}

/** The server confirmed the full save: record "synced" and clear the mark (this generation), together. */
export function recordDealSynced(
  db: SqlDb,
  projectRef: string,
  userId: string,
  transactionId: string,
  generation: number,
  v: { cloudId: string; hash: string; hashVersion: number; cloudVersion: number | null },
  now: Date,
): void {
  db.transaction(() => {
    writeDealState(db, projectRef, userId, transactionId, { ...v, status: "synced" }, now);
    clearMarkIfGeneration(db, transactionId, generation);
  })();
}

// ================================================================ children (PR-3)

export type ChildEntity = "party" | "checklist" | "checklist_item";

export interface ChildStateRow {
  entity: ChildEntity;
  local_id: string;
  transaction_id: string;
  cloud_id: string | null;
  content_hash: string | null;
  hash_version: number | null;
  removed: number;
  last_status: string | null;
}

export interface DealChildRows {
  parties: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  emails: Array<Record<string, unknown>>;
  phones: Array<Record<string, unknown>>;
  sourceLinks: Array<Record<string, unknown>>;
}

/** Every local row the child projections of one deal read. */
export function readDealChildren(db: SqlDb, transactionId: string): DealChildRows {
  const all = (q: string) => db.prepare(q).all(transactionId) as Array<Record<string, unknown>>;
  return {
    parties: all(SELECT_PARTY_ROWS_SQL),
    contacts: all(SELECT_PARTY_CONTACTS_SQL),
    emails: all(SELECT_PARTY_EMAILS_SQL),
    phones: all(SELECT_PARTY_PHONES_SQL),
    sourceLinks: all(SELECT_PARTY_SOURCE_LINKS_SQL),
  };
}

export function getChildStatesOfDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string): ChildStateRow[] {
  return db.prepare(SELECT_CHILD_STATE_SQL).all(projectRef, userId, transactionId) as ChildStateRow[];
}

export function getChildState(db: SqlDb, projectRef: string, userId: string, entity: ChildEntity, localId: string): ChildStateRow | null {
  return (db.prepare(SELECT_CHILD_STATE_BY_LOCAL_SQL).get(projectRef, userId, entity, localId) as ChildStateRow | undefined) ?? null;
}

export interface AcceptedChild {
  localId: string;
  cloudId: string;
  hash: string;
  version: number | null;
}

/** The rows of one upsert response the server accepted, recorded together. */
export function recordChildrenSaved(
  db: SqlDb,
  projectRef: string,
  userId: string,
  entity: ChildEntity,
  transactionId: string,
  cloudDealId: string,
  rows: AcceptedChild[],
  hashVersion: number,
  now: Date,
): void {
  db.transaction(() => {
    const st = db.prepare(UPSERT_CHILD_STATE_SQL);
    for (const r of rows) {
      st.run(projectRef, userId, entity, r.localId, transactionId, r.cloudId, cloudDealId, r.hash, hashVersion, r.version, nowIso(now));
    }
  })();
}

/** The rows of one tombstone response that are gone online, recorded together. */
export function recordChildrenRemoved(
  db: SqlDb,
  projectRef: string,
  userId: string,
  entity: ChildEntity,
  localIds: string[],
  now: Date,
): void {
  db.transaction(() => {
    const st = db.prepare(MARK_CHILD_REMOVED_SQL);
    for (const id of localIds) st.run(nowIso(now), projectRef, userId, entity, id);
  })();
}

/** Forget the recorded hash of these children so they are sent again. */
export function forgetChildHashes(db: SqlDb, projectRef: string, userId: string, entity: ChildEntity, localIds: string[]): void {
  db.transaction(() => {
    const st = db.prepare(NULL_CHILD_HASH_SQL);
    for (const id of localIds) st.run(projectRef, userId, entity, id);
  })();
}

// ================================================================ reconcile (PR-3)

export interface UserStateRow {
  entity: string;
  local_id: string;
  transaction_id: string;
  cloud_id: string | null;
  content_hash: string | null;
  removed: number;
}

export function readEligibleDealIds(db: SqlDb, userId: string): Set<string> {
  return new Set((db.prepare(SELECT_ELIGIBLE_DEAL_IDS_SQL).all(userId) as Array<{ id: string }>).map((r) => r.id));
}

export function readUserState(db: SqlDb, projectRef: string, userId: string): UserStateRow[] {
  return db.prepare(SELECT_USER_STATE_SQL).all(projectRef, userId) as UserStateRow[];
}

/** Deals of the user with a live local child that has no sync record yet (e.g. uploaded header-only). */
export function readDealsWithUnsentChildren(db: SqlDb, projectRef: string, userId: string): string[] {
  return (db.prepare(SELECT_DEALS_WITH_UNSENT_CHILDREN_SQL).all(userId, projectRef, userId) as Array<{
    id: string;
  }>).map((r) => r.id);
}

export interface ReconcileWrites {
  nullHashes: Array<{ entity: string; localId: string }>;
  markDeals: string[];
  /** Online deals of this install whose local deal exists with no record: record the cloud id, no hash. */
  adoptDeals?: Array<{ localId: string; cloudId: string }>;
  summaryJson: string;
  /** BACKLOG-4263: deals the cloud no longer has; their todos are scanned again against an empty shadow. */
  todoResetDeals?: string[];
}

/**
 * The reconcile's local writes, all in one transaction: forget recorded hashes
 * that no longer match what is online, mark the deals to revisit, un-park the
 * user's parked marks, and record when this reconcile ran.
 */
export function applyReconcile(db: SqlDb, projectRef: string, userId: string, w: ReconcileWrites, now: Date): void {
  db.transaction(() => {
    const nul = db.prepare(NULL_STATE_HASH_BY_CLOUD_ID_SQL);
    for (const n of w.nullHashes) nul.run(projectRef, userId, n.entity, n.localId);
    const adopt = db.prepare(ADOPT_DEAL_STATE_SQL);
    for (const a of w.adoptDeals ?? []) adopt.run(projectRef, userId, a.localId, a.localId, a.cloudId, a.cloudId, nowIso(now));
    const mark = db.prepare(MARK_DEAL_SQL);
    for (const id of w.markDeals) mark.run(id);
    db.prepare(UNPARK_USER_MARKS_SQL).run(userId);
    for (const id of w.todoResetDeals ?? []) resetTodoDeal(db, projectRef, userId, id, now);
    // The daily todo scan, refused while a full pull is owed (E4).
    scanTodosIfAllowed(db, projectRef, userId, now);
    db.prepare("UPDATE cloud_sync_settings SET last_state_json = ?, last_state_at = ? WHERE project_ref = ? AND user_id = ?").run(
      w.summaryJson,
      nowIso(now),
      projectRef,
      userId,
    );
  })();
}

/** When this user's last reconcile ran here, and what it found (null when never). */
export function lastReconcile(db: SqlDb, projectRef: string, userId: string): { at: string | null; summaryJson: string | null } {
  const r = db.prepare("SELECT last_state_at AS at, last_state_json AS j FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(
    projectRef,
    userId,
  ) as { at: string | null; j: string | null } | undefined;
  return { at: r?.at ?? null, summaryJson: r?.j ?? null };
}

/** After the user deleted them: no online deals without a local record remain in the last summary. */
/** PR-6: the online ids the last reconcile (or "Delete them") found restored online by the owner. */
export function lastRestoredOnlineIds(db: SqlDb, projectRef: string, userId: string): string[] {
  try {
    const j = lastReconcile(db, projectRef, userId).summaryJson;
    const ids = j ? (JSON.parse(j) as { restoredOnlineIds?: unknown }).restoredOnlineIds : null;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setOrphanCount(
  db: SqlDb,
  projectRef: string,
  userId: string,
  n: number,
  restoredOnlineOnly?: number,
  restoredOnlineIds?: string[],
): void {
  const cur = lastReconcile(db, projectRef, userId);
  let summary: Record<string, unknown> = {};
  try {
    summary = cur.summaryJson ? (JSON.parse(cur.summaryJson) as Record<string, unknown>) : {};
  } catch {
    summary = {};
  }
  summary.orphanDeals = n;
  if (restoredOnlineOnly !== undefined) summary.restoredOnlineOnly = restoredOnlineOnly;
  if (restoredOnlineIds !== undefined) summary.restoredOnlineIds = restoredOnlineIds;
  db.prepare("UPDATE cloud_sync_settings SET last_state_json = ? WHERE project_ref = ? AND user_id = ?").run(
    JSON.stringify(summary),
    projectRef,
    userId,
  );
}

// ---------------------------------------------------------------- one computer per account (BACKLOG-4263 P2)

/**
 * Plan §13.1 step 1: written before cloud_claim_install(p_replace = true) is called. `reclaim`: this computer's online
 * copy was found removed before the claim (the claim deletes that register row, so it is recorded here first).
 */
export function writeMovePending(db: SqlDb, projectRef: string, userId: string, now: Date = new Date(), reclaim = false): void {
  db.prepare(UPSERT_SWITCH_MARKER_SQL).run(projectRef, userId, MOVE_PENDING_ID, reclaim ? "reclaim" : null, nowIso(now));
}

/** The move marker, or null: `reclaim` as written by writeMovePending. */
export function movePending(db: SqlDb, projectRef: string, userId: string): { reclaim: boolean } | null {
  const r = db.prepare(SELECT_SWITCH_MARKER_SQL).get(projectRef, userId, MOVE_PENDING_ID) as { last_status: string | null } | undefined;
  return r ? { reclaim: r.last_status === "reclaim" } : null;
}

/** The claim did not move the account here (refused, or the server names another computer): only the marker goes. */
export function clearMovePending(db: SqlDb, projectRef: string, userId: string): void {
  db.prepare(DELETE_SWITCH_MARKER_SQL).run(projectRef, userId, MOVE_PENDING_ID);
}

/**
 * After a move to this computer (plan §14 D1, P2 acceptance condition 6), ONE local transaction, whatever the local
 * enabled flag: the email, text and file records and the move marker go, and every eligible deal of the user is
 * marked, so the next pass sends again what the erase job may have scrubbed while this computer was not active.
 * Deal and party records and the messages_upload sentinel stay.
 *
 * A computer whose online copy had been removed ("Delete them" on the active computer: `reclaim`, read online before
 * the claim; or a local stop already recorded) takes the reclaim path instead: the claim already deleted its register
 * row on the server (migration 20261123100000 marker CLAIM:reclaim, :859-862), and its deals were soft-removed
 * online, so every record of what was saved is forgotten, as after cloud_reclaim_install (reclaimInstallForUser), and
 * the local stop is cleared, in the same transaction. Without this its deal records still say "synced" and the
 * pass's shortcut would never send the removed deals again.
 */
export function applyMoveHere(db: SqlDb, projectRef: string, userId: string, now: Date = new Date(), reclaim = false): void {
  db.transaction(() => {
    if (reclaim || installRemovedAt(db, projectRef, userId)) {
      reclaimInstallForUser(db, projectRef, userId, now);
      clearInstallRemoved(db, projectRef, userId);
      return;
    }
    db.prepare(DELETE_STATE_AFTER_MOVE_SQL).run(projectRef, userId);
    db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
  })();
}

/**
 * Settles the move marker in one step: `movedHere` runs the move's local transaction (applyMoveHere), otherwise only
 * the marker goes (the claim was refused, or the server names another computer). Used after the claim's answer and
 * by the next pass's heal.
 */
export function settleMovePending(db: SqlDb, projectRef: string, userId: string, movedHere: boolean, now: Date = new Date(), reclaim = false): void {
  db.transaction(() => {
    if (movedHere) applyMoveHere(db, projectRef, userId, now, reclaim);
    else clearMovePending(db, projectRef, userId);
  })();
}

/**
 * Plan §2.5: a turn-off made here while offline is dropped because another computer became active first. The owed
 * marker goes (this computer stays off; nothing online is deleted), with the trigger rule, in one transaction. Why it
 * was dropped is kept in memory only (CloudSyncRunner.turnOffDropped): a state row would outlive the turn-off and
 * read as another project's data if this profile were later pointed at another project (otherProjectInUse).
 */
export function dropOwedTurnOff(db: SqlDb, projectRef: string, userId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE cloud_sync_settings SET turn_off_owed_at = NULL WHERE project_ref = ? AND user_id = ?").run(projectRef, userId);
    applyCloudSyncTriggerRule(db);
  })();
}
