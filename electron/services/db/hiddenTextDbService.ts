/**
 * Hide / unhide individual texts from a transaction's export — BACKLOG-3366.
 *
 * The SQL and the reasoning behind its two-id match live in `hiddenTextSql.ts`.
 *
 * Each export is a PLAIN function returning `Promise<T>`, never `async`
 * (BACKLOG-2960): the driver call is evaluated before `Promise.resolve` wraps
 * its value, so a failure throws before the promise exists.
 *
 * ## The `*Sync` twins (BACKLOG-3339 slice T)
 *
 * `hideTextFromExportSync` and `unhideTextFromExportSync` are the raw write,
 * called from the hide / unhide handlers' `dbTransaction` body together with
 * the audit entry, so the change and its entry commit together or not at all.
 * The promise halves have no production caller: they exist because
 * `syncTwin.guard.test.ts` requires every `*Sync` twin to have one, and they
 * are fixture producers for the tests. Each runs its twin in its own
 * `dbTransaction`.
 */

import { dbGet, dbRun, dbTransaction } from "./core/dbConnection";
import {
  HIDE_TEXT_FROM_EXPORT_SQL,
  IS_TEXT_HIDDEN_FROM_EXPORT_SQL,
  UNHIDE_TEXT_FROM_EXPORT_SQL,
} from "./hiddenTextSql";

export interface HiddenTextKey {
  transactionId: string;
  /** `messages.id` of the text. */
  messageId: string;
}

export interface HideTextInput extends HiddenTextKey {
  /** `users_local.id` recorded as `hidden_by`. */
  userId: string;
}

/**
 * Record a hide. Returns true when a row was added; false when the message is
 * not a linked, non-reaction text of this transaction, or is already hidden.
 * Raw statement: the caller owns the transaction.
 */
export function hideTextFromExportSync(input: HideTextInput): boolean {
  const result = dbRun(HIDE_TEXT_FROM_EXPORT_SQL, [
    input.userId,
    input.messageId,
    input.transactionId,
  ]);
  return result.changes > 0;
}

/**
 * No production caller: the promise half that syncTwin.guard requires for
 * `hideTextFromExportSync`; a fixture producer for the hidden-text tests.
 */
export function hideTextFromExport(input: HideTextInput): Promise<boolean> {
  return Promise.resolve(dbTransaction(() => hideTextFromExportSync(input)));
}

/**
 * Remove every hide matching this text (by id or provider id). Returns the
 * count. Raw statement: the caller owns the transaction.
 */
export function unhideTextFromExportSync(key: HiddenTextKey): number {
  const result = dbRun(UNHIDE_TEXT_FROM_EXPORT_SQL, [
    key.transactionId,
    key.messageId,
    key.messageId,
  ]);
  return result.changes;
}

/**
 * No production caller: the promise half that syncTwin.guard requires for
 * `unhideTextFromExportSync`; a fixture producer for the hidden-text tests.
 */
export function unhideTextFromExport(key: HiddenTextKey): Promise<number> {
  return Promise.resolve(dbTransaction(() => unhideTextFromExportSync(key)));
}

/** Read back whether this text is hidden in this transaction. */
export function isTextHiddenFromExport(key: HiddenTextKey): Promise<boolean> {
  const row = dbGet<{ hidden: number }>(IS_TEXT_HIDDEN_FROM_EXPORT_SQL, [
    key.transactionId,
    key.messageId,
    key.messageId,
  ]);
  return Promise.resolve(!!row?.hidden);
}
