/**
 * BACKLOG-3884: the Texts tab's reads — a conversation list and pages — instead of
 * every linked text of the deal in one reply (PC: 183,043 rows, ~152 MB).
 *
 *  - The conversation list reads every linked text of the deal (its counts are
 *    de-duplicated): on a dedicated contact worker, never on main unless no worker
 *    could start (the BACKLOG-3883 rule for the candidate reads).
 *  - A page is a bounded, index-driven read on main (idx_messages_thread_sent).
 *  - Removing whole conversations collects the message ids here, so the renderer no
 *    longer needs to hold every row to remove one.
 */
import logService from "./logService";
import transactionService from "./transactionService";
import { DedicatedWorkerError, isPoolReady, queryOnDedicatedWorker } from "../workers/contactWorkerPool";
import {
  readTransactionTextPage,
  readTransactionTextThreadsOn,
  type TextPage,
  type TextPageCursor,
  type TextThreadSummary,
  type TextWindow,
} from "./db/transactionTextPagingDb";
import { linkedTextMessageIdsForThreads, linkedTextThreadKey, mainTextDb } from "./db/transactionTextPagingMainDb";

const TEXT_THREADS_WORKER_TIMEOUT_MS = 5 * 60_000;
/** Undo ids are returned only up to this many (the reply-size bound). */
export const MAX_UNDO_IDS = 5000;

export async function getTransactionTextThreads(transactionId: string, w: TextWindow | null): Promise<TextThreadSummary[]> {
  if (isPoolReady()) {
    const startedAt = Date.now();
    try {
      const rows = (await queryOnDedicatedWorker("transactionTextThreads", "", TEXT_THREADS_WORKER_TIMEOUT_MS, {
        transactionId,
        startMs: w?.startMs ?? null,
        endMs: w?.endMs ?? null,
      })) as TextThreadSummary[];
      void logService.info(`[BACKLOG-3884] text conversation list read on a worker in ${Date.now() - startedAt}ms threads=${rows.length}`, "TextThreads");
      return rows;
    } catch (error) {
      const code = error instanceof DedicatedWorkerError ? error.code : "failed";
      if (code !== "start_failed") throw error;
      await logService.warn("[BACKLOG-3884] Text-threads worker could not start; reading on the main thread", "TextThreads", { code });
    }
  }
  return readTransactionTextThreadsOn(mainTextDb, transactionId, w);
}

export function getTransactionTextPage(
  transactionId: string,
  threadKeys: readonly string[],
  w: TextWindow | null,
  cursor: TextPageCursor | null,
  limit: number,
): TextPage {
  return readTransactionTextPage(mainTextDb, transactionId, threadKeys, w, cursor, limit);
}

export function findTextThread(transactionId: string, messageId: string): string | null {
  return linkedTextThreadKey(transactionId, messageId);
}

/**
 * Remove whole conversations from the deal: every linked message of each thread, all
 * history (what removing a conversation has always meant), through the existing
 * unlink. Returns the ids for Undo when there are few enough to send back.
 */
export async function unlinkTextThreads(
  transactionId: string,
  threadKeys: readonly string[],
): Promise<{ removed: number; messageIds: string[] | null }> {
  const ids = linkedTextMessageIdsForThreads(transactionId, threadKeys);
  if (ids.length === 0) return { removed: 0, messageIds: [] };
  await transactionService.unlinkMessages(ids, transactionId);
  return { removed: ids.length, messageIds: ids.length <= MAX_UNDO_IDS ? ids : null };
}
