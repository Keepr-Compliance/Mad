/**
 * Audit Log Database Service
 * Handles all audit log-related database operations
 *
 * Note: The audit_logs table is append-only. `prevent_audit_update` and
 * `prevent_audit_delete` (electron/database/schema.sql) refuse EVERY update and
 * delete without exception — including the synced_at write below, which is why
 * `markAuditLogsSynced` has to drop and restore the trigger inside one
 * transaction. (An older version of this note claimed synced_at updates were
 * exempt; they are not, and the trigger that made them look exempt was the
 * BACKLOG-2548 defect.)
 */

import type { AuditLogEntry, AuditLogDbRow } from "../auditService";
import { dbAll, dbRun, ensureDb } from "./core/dbConnection";
import { sql } from "./core/sqlText";

/**
 * Insert an audit log entry (append-only)
 * Note: The audit_logs table has triggers that prevent UPDATE and DELETE
 */
export async function insertAuditLog(entry: AuditLogEntry): Promise<void> {
  const statement = sql`
    INSERT INTO audit_logs (
      id, timestamp, user_id, session_id, action, resource_type,
      resource_id, metadata, ip_address, user_agent, success, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    entry.id,
    entry.timestamp.toISOString(),
    entry.userId,
    entry.sessionId || null,
    entry.action,
    entry.resourceType,
    entry.resourceId || null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.ipAddress || null,
    entry.userAgent || null,
    entry.success ? 1 : 0,
    entry.errorMessage || null,
  ];

  dbRun(statement, params);
}

/**
 * Get audit logs that haven't been synced to cloud
 */
export async function getUnsyncedAuditLogs(limit: number = 100): Promise<AuditLogEntry[]> {
  const statement = sql`
    SELECT * FROM audit_logs
    WHERE synced_at IS NULL
    ORDER BY timestamp ASC
    LIMIT ?
  `;

  const rows = dbAll<AuditLogDbRow>(statement, [limit]);
  return rows.map(mapAuditLogRowToEntry);
}

/**
 * The audit-log immutability trigger, defined in ONE place.
 *
 * BACKLOG-2548. This is a copy of the `prevent_audit_update` trigger in
 * `electron/database/schema.sql` and MUST stay character-equivalent to it. It
 * exists here only because `markAuditLogsSynced` has to drop the trigger to
 * perform the single update the trigger forbids, and must put back exactly what
 * it removed.
 *
 * WHY THIS IS A CONSTANT AND NOT AN INLINE STRING. Before BACKLOG-2548 this DDL
 * was hand-copied inline TWICE in the function below, and both copies had
 * drifted from the schema: each carried
 * `WHEN NEW.synced_at IS NULL OR OLD.synced_at IS NOT NULL`, a clause that
 * constrains only `synced_at` and says nothing about the other 13 columns. So
 * the first completed sync silently replaced the schema's strict trigger with a
 * weaker one, and from then on any UPDATE that also set `synced_at` could
 * rewrite `action`, `user_id`, `resource_id`, `metadata` and `timestamp` on any
 * not-yet-synced row. Restarting did not repair it: `schema.sql` uses
 * `CREATE TRIGGER IF NOT EXISTS`, and a trigger of that name already existed.
 *
 * `__tests__/auditLogTriggerAtomicity-2548.test.ts` extracts the trigger from
 * `schema.sql` at run time and asserts `sqlite_master` still matches it after a
 * sync. That test is the only guard against this drifting again — do not add a
 * second copy of this DDL anywhere.
 */
const PREVENT_AUDIT_UPDATE_DDL = `
  CREATE TRIGGER IF NOT EXISTS prevent_audit_update
  BEFORE UPDATE ON audit_logs
  BEGIN
    SELECT RAISE(ABORT, 'Audit logs cannot be modified');
  END
`;

/**
 * Mark audit logs as synced (only sets synced_at, only on not-yet-synced rows)
 *
 * The `audit_logs` table is append-only: `prevent_audit_update` refuses EVERY
 * update, this one included, so the trigger genuinely has to come off for the
 * duration of the write. What must never happen is the table being left
 * unprotected afterwards.
 *
 * BACKLOG-2548 — why the whole drop/update/recreate is one `db.transaction()`.
 * The three statements used to autocommit separately, so a process kill in
 * between left the database on disk with no immutability trigger at all. Two
 * distinct kill points were reproduced against this function: a kill after the
 * DROP left the trigger absent, and a kill after the UPDATE left the trigger
 * absent AND the rows marked synced — which is worse, because the next sync then
 * skips those rows and nothing ever prompts a repair. SQLite DDL is
 * transactional, so wrapping the unit makes both kills roll back to a protected
 * table. `synchronous = NORMAL` under WAL does not weaken this: it defers fsync,
 * it does not make a committed transaction partial.
 *
 * If a caller already holds a transaction on this connection, better-sqlite3
 * runs this as a SAVEPOINT — still atomic, and it does not throw.
 */
export async function markAuditLogsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const db = ensureDb();
  const syncedAt = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");

  // `AND synced_at IS NULL` (BACKLOG-2548): without it, re-marking an id that was
  // already synced silently overwrote its original sync timestamp. The recorded
  // moment a row reached the cloud is audit evidence; a later batch containing
  // the same id must not move it. A mixed batch still marks the unsynced members.
  const updateSql =
    `UPDATE audit_logs SET synced_at = ? WHERE id IN (${placeholders}) AND synced_at IS NULL`;

  const markSynced = db.transaction(() => {
    db.exec("DROP TRIGGER IF EXISTS prevent_audit_update");
    db.prepare(updateSql).run(syncedAt, ...ids);
    db.exec(PREVENT_AUDIT_UPDATE_DDL);
  });

  try {
    markSynced();
  } catch (error) {
    // Unreachable for the DDL now that the unit is transactional (the rollback
    // has already restored the trigger, so this is an IF NOT EXISTS no-op). Kept
    // as belt-and-braces for the case where the rollback itself failed, and
    // deliberately reusing the SAME constant rather than a second hand-copy.
    try {
      db.exec(PREVENT_AUDIT_UPDATE_DDL);
    } catch {
      // Ignore trigger recreation errors
    }
    throw error;
  }
}

/**
 * Audit log filter options
 */
export interface AuditLogFilters {
  userId?: string;
  action?: string;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Get audit logs for a user with optional filters
 */
export async function getAuditLogs(filters: AuditLogFilters): Promise<AuditLogEntry[]> {
  let statement = sql`SELECT * FROM audit_logs WHERE 1=1`;
  const params: (string | number)[] = [];

  if (filters.userId) {
    statement = sql`${statement} AND user_id = ?`;
    params.push(filters.userId);
  }

  if (filters.action) {
    statement = sql`${statement} AND action = ?`;
    params.push(filters.action);
  }

  if (filters.resourceType) {
    statement = sql`${statement} AND resource_type = ?`;
    params.push(filters.resourceType);
  }

  if (filters.startDate) {
    statement = sql`${statement} AND timestamp >= ?`;
    params.push(filters.startDate.toISOString());
  }

  if (filters.endDate) {
    statement = sql`${statement} AND timestamp <= ?`;
    params.push(filters.endDate.toISOString());
  }

  statement = sql`${statement} ORDER BY timestamp DESC`;

  if (filters.limit) {
    statement = sql`${statement} LIMIT ?`;
    params.push(filters.limit);
  }

  if (filters.offset) {
    statement = sql`${statement} OFFSET ?`;
    params.push(filters.offset);
  }

  const rows = dbAll<AuditLogDbRow>(statement, params);
  return rows.map(mapAuditLogRowToEntry);
}

/**
 * Map database row to AuditLogEntry
 */
function mapAuditLogRowToEntry(row: AuditLogDbRow): AuditLogEntry {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    userId: row.user_id,
    sessionId: row.session_id || undefined,
    action: row.action as AuditLogEntry["action"],
    resourceType: row.resource_type as AuditLogEntry["resourceType"],
    resourceId: row.resource_id || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    ipAddress: row.ip_address || undefined,
    userAgent: row.user_agent || undefined,
    success: row.success === 1,
    errorMessage: row.error_message || undefined,
    syncedAt: row.synced_at ? new Date(row.synced_at) : undefined,
  };
}
