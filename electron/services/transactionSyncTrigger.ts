// ============================================
// TRANSACTION EMAIL AUTO-SYNC TRIGGER (BACKLOG-1802, Lifecycle T2)
//
// "The user shouldn't be the one remembering to sync." (founder policy)
//
// A single entry point — ensureTransactionEmailsSynced — that every lifecycle
// event routes through so a transaction's full audit-window email set is fetched
// AUTOMATICALLY, never on a button click:
//   - CREATE  : fresh transaction → sweep its window.
//   - OPEN    : viewing a transaction → top up if stale (throttled).
//   - EXPORT  : awaited backstop before an audit artifact is produced.
//   - DATE-CHANGE : audit dates moved → backfill/forward-fill only the delta.
//   - SCAN    : after detection, sweep every detected transaction's window.
//
// This is a LEAF consumer of both transactionService and emailSyncService (both
// of which already reference each other), so it introduces no import cycle. It
// owns the *policy* (throttle, window planning, backfill-once); the actual
// fetch + store + auto-link is delegated to emailSyncService.syncTransactionEmails
// with an explicit delta window.
//
// Why account-level bounds are a valid completeness watermark (design R3):
// syncTransactionEmails performs a WHOLE-MAILBOX folder/label sweep of the window
// (searchAllFolders / searchAllLabels, no contact filter), not just a per-contact
// fetch. So once email_sync_state records [oldest, newest] for an account, every
// message in that window is genuinely cached — a later transaction whose window
// falls inside it finds its mail in the local cache without re-fetching.
// ============================================

import * as Sentry from "@sentry/electron/main";
import transactionService from "./transactionService";
import emailSyncService, { EMAIL_CACHE_FRESHNESS_MS } from "./emailSyncService";
import { autoLinkCommunicationsForContact } from "./autoLinkService";
import logService from "./logService";
import { computeTransactionDateRange, DEFAULT_BUFFER_DAYS } from "../utils/emailDateRange";
import { getEmailsByContactId } from "./db/contactDbService";
import {
  resolveMailboxAccountId,
  getSyncState,
  updateCachedBounds,
  recordSyncSuccess,
  recordSyncFailure,
  type MailboxProvider,
  type EmailSyncStateRow,
} from "./db/emailSyncStateService";

export type SyncTriggerReason = "create" | "open" | "export" | "date-change" | "scan";

/**
 * Per-transaction in-memory throttle. Prevents an open/create/scan trigger from
 * refetching the same transaction within EMAIL_CACHE_FRESHNESS_MS. In-memory is
 * intentional: the guard only needs to stop refetch "within minutes"; a restart
 * that clears it just means the next open re-syncs, which is harmless (and, for
 * completeness, desirable).
 */
const lastSyncAt = new Map<string, number>();

/** Reasons that must reflect the very latest state and so bypass the throttle. */
const BYPASS_THROTTLE: ReadonlySet<SyncTriggerReason> = new Set(["export", "date-change"]);

const BUFFER_MS = DEFAULT_BUFFER_DAYS * 24 * 60 * 60 * 1000;

export interface EnsureSyncResult {
  ran: boolean;
  reason: SyncTriggerReason;
  skipped?: "throttled" | "not_found" | "no_provider" | "covered";
  windowsFetched?: number;
  error?: string;
}

interface AccountPlan {
  provider: MailboxProvider;
  accountId: string;
  state: EmailSyncStateRow | undefined;
}

/**
 * Plan the minimal set of fetch windows across all connected accounts.
 *
 * - If ANY account has never synced (no durable bounds) → one full-window sweep
 *   [reqStart, reqEnd]. This is the fresh-install 69/69 path.
 * - Otherwise plan up to two deltas across the LEAST-covered account:
 *     forward-fill (minNewest .. reqEnd]  when new mail may exist past the cache;
 *     backfill     [reqStart .. maxOldest) when the window predates the cache.
 *   Delta bounds are padded by DEFAULT_BUFFER_DAYS to absorb sent/received date
 *   skew (design R2); the app-layer dedup collapses the overlap.
 * - Empty result ⇒ the whole-mailbox cache already covers this window.
 */
