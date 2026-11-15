/**
 * BACKLOG-4212: reads and writes behind the per-user sender suppress list (U1).
 *
 * Local SQLite only: nothing here is synced, exported or sent. The list itself
 * is derived on every read from the user's live Learn bulk answers; nothing
 * stores it. The only writes (PR3) are the user's own "Stop hiding" rows
 * (the override table, SQL in learnModeSql.ts); they never touch an answer.
 */
import crypto from "crypto";
import { dbAll, dbRun } from "./core/dbConnection";
import {
  INSERT_SENDER_OVERRIDE_SQL,
  SOFT_DELETE_SENDER_OVERRIDE_SQL,
  USER_OWN_ADDRESSES_SQL,
  USER_SUPPRESS_CANDIDATES_SQL,
  USER_SUPPRESS_SETTINGS_ROWS_SQL,
} from "./learnModeSql";

export function listUserSuppressCandidates(userId: string, minAnswers: number): string[] {
  return dbAll<{ sender_key: string }>(USER_SUPPRESS_CANDIDATES_SQL, [userId, minAnswers]).map((r) => r.sender_key);
}

export function listUserOwnAddresses(userId: string): string[] {
  return dbAll<{ address: string }>(USER_OWN_ADDRESSES_SQL, [userId, userId]).map((r) => r.address);
}

/** PR3: senders at or above N (veto applied), with or without a live override. */
export function listUserSuppressSettingsRows(
  userId: string,
  minAnswers: number,
): Array<{ senderKey: string; newsletterCount: number; overridden: boolean }> {
  return dbAll<{ sender_key: string; newsletter_count: number; overridden: number }>(USER_SUPPRESS_SETTINGS_ROWS_SQL, [
    userId,
    minAnswers,
  ]).map((r) => ({ senderKey: r.sender_key, newsletterCount: r.newsletter_count, overridden: r.overridden === 1 }));
}

/** PR3: "Stop hiding". `senderKey` must already be normalised (fromAddress). One statement. */
export function insertSenderOverride(userId: string, senderKey: string): void {
  const now = new Date().toISOString();
  dbRun(INSERT_SENDER_OVERRIDE_SQL, [crypto.randomUUID(), userId, senderKey, now, now]);
}

/** PR3: "Hide again". Soft-removes the live row. One statement. */
export function softDeleteSenderOverride(userId: string, senderKey: string): void {
  const now = new Date().toISOString();
  dbRun(SOFT_DELETE_SENDER_OVERRIDE_SQL, [now, now, userId, senderKey]);
}
