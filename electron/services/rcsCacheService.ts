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

import type { CacheLimits } from "./rcsCacheStaging";

/** How far back a first cache Sync reaches when no floor is given (tests; the app passes the user's setting). */
export const RCS_CACHE_WINDOW_DAYS = 60;
/** A later cache Sync starts this long before the last finished one (overlap; dedup absorbs it). */
export const RCS_CACHE_OVERLAP_DAYS = 1;
/** "All time" and the dev override reach back at most this far (the list is capped anyway). */
export const RCS_CACHE_MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Apple epoch (2001-01-01T00:00:00Z) in Unix ms: the import plan's spans are Apple-epoch nanoseconds. */
const APPLE_EPOCH_MS = 978_307_200_000;
const NANOS_PER_MS = 1_000_000;

/**
 * The cache Sync's history floor: max(floor, last finished − 1 day). The
 * floor is the user's months setting (default: now − 60 days, for callers
 * without one). A missing or unparseable last-finished time means a full run.
 */
export function cacheSince(
  nowMs: number,
  lastFinishedAt: string | null | undefined,
  floorMs: number = nowMs - RCS_CACHE_WINDOW_DAYS * DAY_MS,
): string {
  const last = lastFinishedAt ? Date.parse(lastFinishedAt) : NaN;
  const since = Number.isFinite(last) ? Math.max(floorMs, last - RCS_CACHE_OVERLAP_DAYS * DAY_MS) : floorMs;
  return new Date(since).toISOString();
}

/** The dev-only window override: whole days, 1..3650; anything else → null (no override). */
export function clampSinceDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(RCS_CACHE_MAX_DAYS, Math.max(1, Math.round(value)));
}

/** The import plan's answer, as the cache needs it (importPlan.ImportPlan). */
export interface CachePlanInput {
  /** The months setting's lower bound, widened for deal audit periods; null = All time. */
  fetchStartISO: string | null;
  /** Max messages outside protected spans; null = Unlimited. */
  effectiveCap: number | null;
  /** Deal audit periods (Apple-epoch nanoseconds). */
  protectedSpans: ReadonlyArray<{ startNano: number; endNano: number | null }>;
}

/**
 * BACKLOG-3658: a cache Sync's window and limits, from the SAME settings as
 * every other message source (resolveImportPlanForUser):
 *
 *  - floor = the months setting (All time → 3650 days);
 *  - the page's `since` = max(floor, last finished − 1 day) — incremental;
 *  - NO max-messages cap for this source (founder, 2026-10-01: a total cap
 *    comes later): the plan's `effectiveCap` is NOT applied. The date
 *    floor alone limits the cache (the audit periods still widen it).
 *
 * DEV ONLY: `sinceDays` (1..3650) replaces the floor AND skips the
 * incremental rule — to test a longer window — but only when the build is
 * NOT packaged. A packaged build ignores it.
 */
export function cacheWindow(input: {
  nowMs: number;
  lastFinishedAt: string | null | undefined;
  plan: CachePlanInput;
  sinceDays?: unknown;
  isPackaged: boolean;
}): { since: string; limits: CacheLimits; devOverrideDays: number | null } {
  const oldest = input.nowMs - RCS_CACHE_MAX_DAYS * DAY_MS;
  const devOverrideDays = input.isPackaged ? null : clampSinceDays(input.sinceDays);
  let floorMs: number;
  if (devOverrideDays !== null) {
    floorMs = input.nowMs - devOverrideDays * DAY_MS;
  } else {
    const planStart = input.plan.fetchStartISO ? Date.parse(input.plan.fetchStartISO) : NaN;
    floorMs = Number.isFinite(planStart) ? Math.max(oldest, planStart) : oldest;
  }
  const since = devOverrideDays !== null
    ? new Date(floorMs).toISOString()
    : cacheSince(input.nowMs, input.lastFinishedAt, floorMs);
  const protectedSpans = input.plan.protectedSpans.map((s) => ({
    startMs: APPLE_EPOCH_MS + s.startNano / NANOS_PER_MS,
    endMs: s.endNano === null ? null : APPLE_EPOCH_MS + s.endNano / NANOS_PER_MS,
  }));
  // Date only: the max-messages setting does not apply to the cache (cap null).
  return { since, limits: { floorMs, cap: null, protectedSpans }, devOverrideDays };
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
  /** BACKLOG-3658 atomic import: the finished job's staging → messages, in one transaction. */
  commit: (jobId: string, userId: string) => Promise<unknown>;
  /** BACKLOG-3658: drop the job's staging (cancel / error / user switch). */
  discard: (jobId: string) => Promise<void>;
  autoLink: (userId: string) => Promise<unknown>;
  /** SR S1: the texts are saved and linked — open views may refetch now. */
  onSaved?: (userId: string) => void;
  now: () => number;
  log?: (message: string) => void;
}

/**
 * After a cache Sync ends (BACKLOG-3658, atomic):
 *  - FINISHED: the staged chats are committed (one transaction, within the
 *    user's limits); only then is the job's start time saved (the next run
 *    overlaps it by a day) and the phone auto-link run for THAT user. A failed
 *    commit saves nothing and links nothing; the staging is gone either way.
 *  - cancelled / failed (incl. a user switch): the staging is discarded —
 *    nothing was written, so there is nothing to link.
 * A detected own number (3+ chats agreed) is kept for the next run either way.
 */
export async function handleCacheJobEnded(
  ended: {
    kind: string;
    userId: string | null;
    snapshot: { state: string; createdAt?: string; jobId: string };
    detectedOwnNumber: string | null;
  },
  deps: CacheJobEndedDeps,
): Promise<void> {
  if (ended.kind !== "cache" || !ended.userId) return;
  const userId = ended.userId;
  const jobId = ended.snapshot.jobId;
  if (ended.detectedOwnNumber) deps.saveOwnNumber(userId, ended.detectedOwnNumber);
  if (ended.snapshot.state !== "finished") {
    try {
      await deps.discard(jobId);
    } catch (err) {
      deps.log?.(`[RcsCache] Discarding the cache Sync's staging failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  try {
    await deps.commit(jobId, userId);
  } catch (err) {
    deps.log?.(`[RcsCache] The cache Sync could not be saved; nothing was imported: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // The job's START time (SR): chats that changed while it ran are re-read
  // next time (since = this − 1 day anyway).
  deps.saveFinishedAt(userId, ended.snapshot.createdAt ?? new Date(deps.now()).toISOString());
  try {
    await deps.autoLink(userId);
  } catch (err) {
    deps.log?.(`[RcsCache] Auto-link after the cache Sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Even when the auto-link failed, the saved texts are new to open views.
  deps.onSaved?.(userId);
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