export function planFetchWindows(
  accounts: AccountPlan[],
  reqStart: Date,
  reqEnd: Date,
): Array<{ after: Date; before: Date }> {
  const boundedTimes = accounts
    .map((a) => {
      const newest = a.state?.newest_cached_at;
      const oldest = a.state?.oldest_cached_at;
      return newest && oldest
        ? { newest: new Date(newest).getTime(), oldest: new Date(oldest).getTime() }
        : null;
    })
    .filter((x): x is { newest: number; oldest: number } => x !== null);

  // At least one account has no durable coverage yet → sweep the full window once.
  if (boundedTimes.length < accounts.length) {
    return [{ after: reqStart, before: reqEnd }];
  }

  const minNewest = Math.min(...boundedTimes.map((b) => b.newest));
  const maxOldest = Math.max(...boundedTimes.map((b) => b.oldest));

  const windows: Array<{ after: Date; before: Date }> = [];

  // Forward-fill: audit window extends past what's cached (new mail / moved end).
  if (reqEnd.getTime() > minNewest) {
    windows.push({ after: new Date(minNewest - BUFFER_MS), before: reqEnd });
  }
  // Backfill-older: audit window predates the oldest cached email (once-only —
  // extend-only bounds make the next call skip this).
  if (reqStart.getTime() < maxOldest) {
    windows.push({ after: reqStart, before: new Date(maxOldest + BUFFER_MS) });
  }

  return windows;
}

/**
 * Ensure a transaction's emails are fetched for its full audit window, firing an
 * automatic per-transaction sync only when needed. Never throws — auto-sync must
 * not break the create/open/export UX; failures are logged + reported and the
 * per-account failure counter is bumped.
 */
