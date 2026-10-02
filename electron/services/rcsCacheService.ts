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

import type { CacheCommitResult, CacheLimits } from "./rcsCacheStaging";
import type { RcsCacheSaved } from "./rcsImportJob";

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
  /**
   * BACKLOG-3663: how far back the cache is known to reach (a run that read
   * down to its floor). When the floor is now EARLIER (the months setting or
   * a deal's audit period widened) — or no run reached its floor yet — the
   * page reads down to the floor again ("Reading older texts…").
   */
  coveredSince?: string | null;
}): { since: string; limits: CacheLimits; devOverrideDays: number | null; readingOlder: boolean } {
  const oldest = input.nowMs - RCS_CACHE_MAX_DAYS * DAY_MS;
  const devOverrideDays = input.isPackaged ? null : clampSinceDays(input.sinceDays);
  let floorMs: number;
  if (devOverrideDays !== null) {
    floorMs = input.nowMs - devOverrideDays * DAY_MS;
  } else {
    const planStart = input.plan.fetchStartISO ? Date.parse(input.plan.fetchStartISO) : NaN;
    floorMs = Number.isFinite(planStart) ? Math.max(oldest, planStart) : oldest;
  }
  const covered = input.coveredSince ? Date.parse(input.coveredSince) : NaN;
  const hadRun = !!input.lastFinishedAt && Number.isFinite(Date.parse(input.lastFinishedAt));
  // A previous run, and the floor is now older than what is covered.
  // L2 (live): an UNKNOWN coverage (NULL) no longer forces a full read — with
  // any not-settled chat it stayed NULL, and every Sync re-read everything.
  const readingOlder = devOverrideDays === null && hadRun && Number.isFinite(covered) && floorMs < covered;
  const since = devOverrideDays !== null || readingOlder
    ? new Date(floorMs).toISOString()
    : cacheSince(input.nowMs, input.lastFinishedAt, floorMs);
  const protectedSpans = input.plan.protectedSpans.map((s) => ({
    startMs: APPLE_EPOCH_MS + s.startNano / NANOS_PER_MS,
    endMs: s.endNano === null ? null : APPLE_EPOCH_MS + s.endNano / NANOS_PER_MS,
  }));
  // Date only: the max-messages setting does not apply to the cache (cap null).
  return { since, limits: { floorMs, cap: null, protectedSpans }, devOverrideDays, readingOlder };
}

export interface CacheStartRefusal {
  status: number;
  error: string;
  message: string;
}

/**
 * BACKLOG-3658 P3b: the consent text's version. Raising it (the copy or the
 * practice changed) makes every user consent again before their NEXT cache
 * Sync; a Sync already running is not stopped.
 */
export const RCS_CONSENT_VERSION = 1;

/** The user's consent is current. */
export function consentIsCurrent(consentVersion: number | null | undefined): boolean {
  return typeof consentVersion === "number" && consentVersion >= RCS_CONSENT_VERSION;
}

/**
 * What the done screens show for a cache Sync (founder, 2026-10-01): what
 * Keepr SAVED, not what the page staged. A chat whose messages were all below
 * the floor stores nothing and is not counted (the commit skips it).
 */
export function cacheSavedFromCommit(r: CacheCommitResult): RcsCacheSaved {
  // Live (0.3.18): "0 reactions" while 52 were sent — only NEW rows were
  // counted. Reactions read like messages now: all saved, then how many new.
  return {
    chats: r.chats, messages: r.stored + r.alreadyPresent, newMessages: r.stored,
    reactions: r.reactionsKept ?? r.reactions, newReactions: r.reactions,
  };
}

/**
 * Founder decision (2026-10-01): no separate consent screen — users accept
 * Keepr's terms at sign-up, and the Sync screen says in one line what is
 * copied. While false, a cache Sync is not refused for a missing consent; the
 * first Sync records consent_at + the version for audit instead. Set true to
 * bring the gate back (the rcs_consent plumbing is kept for that).
 */
export const RCS_CONSENT_REQUIRED = false;

/**
 * The consent version a starting cache Sync records for audit while the
 * consent screen is off: the current version when the record is not current
 * yet, else null (nothing to record).
 */
export function consentToRecordOnSync(
  consentVersion: number | null | undefined,
  consentRequired: boolean = RCS_CONSENT_REQUIRED,
): number | null {
  if (consentRequired) return null;
  return consentIsCurrent(consentVersion) ? null : RCS_CONSENT_VERSION;
}

/**
 * Who may start a cache Sync: a signed-in user (whose consent, Keepr's
 * record, is current — only while RCS_CONSENT_REQUIRED), while no Sync runs
 * and no Force re-import is clearing texts. A per-transaction Sync does not
 * need it.
 */
