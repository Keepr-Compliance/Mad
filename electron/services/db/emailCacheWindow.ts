// ============================================
// CACHED EMAIL WINDOW BOUNDS (BACKLOG-3056)
//
// The two ends of what a user already has cached locally, read in one pass:
//
//   newest -> the incremental high-water mark. `precacheEmails` starts an
//             ordinary run here so a re-cache does not re-download the window
//             it already holds.
//   oldest -> the floor of what is cached. When the user WIDENS the Email
//             History setting, `cacheSinceDate` drops below this value and the
//             span between them is mail the app has never fetched and — before
//             BACKLOG-3056 — never would have: the high-water clamp only ever
//             moves the fetch start forward, so widening the window changed
//             nothing and the run still reported success.
//
// Both ends come from ONE query because they are read at the same moment for
// the same decision, and two round trips could disagree if a write landed
// between them.
//
// WHY THIS LIVES IN `db/`
// The SQL-boundary rule (BACKLOG-2959) is that SQL TEXT is defined only under
// `electron/services/db/**`. The `MAX(sent_at)` half of this query was inlined
// in `emailSyncService.ts`; adding a second inline aggregate there would have
// deepened an existing exception. It moves here instead.
//
// NULL `sent_at` ROWS ARE INVISIBLE TO BOTH BOUNDS, by SQLite's aggregate rule
// (MIN/MAX skip NULLs). That is the behaviour we want: a row with no send time
// cannot tell us anything about where the cached window starts or ends, and
// letting one collapse `oldest` to NULL would silently disable the backfill.
// ============================================

import { dbGet } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface CachedEmailBounds {
  /** ISO timestamp of the OLDEST cached email, or null when nothing is cached. */
  oldest: string | null;
  /** ISO timestamp of the NEWEST cached email, or null when nothing is cached. */
  newest: string | null;
}

/**
 * Both bounds in one statement.
 *
 * Exported so its pin asserts the TEXT THIS MODULE EXECUTES rather than a copy
 * of it: a test holding its own duplicate of this SQL keeps passing after the
 * production string drifts. The `dbGet`-backed function binds through the
 * module singleton and is not drivable from the db/ suites, so the string is
 * the only honest seam — the same one `LATEST_SENT_AT_SQL` was pinned through
 * before BACKLOG-3056 subsumed it into this MIN/MAX pair.
 */
export const CACHED_EMAIL_SENT_AT_BOUNDS_SQL =
  sql`SELECT MIN(sent_at) as oldest, MAX(sent_at) as newest FROM emails WHERE user_id = ?`;

/**
 * The oldest and newest `sent_at` across a user's cached emails.
 *
 * Returns `{ oldest: null, newest: null }` for an empty cache — and also when
 * the caller's `dbGet` yields no row at all, which is why the row is treated as
 * optional rather than asserted: an aggregate always returns one row against a
 * real database, but a caller may be running against a stub.
 */
export function getCachedEmailSentAtBounds(userId: string): CachedEmailBounds {
  const row = dbGet<{ oldest: string | null; newest: string | null }>(
    CACHED_EMAIL_SENT_AT_BOUNDS_SQL,
    [userId],
  );
  return { oldest: row?.oldest ?? null, newest: row?.newest ?? null };
}