export async function ensureTransactionEmailsSynced(params: {
  transactionId: string;
  userId?: string;
  reason: SyncTriggerReason;
}): Promise<EnsureSyncResult> {
  const { transactionId, reason } = params;

  let accounts: AccountPlan[] = [];
  let userId = params.userId ?? "";
  try {
    // 1. Throttle gate FIRST — before any provider call (design R6).
    if (!BYPASS_THROTTLE.has(reason)) {
      const last = lastSyncAt.get(transactionId);
      if (last && Date.now() - last < EMAIL_CACHE_FRESHNESS_MS) {
        return { ran: false, reason, skipped: "throttled" };
      }
    }

    // 2. Load transaction + its contact assignments (service getter yields exactly
    //    the shape syncTransactionEmails consumes). Leaf consumer → no cycle.
    const details = await transactionService.getTransactionWithContacts(transactionId);
    if (!details) return { ran: false, reason, skipped: "not_found" };
    userId = params.userId ?? details.user_id;
    const contactAssignments = details.contact_assignments ?? [];

    // 3. Assemble contact emails (mirrors the manual sync handler).
    const contactEmails: string[] = [];
    for (const assignment of contactAssignments) {
      for (const email of getEmailsByContactId(assignment.contact_id)) {
        const lower = email?.toLowerCase();
        if (lower && !contactEmails.includes(lower)) contactEmails.push(lower);
      }
    }

    // 4. Required audit window (single source of truth — kills the blind
    //    precache/first-scan ceilings for the per-transaction path).
    const { start: reqStart, end: reqEnd } = computeTransactionDateRange(details);

    // 5. Connected mailbox accounts + durable coverage bounds.
    accounts = (["microsoft", "google"] as MailboxProvider[])
      .map((provider) => {
        const accountId = resolveMailboxAccountId(userId, provider);
        return accountId ? { provider, accountId, state: getSyncState(userId, accountId) } : null;
      })
      .filter((a): a is AccountPlan => a !== null);

    if (accounts.length === 0) return { ran: false, reason, skipped: "no_provider" };

    // 6. Plan the delta windows.
    const windows = planFetchWindows(accounts, reqStart, reqEnd);

    if (windows.length === 0) {
      // Whole-mailbox cache already covers this window. No fetch — but re-run
      // auto-link so a transaction whose window a PRIOR sync already swept still
      // links its (already-cached) emails. This is the design-R3 completeness
      // guarantee for cross-transaction coverage, and the export backstop.
      for (const assignment of contactAssignments) {
        try {
          await autoLinkCommunicationsForContact({ contactId: assignment.contact_id, transactionId });
        } catch (linkError) {
          logService.warn("[BACKLOG-1802] auto-link (covered path) failed", "TxnSyncTrigger", {
            contactId: assignment.contact_id,
            error: linkError instanceof Error ? linkError.message : "Unknown",
          });
        }
      }
      lastSyncAt.set(transactionId, Date.now());
      return { ran: true, reason, skipped: "covered", windowsFetched: 0 };
    }

    // 7. Fetch each delta window (syncTransactionEmails fetches + stores + auto-links).
    for (const w of windows) {
      await emailSyncService.syncTransactionEmails({
        transactionId,
        userId,
        contactAssignments,
        contactEmails,
        transactionDetails: details,
        window: { after: w.after, before: w.before },
      });
    }

    // 8. Advance the durable per-account bounds to reflect the freshly-covered
    //    range (extend-only: newest grows forward, oldest grows backward).
    const unionAfter = new Date(Math.min(...windows.map((w) => w.after.getTime())));
    const unionBefore = new Date(Math.max(...windows.map((w) => w.before.getTime())));
    for (const acc of accounts) {
      updateCachedBounds(userId, acc.accountId, acc.provider, {
        newest: unionBefore.toISOString(),
        oldest: unionAfter.toISOString(),
      });
      recordSyncSuccess(userId, acc.accountId, acc.provider);
    }

    lastSyncAt.set(transactionId, Date.now());
    logService.info("[BACKLOG-1802] auto-sync completed", "TxnSyncTrigger", {
      transactionId,
      reason,
      windowsFetched: windows.length,
    });
    return { ran: true, reason, windowsFetched: windows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.warn("[BACKLOG-1802] auto-sync trigger failed (non-fatal)", "TxnSyncTrigger", {
      transactionId,
      reason,
      error: message,
    });
    Sentry.captureException(error, {
      tags: { component: "email_sync", operation: "ensureTransactionEmailsSynced", reason },
      level: "warning",
    });
    for (const acc of accounts) {
      try {
        recordSyncFailure(userId, acc.accountId, acc.provider, error);
      } catch {
        /* best-effort */
      }
    }
    return { ran: false, reason, error: message };
  }
}

/**
 * Fire-and-forget wrapper for the background triggers (create/open/scan). Never
 * rejects; swallows into the same non-fatal path so a background sync failure
 * cannot surface as an unhandled rejection in the handler.
 */
export function triggerTransactionSyncInBackground(params: {
  transactionId: string;
  userId?: string;
  reason: SyncTriggerReason;
}): void {
  void ensureTransactionEmailsSynced(params).catch((error) => {
    logService.warn("[BACKLOG-1802] background auto-sync rejected", "TxnSyncTrigger", {
      transactionId: params.transactionId,
      error: error instanceof Error ? error.message : "Unknown",
    });
  });
}

/**
 * Fire-and-forget batch trigger with BOUNDED CONCURRENCY. Used after a detection
 * scan, where a fresh install can surface many transactions at once. Launching N
 * simultaneous full-window Graph sweeps would risk a 429 storm (and the token-burn
 * class of incidents in CLAUDE.md), so we cap parallelism. Never blocks the caller.
 */
export function triggerBatchTransactionSyncInBackground(
  items: Array<{ transactionId: string; userId: string }>,
  reason: SyncTriggerReason,
  concurrency = 2,
): void {
  if (items.length === 0) return;
  void (async () => {
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        try {
          await ensureTransactionEmailsSynced({ ...item, reason });
        } catch (error) {
          logService.warn("[BACKLOG-1802] batch auto-sync item failed", "TxnSyncTrigger", {
            transactionId: item.transactionId,
            error: error instanceof Error ? error.message : "Unknown",
          });
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    );
    await Promise.all(workers);
  })();
}

/** Test seam: reset the in-memory throttle between test cases. */
export function __resetSyncThrottleForTests(): void {
  lastSyncAt.clear();
}
