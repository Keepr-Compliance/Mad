/**
 * BACKLOG-3343: durable record of iPhone sync sessions that started saving and have
 * not finished.
 *
 * A row is written before a session's first write and deleted at its commit point
 * (or inside the rollback transaction). A row still present at launch means the
 * process died, or a rollback failed, partway through — the launch sweep
 * (`iPhoneSyncStorageService.recoverInterruptedSessions`) removes that session's rows.
 */
import { dbAll, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface OpenSyncSession {
  sessionId: string;
  userId: string;
}

/** Record that a session has started writing. Idempotent. */
export function markStarted(userId: string, sessionId: string): void {
  dbRun(sql`INSERT OR IGNORE INTO iphone_sync_open_sessions (session_id, user_id) VALUES (?, ?)`, [
    sessionId,
    userId,
  ]);
}

/** Record that a session is finished — committed, or rolled back. */
export function markFinished(sessionId: string): void {
  dbRun(sql`DELETE FROM iphone_sync_open_sessions WHERE session_id = ?`, [sessionId]);
}

/** Every session still marked open, oldest first. */
export function listOpen(): OpenSyncSession[] {
  return dbAll<OpenSyncSession>(
    sql`SELECT session_id AS sessionId, user_id AS userId FROM iphone_sync_open_sessions ORDER BY started_at, session_id`,
  );
}
