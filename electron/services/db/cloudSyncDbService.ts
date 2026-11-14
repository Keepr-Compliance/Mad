/**
 * Keepr Cloud local state — BACKLOG-4243 PR-2 (plan §6).
 *
 * All reads and writes of the `cloud_sync_*` tables. Every multi-row change is
 * one SAVEPOINT. Nothing here makes a network call.
 */
import { randomUUID, createHash } from "crypto";
import {
  DELETE_DIRTY_IF_GENERATION_SQL,
  DELETE_STATE_FOR_DEAL_SQL,
  DELETE_STATE_FOR_USER_SQL,
  MARK_ALL_ELIGIBLE_FOR_USER_SQL,
  SELECT_DEAL_FOR_PASS_SQL,
  SELECT_DEAL_STATE_SQL,
  SELECT_DUE_DIRTY_SQL,
  RESET_DIRTY_FAILURE_SQL,
  UPDATE_DIRTY_FAILURE_SQL,
  UPSERT_DEAL_STATE_SQL,
} from "./cloudSyncSql";
import { withSavepoint, type SqlDb } from "./cloudSyncSqlDb";

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
  return withSavepoint(db, () => {
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
      db.exec("UPDATE cloud_sync_settings SET enabled = 0, local_confirmed_at = NULL");
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
      return { installId: created.install_id, rebound: false };
    }
    if (hash !== null && row.machine_hash === null) {
      db.prepare("UPDATE cloud_sync_install SET machine_hash = ? WHERE project_ref = ?").run(hash, projectRef);
    }
    return { installId: row.install_id, rebound: false };
  });
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
  withSavepoint(db, () => {
    db.prepare("DELETE FROM cloud_sync_install WHERE project_ref <> ?").run(projectRef);
    db.prepare("DELETE FROM cloud_sync_settings WHERE project_ref <> ?").run(projectRef);
    db.prepare("DELETE FROM cloud_sync_state WHERE project_ref <> ?").run(projectRef);
    const anyEnabled = db.prepare("SELECT 1 FROM cloud_sync_settings WHERE enabled = 1 LIMIT 1").get();
    if (!anyEnabled) db.exec("DELETE FROM cloud_sync_dirty");
  });
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
  withSavepoint(db, () => {
    ensureSettingsRow(db, projectRef, userId);
    const before = getSettings(db, projectRef, userId);
    db.prepare(
      `UPDATE cloud_sync_settings SET enabled = 1, local_confirmed_at = ?, notice_version = ?, accepted_at = ?,
         turn_off_owed_at = NULL WHERE project_ref = ? AND user_id = ?`,
    ).run(nowIso(now), fields.noticeVersion, fields.acceptedAt, projectRef, userId);
    if (!before || before.enabled !== 1) db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
  });
}

/** Local turn-off, at once and even offline. `owed`: the server call is still to be made. */
export function disableForUser(db: SqlDb, projectRef: string, userId: string, owed: boolean, now: Date = new Date()): void {
  withSavepoint(db, () => {
    ensureSettingsRow(db, projectRef, userId);
    db.prepare(
      `UPDATE cloud_sync_settings SET enabled = 0, local_confirmed_at = NULL, accepted_at = NULL,
         turn_off_owed_at = ? WHERE project_ref = ? AND user_id = ?`,
    ).run(owed ? nowIso(now) : null, projectRef, userId);
    clearUserSyncState(db, projectRef, userId);
  });
}

export function clearTurnOffOwed(db: SqlDb, projectRef: string, userId: string): void {
  db.prepare("UPDATE cloud_sync_settings SET turn_off_owed_at = NULL WHERE project_ref = ? AND user_id = ?").run(
    projectRef,
    userId,
  );
}

/** Drops this user's sync state and the marks of this user's deals. */
export function clearUserSyncState(db: SqlDb, projectRef: string, userId: string): void {
  db.prepare(DELETE_STATE_FOR_USER_SQL).run(projectRef, userId);
  db.prepare("DELETE FROM cloud_sync_dirty WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)").run(
    userId,
  );
}

/** Server `accepted_at` differs from the stored one: drop state, mark every eligible deal (R3a). */
export function applyAcceptedAt(db: SqlDb, projectRef: string, userId: string, acceptedAt: string | null): boolean {
  return withSavepoint(db, () => {
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
  });
}

export function saveLastState(db: SqlDb, projectRef: string, userId: string, json: string, now: Date = new Date()): void {
  ensureSettingsRow(db, projectRef, userId);
  db.prepare("UPDATE cloud_sync_settings SET last_state_json = ?, last_state_at = ? WHERE project_ref = ? AND user_id = ?").run(
    json,
    nowIso(now),
    projectRef,
    userId,
  );
}

// ---------------------------------------------------------------- dirty marks (R4)

export function selectDueDirty(db: SqlDb, now: Date, limit: number): DirtyRow[] {
  return db.prepare(SELECT_DUE_DIRTY_SQL).all(nowIso(now), limit) as DirtyRow[];
}

export function clearMarkIfGeneration(db: SqlDb, transactionId: string, generation: number): boolean {
  const r = db.prepare(DELETE_DIRTY_IF_GENERATION_SQL).run(transactionId, generation) as { changes?: number };
  if ((r?.changes ?? 0) > 0) return true;
  db.prepare(RESET_DIRTY_FAILURE_SQL).run(transactionId);
  return false;
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
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty d JOIN transactions t ON t.id = d.transaction_id WHERE t.user_id = ?")
    .get(userId) as { n: number } | undefined;
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
