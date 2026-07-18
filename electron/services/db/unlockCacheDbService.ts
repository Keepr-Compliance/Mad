/**
 * Unlock Cache Database Service (BACKLOG-2006a)
 *
 * A LOCAL mirror of confirmed server `transaction_unlocks` rows, used ONLY to
 * permit reading an ALREADY-purchased transaction while offline.
 *
 * SECURITY INVARIANT — THE CACHE IS A MIRROR, NEVER A GRANTOR:
 *   - `upsertUnlock` is called ONLY by entitlementService AFTER a live server
 *     read confirms a non-refunded unlock. Nothing else writes here.
 *   - A cache MISS (or empty cache) resolves LOCKED. Absence NEVER implies
 *     unlocked. The read helpers below return a row or null; the caller
 *     treats null as locked.
 *   - Rows are keyed by (local_transaction_id, user_id) so a shared device
 *     never leaks one account's unlock to another.
 *
 * The table is created by databaseService migration v50.
 */

import { dbGet, dbAll, dbRun } from "./core/dbConnection";
import logService from "../logService";

/** A cached mirror of a confirmed server unlock. */
export interface CachedUnlock {
  local_transaction_id: string;
  user_id: string;
  unlocked_at: string;
  funding_source: string | null;
  cached_at: string;
}

/**
 * Look up a cached unlock for a specific (transaction, user).
 * @returns the cached row, or null if none exists (⇒ caller treats as LOCKED).
 */
export function getCachedUnlock(
  localTransactionId: string,
  userId: string,
): CachedUnlock | null {
  const row = dbGet<CachedUnlock>(
    `SELECT local_transaction_id, user_id, unlocked_at, funding_source, cached_at
       FROM transaction_unlocks_cache
      WHERE local_transaction_id = ? AND user_id = ?`,
    [localTransactionId, userId],
  );
  return row ?? null;
}

/**
 * List the local transaction ids that THIS device has a confirmed unlock mirror
 * for, scoped to one user. Used by the transaction-list "Unlocked" badge
 * (BACKLOG-2090) to render at-a-glance unlock status WITHOUT one server read per
 * row.
 *
 * FAIL-CLOSED / MIRROR-ONLY: this reads the same mirror table `getCachedUnlock`
 * reads — every row here was written only after a live server read confirmed a
 * non-refunded unlock. A transaction ABSENT from the returned list is treated as
 * LOCKED by the caller (absence never implies unlocked). A tx unlocked on another
 * device simply won't appear until this device confirms it (e.g. on opening it),
 * which keeps the badge fail-closed rather than optimistically "unlocked".
 *
 * @returns the local_transaction_id of every cached unlock for `userId` (possibly empty).
 */
export function listCachedUnlockIds(userId: string): string[] {
  const rows = dbAll<{ local_transaction_id: string }>(
    `SELECT local_transaction_id
       FROM transaction_unlocks_cache
      WHERE user_id = ?`,
    [userId],
  );
  return rows.map((r) => r.local_transaction_id);
}

/**
 * Write/refresh a cache mirror of a CONFIRMED server unlock.
 *
 * MUST only be called after a live server read has confirmed a non-refunded
 * `transaction_unlocks` row for this (transaction, user). Passing an unverified
 * value here would violate the cache-is-a-mirror invariant.
 */
export function upsertUnlock(params: {
  localTransactionId: string;
  userId: string;
  unlockedAt: string;
  fundingSource?: string | null;
}): void {
  dbRun(
    `INSERT INTO transaction_unlocks_cache
       (local_transaction_id, user_id, unlocked_at, funding_source, cached_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(local_transaction_id, user_id) DO UPDATE SET
       unlocked_at = excluded.unlocked_at,
       funding_source = excluded.funding_source,
       cached_at = datetime('now')`,
    [
      params.localTransactionId,
      params.userId,
      params.unlockedAt,
      params.fundingSource ?? null,
    ],
  );
}

/**
 * Remove a cache mirror. Called when a live server read shows the unlock is
 * GONE or REFUNDED — so the offline view re-locks, matching server truth.
 */
export function removeCachedUnlock(
  localTransactionId: string,
  userId: string,
): void {
  dbRun(
    `DELETE FROM transaction_unlocks_cache
      WHERE local_transaction_id = ? AND user_id = ?`,
    [localTransactionId, userId],
  );
}

/**
 * Clear all cached unlocks (call on logout, mirroring feature-gate cache clear).
 */
export function clearUnlockCache(): void {
  dbRun(`DELETE FROM transaction_unlocks_cache`, []);
  logService.info(
    "[UnlockCache] Cleared all cached unlocks",
    "UnlockCacheDbService",
  );
}
