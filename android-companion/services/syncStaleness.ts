/**
 * Sync freshness / staleness helpers (Android Companion).
 *
 * BACKLOG-2204: the companion's background sync can be silently killed by
 * Android Doze mode / OEM battery managers (Samsung, Xiaomi, ...), so SMS stop
 * flowing to the desktop while the phone is idle — with no visible signal. This
 * module turns the persisted "last successful sync" timestamp into a
 * user-facing freshness state so that silent background death becomes VISIBLE
 * (a stale banner on the home screen) instead of invisible.
 *
 * Pure + side-effect free so the threshold/age logic is trivially unit-tested.
 * The timestamp itself is produced by smsQueueService (`SyncStats
 * .lastSuccessfulSyncAt`), which is set whenever a sync cycle reaches the
 * desktop successfully — NOT only when messages happen to be sent, so an idle
 * "nothing new to sync" cycle still counts as fresh.
 */

/**
 * How long after the last successful sync we consider the companion "stale".
 *
 * The Android background-fetch floor is 15 minutes, so 3 hours is ~12 missed
 * cycles — unambiguous evidence that background sync has actually stalled
 * (Doze / battery optimisation) rather than a single skipped wake-up. Callers
 * may override via `thresholdMs` (e.g. for tests).
 */
export const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Coarse freshness state derived from the last successful sync time. */
export type SyncFreshnessStatus = 'never' | 'fresh' | 'stale';

export interface SyncFreshness {
  status: SyncFreshnessStatus;
  /** Age of the last successful sync in ms, or null if it never synced. */
  ageMs: number | null;
}

export interface SyncFreshnessOptions {
  /** Injectable clock (defaults to Date.now()) — keeps tests deterministic. */
  now?: number;
  /** Override the stale threshold (defaults to STALE_THRESHOLD_MS). */
  thresholdMs?: number;
}

/**
 * Classify how fresh the last successful sync is.
 *
 * - `never`: no successful sync on record (null / unparseable timestamp).
 * - `fresh`: last success is younger than the threshold.
 * - `stale`: last success is at or older than the threshold (>=, so the exact
 *   boundary is treated as stale — err on the side of surfacing a warning).
 *
 * @param lastSuccessfulSyncAt ISO timestamp of the last successful sync.
 */
export function getSyncFreshness(
  lastSuccessfulSyncAt: string | null | undefined,
  options: SyncFreshnessOptions = {},
): SyncFreshness {
  const { now = Date.now(), thresholdMs = STALE_THRESHOLD_MS } = options;

  if (!lastSuccessfulSyncAt) {
    return { status: 'never', ageMs: null };
  }

  const ts = new Date(lastSuccessfulSyncAt).getTime();
  if (Number.isNaN(ts)) {
    return { status: 'never', ageMs: null };
  }

  // Clamp negative ages (clock skew / future timestamp) to 0 so a slightly
  // future "last sync" never reads as stale.
  const ageMs = Math.max(0, now - ts);
  return {
    status: ageMs >= thresholdMs ? 'stale' : 'fresh',
    ageMs,
  };
}

/**
 * Format an ISO timestamp as a short relative string for the "Last Sync" row.
 *
 * Moved here from home.tsx (BACKLOG-2204) so the staleness surface and the
 * stats row share one tested implementation. Returns "Never" for a missing or
 * unparseable value.
 *
 * @param now injectable clock (defaults to Date.now()).
 */
export function formatRelativeTime(
  isoString: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!isoString) return 'Never';

  const date = new Date(isoString);
  const t = date.getTime();
  if (Number.isNaN(t)) return 'Never';

  const diffMs = Math.max(0, now - t);

  if (diffMs < 60_000) return 'Just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} hr ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
