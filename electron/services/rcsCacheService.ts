/**
 * Google Messages for Web cache job — BACKLOG-3658 (cache phase P1).
 *
 * The cache keeps the last ~2 months of EVERY chat in Keepr's own message store
 * (keyed and stored like a transaction Sync, BACKLOG-3630), and the existing
 * phone-number auto-link then attaches chats to transactions — the iPhone and
 * Android sources' model. This module is the pure part of the Keepr side:
 * where a cache Sync starts from, who may start one, and what happens when it
 * ends. Dependencies are injected so jest runs it without Electron or SQLite.
 */

/** How far back a first cache Sync reaches. */
export const RCS_CACHE_WINDOW_DAYS = 60;
/** A later cache Sync starts this long before the last finished one (overlap; dedup absorbs it). */
export const RCS_CACHE_OVERLAP_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The cache Sync's history floor: max(now − 60 days, last finished − 1 day).
 * A missing or unparseable last-finished time means a full 60-day run.
 */
export function cacheSince(nowMs: number, lastFinishedAt: string | null | undefined): string {
  const windowStart = nowMs - RCS_CACHE_WINDOW_DAYS * DAY_MS;
  const last = lastFinishedAt ? Date.parse(lastFinishedAt) : NaN;
  const since = Number.isFinite(last) ? Math.max(windowStart, last - RCS_CACHE_OVERLAP_DAYS * DAY_MS) : windowStart;
  return new Date(since).toISOString();
}

export interface CacheStartRefusal {
  status: number;
  error: string;
  message: string;
}

/**
 * Who may start a cache Sync (from Keepr or from the page's button): a
 * signed-in user who opted in (local), while no Sync runs and no Force
 * re-import is clearing texts.
 */
export function decideCacheStart(input: {
  userId: string | null;
  optedIn: boolean;
  activeLabel: string | null | undefined;
  writesPaused: boolean;
}): { ok: true; userId: string } | CacheStartRefusal {
  if (!input.userId) {
    return { status: 403, error: "signed_out", message: "Sign in to Keepr first." };
  }
  if (!input.optedIn) {
    return { status: 403, error: "not_opted_in", message: "Turn on Google Messages sync in Keepr first." };
  }
  if (input.writesPaused) {
    return { status: 503, error: "busy", message: "Keepr is clearing imported texts. Try again in a moment." };
  }
  if (input.activeLabel !== undefined && input.activeLabel !== null) {
    return {
      status: 409,
      error: "already_syncing",
      message: `Keepr is already syncing${input.activeLabel ? `: ${input.activeLabel}` : ""}. Wait for it to finish, or cancel it.`,
    };
  }
  return { ok: true, userId: input.userId };
}

/** BACKLOG-3658: an extension report is written to the database at most once a minute per user. */
export const RCS_HELLO_PERSIST_MS = 60_000;

export function shouldPersistHello(lastPersistedMs: number | undefined, nowMs: number): boolean {
  return lastPersistedMs === undefined || nowMs - lastPersistedMs >= RCS_HELLO_PERSIST_MS;
}

export interface CacheJobEndedDeps {
  saveFinishedAt: (userId: string, iso: string) => void;
  saveOwnNumber: (userId: string, number: string) => void;
  autoLink: (userId: string) => Promise<unknown>;
  now: () => number;
  log?: (message: string) => void;
}

/**
 * After a cache Sync ends: its start time is saved ONLY on success (the next
 * run then overlaps it by a day); a detected own number (3+ chats agreed) is
 * kept for the next run; and the phone auto-link runs for THAT user whatever
 * the outcome — chats stored before a cancel or an error still get linked.
 */
export async function handleCacheJobEnded(
  ended: {
    kind: string;
    userId: string | null;
    snapshot: { state: string; createdAt?: string };
    detectedOwnNumber: string | null;
  },
  deps: CacheJobEndedDeps,
): Promise<void> {
  if (ended.kind !== "cache" || !ended.userId) return;
  const userId = ended.userId;
  // The job's START time (SR): chats that changed while it ran are re-read
  // next time (since = this − 1 day anyway).
  if (ended.snapshot.state === "finished") {
    deps.saveFinishedAt(userId, ended.snapshot.createdAt ?? new Date(deps.now()).toISOString());
  }
  if (ended.detectedOwnNumber) deps.saveOwnNumber(userId, ended.detectedOwnNumber);
  try {
    await deps.autoLink(userId);
  } catch (err) {
    deps.log?.(`[RcsCache] Auto-link after the cache Sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * BACKLOG-3658: a running Sync belongs to the user who started it. Signing out
 * cancels it; another user signing in cancels it; a refresh for the same user
 * (or a job of no user) keeps it.
 */
export function cancelOnSessionChange(
  change: { kind: "saved" | "cleared"; userId: string | null },
  activeJobUserId: string | null,
  hasActiveJob: boolean,
): boolean {
  if (!hasActiveJob) return false;
  if (change.kind === "cleared") return true;
  return !!activeJobUserId && !!change.userId && activeJobUserId !== change.userId;
}