export function decideCacheStart(input: {
  userId: string | null;
  consentVersion: number | null | undefined;
  activeLabel: string | null | undefined;
  writesPaused: boolean;
  /** Test seam: defaults to RCS_CONSENT_REQUIRED. */
  consentRequired?: boolean;
}): { ok: true; userId: string } | CacheStartRefusal {
  if (!input.userId) {
    return { status: 403, error: "signed_out", message: "Sign in to Keepr first." };
  }
  if ((input.consentRequired ?? RCS_CONSENT_REQUIRED) && !consentIsCurrent(input.consentVersion)) {
    return {
      status: 403,
      error: "consent_needed",
      message: "Review what Keepr copies from Google Messages and agree first (Dashboard → Sync Android).",
    };
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

/**
 * Founder (2026-10-01): when a Sync ends done or failed, Keepr comes to the
 * front by itself; a cancel (from Keepr, the page, or a user switch) does not.
 */
export function shouldFocusKeeprOnJobEnd(state: string): boolean {
  return state === "finished" || state === "failed";
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
  commit: (jobId: string, userId: string, snapshot: CacheEndSnapshot) => Promise<unknown>;
  /** BACKLOG-3658: drop the job's staging (cancel / error / user switch); the staging rows dropped. */
  discard: (jobId: string) => Promise<number | void>;
  autoLink: (userId: string) => Promise<unknown>;
  /** P3b: after the auto-link (the optional auto-delete). Errors are logged. */
  afterLink?: (userId: string) => Promise<void>;
  /** SR S1: the texts are saved and linked — open views may refetch now. */
  onSaved?: (userId: string) => void;
  now: () => number;
  log?: (message: string) => void;
  /** An INFO line (e.g. a cancel), where `log` is for problems. */
  info?: (message: string) => void;
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
/** What the end of a cache job tells (the job snapshot's relevant part). */
export interface CacheEndSnapshot {
  state: string;
  createdAt?: string;
  jobId: string;
  progress?: { notChecked?: number; imported?: number };
  notReached?: Array<{ reason: string; name?: string }>;
  notReachedMore?: number;
  /** L2: how the page's list scan stopped (since | stable | max_items | max_time). */
  listStop?: string;
}

/**
 * Reasons a chat's history was NOT read down to the floor and the run's
 * coverage must not be recorded. history_not_settled is NOT one (L2): those
 * chats are counted (not_settled_chats) and shown ("N chats may be
 * incomplete") instead of blocking the coverage forever.
 */
const HISTORY_SHORT_REASONS = new Set(["history_truncated", "history_gap", "messages_not_loaded", "not_opened", "error"]);

/** A list scan that ended normally: at `since`, or the list stopped growing (not a cap or a timeout). */
export function isNormalListStop(listStop: string | null | undefined): boolean {
  return listStop === "since" || listStop === "stable";
}

/** L2: what a finished cache run says about the coverage. */
export function cacheRunCoverage(fullRead: boolean, snapshot: CacheEndSnapshot): { reached: boolean; notSettledChats: number } {
  const notSettled = new Set((snapshot.notReached ?? []).filter((e) => e.reason === "history_not_settled").map((e) => e.name ?? ""));
  return { reached: cacheRunReachedFloor(fullRead, snapshot), notSettledChats: notSettled.size };
}

/**
 * L2: the coverage to backfill when none is recorded — the previous run's
 * floor, ONLY if that run was a full read that finished with a normal list
 * stop (not a cap or a timeout) and reached its floor.
 */
export function backfillCoverageFrom(run: { floorISO: string; fullRead: boolean; listStop: string | null; reachedFloor: boolean } | null): string | null {
  if (!run || !run.fullRead || !run.reachedFloor || !isNormalListStop(run.listStop)) return null;
  return Number.isFinite(Date.parse(run.floorISO)) ? run.floorISO : null;
}

/**
 * BACKLOG-3663: did this cache run read down to its floor? Only a FULL read
 * (since = floor) that checked every listed chat (none over the cap) and
 * read every chat's history (no truncated / failed one) counts — then the
 * Google Messages coverage reaches the floor.
 */
export function cacheRunReachedFloor(fullRead: boolean, snapshot: CacheEndSnapshot): boolean {
  if (!fullRead || snapshot.state !== "finished") return false;
  if (!isNormalListStop(snapshot.listStop)) return false;
  if ((snapshot.progress?.notChecked ?? 0) > 0) return false;
  if ((snapshot.notReachedMore ?? 0) > 0) return false;
  return !(snapshot.notReached ?? []).some((e) => HISTORY_SHORT_REASONS.has(e.reason));
}

export async function handleCacheJobEnded(
  ended: {
    kind: string;
    userId: string | null;
    snapshot: CacheEndSnapshot;
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
      const discarded = await deps.discard(jobId);
      // A cancel used to leave no log line at all.
      if (ended.snapshot.state === "cancelled") {
        deps.info?.(
          `[RcsCache] Sync cancelled (job kind ${ended.kind}): ${ended.snapshot.progress?.imported ?? 0} chats done so far, ` +
            `${typeof discarded === "number" ? discarded : 0} staging rows discarded`,
        );
      }
    } catch (err) {
      deps.log?.(`[RcsCache] Discarding the cache Sync's staging failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  try {
    await deps.commit(jobId, userId, ended.snapshot);
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
  if (deps.afterLink) {
    try {
      await deps.afterLink(userId);
    } catch (err) {
      deps.log?.(`[RcsCache] After the auto-link: ${err instanceof Error ? err.message : String(err)}`);
    }
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
