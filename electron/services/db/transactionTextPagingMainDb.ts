/**
 * BACKLOG-3884: the main-connection half of the Texts-tab readers
 * (transactionTextPagingDb.ts is the half the contact worker can import, so it never
 * touches the main conduit).
 */
import { sql, type SafeSql } from "./core/sqlText";
import { dbAll, dbGet } from "./core/dbConnection";
import { LINKED_TEXTS_FROM, THREAD_KEY, UNTHREADED_TEXT_KEY, type TextDb } from "./transactionTextPagingDb";

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
  for (const key of new Set(threadKeys)) {
    const unthreaded = key === UNTHREADED_TEXT_KEY;
    const thread = unthreaded ? sql`(m.thread_id IS NULL OR m.thread_id = '')` : sql`m.thread_id = ?`;
    const rows = dbAll<{ id: string }>(
      sql`SELECT DISTINCT m.id AS id ${LINKED_TEXTS_FROM} AND ${thread}`,
      [transactionId, ...(unthreaded ? [] : [key])],
    );
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** The conversation a linked text belongs to (search highlight), or null. */
export function linkedTextThreadKey(transactionId: string, messageId: string): string | null {
  const row = dbGet<{ k: string }>(
    sql`SELECT ${THREAD_KEY} AS k ${LINKED_TEXTS_FROM} AND m.id = ? LIMIT 1`,
    [transactionId, messageId],
  );
  return row?.k ?? null;
}
