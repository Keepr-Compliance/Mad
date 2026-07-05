// ============================================
// EMAIL SYNC STATE SERVICE (BACKLOG-1802, Lifecycle T2)
//
// Per-account state for the email lifecycle. Reads/writes the `email_sync_state`
// table created by the T1 foundation migration (BACKLOG-1801 / v46). This is
// deliberately NOT the T3 `emailCacheService` — that service is the sole writer
// to the `emails`/`email_participants` tables. `email_sync_state` is a different
// table (per-account cursor/phase/bounds), so owning it here does not cross the
// design §3 boundary.
//
// What it powers in T2:
//   - Durable per-account cache bounds (newest_cached_at / oldest_cached_at) so
//     the "is this transaction's window already satisfied?" question is answered
//     from a durable watermark, not a full-table MAX(sent_at) scan.
//   - The once-only backfill rule: once oldest_cached_at reaches back far enough,
//     any transaction whose window starts at/after it needs no further backfill.
//   - phase / failure_count / last_error for per-account health (design §3, item 6).
// ============================================

import { dbGet, dbRun } from "./core/dbConnection";
import logService from "../logService";

/** oauth_tokens.provider values that own a mailbox. */
export type MailboxProvider = "google" | "microsoft";

export interface EmailSyncStateRow {
  user_id: string;
  account_id: string;
  provider: MailboxProvider;
  phase: "active" | "cleared" | "invalid";
  cursor: string | null;
  newest_cached_at: string | null;
  oldest_cached_at: string | null;
  last_reconciled_at: string | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

/** Later of two ISO timestamps; NULL means "no bound", so the other wins. */
function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Earlier of two ISO timestamps; NULL means "no bound", so the other wins. */
function minIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/**
 * Resolve the per-account identity (oauth_tokens.id) for a user's connected
 * mailbox of the given provider. Returns null when no mailbox is connected for
 * that provider (matches the migration's account_id backfill fallback). The
 * oauth_tokens UNIQUE(user_id, provider, purpose) guarantees at most one row.
 */
export function resolveMailboxAccountId(
  userId: string,
  provider: MailboxProvider,
): string | null {
  const row = dbGet<{ id: string }>(
    "SELECT id FROM oauth_tokens WHERE user_id = ? AND provider = ? AND purpose = 'mailbox' LIMIT 1",
    [userId, provider],
  );
  return row?.id ?? null;
}

/** Read the per-account sync state row, if it exists. */
export function getSyncState(userId: string, accountId: string): EmailSyncStateRow | undefined {
  return dbGet<EmailSyncStateRow>(
    "SELECT * FROM email_sync_state WHERE user_id = ? AND account_id = ?",
    [userId, accountId],
  );
}

/**
 * Ensure a row exists for (user, account). Idempotent — never resurrects a row
 * that a Clear action set to phase='cleared'/'invalid' (INSERT OR IGNORE leaves
 * an existing phase untouched).
 */
export function ensureSyncStateRow(
  userId: string,
  accountId: string,
  provider: MailboxProvider,
): void {
  dbRun(
    `INSERT OR IGNORE INTO email_sync_state (user_id, account_id, provider)
     VALUES (?, ?, ?)`,
    [userId, accountId, provider],
  );
}

/**
 * Extend the per-account cached bounds. Bounds only ever GROW: newest advances
 * forward, oldest advances backward. Passing a value that would shrink a bound is
 * a no-op for that bound. This is what makes the once-only backfill rule hold —
 * once oldest_cached_at is pushed back to cover a window, it stays covered.
 */
export function updateCachedBounds(
  userId: string,
  accountId: string,
  provider: MailboxProvider,
  bounds: { newest?: string | null; oldest?: string | null },
): void {
  const existing = getSyncState(userId, accountId);
  const newest = maxIso(existing?.newest_cached_at, bounds.newest);
  const oldest = minIso(existing?.oldest_cached_at, bounds.oldest);

  if (existing) {
    dbRun(
      `UPDATE email_sync_state
         SET newest_cached_at = ?, oldest_cached_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND account_id = ?`,
      [newest, oldest, userId, accountId],
    );
  } else {
    dbRun(
      `INSERT INTO email_sync_state (user_id, account_id, provider, newest_cached_at, oldest_cached_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, accountId, provider, newest, oldest],
    );
  }
}

/** Record a successful sync: clear the error and reset the failure counter. */
export function recordSyncSuccess(
  userId: string,
  accountId: string,
  provider: MailboxProvider,
): void {
  ensureSyncStateRow(userId, accountId, provider);
  dbRun(
    `UPDATE email_sync_state
       SET last_error = NULL, failure_count = 0, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND account_id = ?`,
    [userId, accountId],
  );
}

/** Record a sync failure: store the message and increment the failure counter. */
export function recordSyncFailure(
  userId: string,
  accountId: string,
  provider: MailboxProvider,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  ensureSyncStateRow(userId, accountId, provider);
  dbRun(
    `UPDATE email_sync_state
       SET last_error = ?, failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND account_id = ?`,
    [message.slice(0, 500), userId, accountId],
  );
  logService.warn("[BACKLOG-1802] email_sync_state failure recorded", "EmailSyncState", {
    accountId,
    provider,
    error: message.slice(0, 200),
  });
}
