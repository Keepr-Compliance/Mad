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
 *     unlocked. The read helper below RESOLVES TO a row or null; the caller
 *     awaits it and treats null as locked.
 *   - Rows are keyed by (local_transaction_id, user_id) so a shared device
 *     never leaks one account's unlock to another.
 *
 * The table is created by databaseService migration v50.
 *
 * ===========================================================================
 * BACKLOG-2960 — WHY THESE EXPORTS RETURN PROMISES
 * ===========================================================================
 * Epic 9 moves the async boundary to the export surface of
 * `electron/services/db/**`, so a future non-`better-sqlite3` driver can be
 * swapped in behind it without touching a caller. Until then the work is still
 * synchronous: each wrapper below is a PLAIN function — never `async` — that
 * runs its driver call FIRST and only then wraps the finished value in
 * `Promise.resolve`. That eagerness is the design: the driver call, and any
 * throw it raises, stay synchronous and inside whatever `better-sqlite3`
 * transaction encloses the caller. The measurements behind that rule are on
 * BACKLOG-2960 (SR reviews of PRs #2544 and #2545), dated and attributed.
 * Do not add `async` to any export in this file.
 *
 * ===========================================================================
 * THE FAILURE MODE THIS GUARDS — A PAYWALL, NOT A CRASH
 * ===========================================================================
 * `entitlementService.getUnlockStatus` decides the per-transaction gate from
 * the RESOLVED value of `getCachedUnlock`:
 *
 *     const cached = await getCachedUnlock(localTransactionId, userId);
 *     if (cached) return { status: "unlocked", fromCache: true };
 *
 * The resolved value is the verdict, and `null` is LOCKED. The promise object
 * itself carries no verdict — it is truthy either way — so the `await` at each
 * call site is part of the fail-closed contract stated above, not a style
 * preference. Await the two `void`-returning writes below for the same reason:
 * their ordering has to hold for whatever driver sits behind this boundary,
 * not only for today's synchronous one.
 *
 * Which instruments watch this contract, and what each one reports, is recorded
 * on BACKLOG-2960 and in the SR review of PR #2548 — dated, attributed, and
 * re-runnable. It is deliberately not restated here: a comment cannot be
 * re-run, so a sentence naming a test or a diagnostic outlives the thing it
 * names.
 */

import { dbGet, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
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
 *
 * @returns a promise resolving to the cached row, or to null if none exists
 *          (⇒ the caller treats null as LOCKED). MUST be awaited: the resolved
 *          null is the LOCKED signal, and the unawaited promise is truthy.
 *
 * @example
 *   const cached = await getCachedUnlock(localTransactionId, userId);
 *   if (cached) { ... }
 */
export function getCachedUnlock(
  localTransactionId: string,
  userId: string,
): Promise<CachedUnlock | null> {
  const row = dbGet<CachedUnlock>(
    sql`SELECT local_transaction_id, user_id, unlocked_at, funding_source, cached_at
       FROM transaction_unlocks_cache
      WHERE local_transaction_id = ? AND user_id = ?`,
    [localTransactionId, userId],
  );
  return Promise.resolve(row ?? null);
}

/**
 * Write/refresh a cache mirror of a CONFIRMED server unlock.
 *
 * MUST only be called after a live server read has confirmed a non-refunded
 * `transaction_unlocks` row for this (transaction, user). Passing an unverified
 * value here would violate the cache-is-a-mirror invariant.
 *
 * @example
 *   await upsertUnlock({ localTransactionId, userId, unlockedAt, fundingSource });
 */
export function upsertUnlock(params: {
  localTransactionId: string;
  userId: string;
  unlockedAt: string;
  fundingSource?: string | null;
}): Promise<void> {
  dbRun(
    sql`INSERT INTO transaction_unlocks_cache
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
  return Promise.resolve();
}

/**
 * Remove a cache mirror. Called when a live server read shows the unlock is
 * GONE or REFUNDED — so the offline view re-locks, matching server truth.
 *
 * @example
 *   await removeCachedUnlock(localTransactionId, userId);
 */
export function removeCachedUnlock(
  localTransactionId: string,
  userId: string,
): Promise<void> {
  dbRun(
    sql`DELETE FROM transaction_unlocks_cache
      WHERE local_transaction_id = ? AND user_id = ?`,
    [localTransactionId, userId],
  );
  return Promise.resolve();
}

/**
 * Clear all cached unlocks (call on logout, mirroring feature-gate cache clear).
 *
 * @example
 *   await clearUnlockCache();
 */
export function clearUnlockCache(): Promise<void> {
  dbRun(sql`DELETE FROM transaction_unlocks_cache`, []);
  void logService.info(
    "[UnlockCache] Cleared all cached unlocks",
    "UnlockCacheDbService",
  );
  return Promise.resolve();
}
