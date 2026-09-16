/**
 * Hide / unhide individual texts from a transaction's export — BACKLOG-3366.
 *
 * The SQL and the reasoning behind its two-id match live in `hiddenTextSql.ts`.
 *
 * Each export is a PLAIN function returning `Promise<T>`, never `async`
 * (BACKLOG-2960): the driver call is evaluated before `Promise.resolve` wraps
 * its value, so a failure throws before the promise exists. Every write here is
 * ONE statement, so none needs a transaction.
 *
 * No `*Sync` twins, deliberately. `syncTwin.guard.test.ts` requires every
 * paired `*Sync` export to be reached from a transaction body, and nothing
 * calls these from one. A twin is added when a body first needs it.
 */

import { dbGet, dbRun } from "./core/dbConnection";
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
 * Record a hide. Resolves true when a row was added; false when the message is
 * not a linked, non-reaction text of this transaction, or is already hidden.
 */
export function hideTextFromExport(input: HideTextInput): Promise<boolean> {
  const result = dbRun(HIDE_TEXT_FROM_EXPORT_SQL, [
    input.userId,
    input.messageId,
    input.transactionId,
  ]);
  return Promise.resolve(result.changes > 0);
}

/** Remove every hide matching this text (by id or provider id). Resolves the count. */
export function unhideTextFromExport(key: HiddenTextKey): Promise<number> {
  const result = dbRun(UNHIDE_TEXT_FROM_EXPORT_SQL, [
    key.transactionId,
    key.messageId,
    key.messageId,
  ]);
  return Promise.resolve(result.changes);
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
