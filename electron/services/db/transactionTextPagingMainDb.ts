/**
 * BACKLOG-3884: the main-connection half of the Texts-tab readers
 * (transactionTextPagingDb.ts is the half the contact worker can import, so it never
 * touches the main conduit).
 */
import { sql, type SafeSql } from "./core/sqlText";
import { dbAll, dbGet } from "./core/dbConnection";
import { LINKED_TEXTS_FROM, NO_THREAD, isThreadlessKey, threadlessTextKey, type TextDb } from "./transactionTextPagingDb";

/** The main connection, through the conduit (slow-statement logging included). */
export const mainTextDb: TextDb = {
  prepare: (statement: SafeSql) => ({ all: (...params: unknown[]) => dbAll(statement, params) }),
};

/**
 * Every message id linked to the deal in the given conversations, all history, for
 * removing whole conversations (what the Texts tab used to collect from the rows it
 * held). Ids only, through the thread index.
 */
export function linkedTextMessageIdsForThreads(transactionId: string, threadKeys: readonly string[]): string[] {
  const ids = new Set<string>();
  const keys = [...new Set(threadKeys)];
  for (const key of keys.filter((k) => !isThreadlessKey(k))) {
    const rows = dbAll<{ id: string }>(
      sql`SELECT DISTINCT m.id AS id ${LINKED_TEXTS_FROM} AND m.thread_id = ?`,
      [transactionId, key],
    );
    for (const r of rows) ids.add(r.id);
  }
  // A person's thread-less texts (SR B4): only that person's, never the bucket.
  const threadless = new Set(keys.filter(isThreadlessKey));
  if (threadless.size > 0) {
    const rows = dbAll<{ id: string; participants: string | null }>(
      sql`SELECT DISTINCT m.id AS id, m.participants AS participants ${LINKED_TEXTS_FROM} AND ${NO_THREAD}`,
      [transactionId],
    );
    for (const r of rows) if (threadless.has(threadlessTextKey(r.participants, r.id))) ids.add(r.id);
  }
  return [...ids];
}

/** The conversation a linked text belongs to (search highlight), or null. */
export function linkedTextThreadKey(transactionId: string, messageId: string): string | null {
  const row = dbGet<{ thread_id: string | null; participants: string | null; id: string }>(
    sql`SELECT m.thread_id AS thread_id, m.participants AS participants, m.id AS id ${LINKED_TEXTS_FROM} AND m.id = ? LIMIT 1`,
    [transactionId, messageId],
  );
  if (!row) return null;
  return row.thread_id ? row.thread_id : threadlessTextKey(row.participants, row.id);
}
