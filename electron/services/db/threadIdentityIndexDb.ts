/**
 * The 1:1 thread identity index (BACKLOG-2287) read on a caller-supplied connection,
 * so the contact query worker and the main-thread fallback run ONE implementation and
 * the statement text stays inside `electron/services/db/` (BACKLOG-2514 rule).
 *
 * BACKLOG-3816 PC final check (2026-10-10): this read covers every text message of the
 * user. It runs on the worker; the main thread runs it only when the worker is not up.
 */
import { THREAD_DIRECTION_PARTICIPANTS_SQL } from "./autoLinkSql";
import { buildOneToOneThreadIndex, type ThreadIdentityRow } from "../../utils/threadIdentity";

export interface ThreadIdentityIndex {
  /** [thread_id, identity token] for every thread that is itself a 1:1. */
  oneToOne: Array<[string, string]>;
  /** Text-message rows read. */
  rows: number;
}

export interface ThreadIdentityRunner {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export function readOneToOneThreadIndexOn(db: ThreadIdentityRunner, userId: string): ThreadIdentityIndex {
  const rows = db.prepare(THREAD_DIRECTION_PARTICIPANTS_SQL).all(userId) as ThreadIdentityRow[];
  return { oneToOne: buildOneToOneThreadIndex(rows), rows: rows.length };
}
