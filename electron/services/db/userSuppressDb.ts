/**
 * BACKLOG-4212: reads behind the per-user sender suppress list (U1).
 *
 * Read only. Local SQLite only: nothing here is synced, exported or sent.
 * The list itself is derived on every read from the user's live Learn bulk
 * answers; nothing stores it.
 */
import { dbAll } from "./core/dbConnection";
import { USER_OWN_ADDRESSES_SQL, USER_SUPPRESS_CANDIDATES_SQL } from "./learnModeSql";

export function listUserSuppressCandidates(userId: string, minAnswers: number): string[] {
  return dbAll<{ sender_key: string }>(USER_SUPPRESS_CANDIDATES_SQL, [userId, minAnswers]).map((r) => r.sender_key);
}

export function listUserOwnAddresses(userId: string): string[] {
  return dbAll<{ address: string }>(USER_OWN_ADDRESSES_SQL, [userId, userId]).map((r) => r.address);
}
