/**
 * Sync Window (Android Companion) — BACKLOG-2800
 *
 * Makes the desktop's "Import messages from" setting GOVERN the Android sync.
 *
 * ## The defect this closes
 *
 * `AndroidMessagesSettings` shows an Import Filters card whose "Import messages
 * from" dropdown writes `messageImport.android.filters.lookbackMonths`. Nothing
 * on the Android path ever read it. A user who set "Last 3 months" to keep the
 * phone sync small got their entire history anyway — the setting was inert.
 *
 * Founder ruling (BACKLOG-2800, 2026-08-30): *"the determining factor should be
 * the date set in the keepr settings"* and *"this setting I think is saved per
 * user on supabase so the android app should be able to read it."*
 *
 * ## Why the phone can read it directly
 *
 * Desktop preferences are NOT a local store that is later synced — Supabase IS
 * the store. `preferences:save` validates, sanitizes and calls
 * `supabaseService.syncPreferences` directly, and `preferences:get` reads
 * `user_preferences.preferences` back (electron/services/supabaseService.ts
 * :1146 / :1176). So the row the panel writes is the row this module reads —
 * the same fact, not a copy of one.
 *
 * RLS allows exactly this and nothing more: `user_preferences_select_own` is
 * `auth.uid() = user_id`. The companion holds a real user session, and
 * `accountMatch.ts` already proves the phone is signed into the SAME account as
 * the desktop before pairing completes. No LAN protocol change, no desktop
 * change, no pairing-handshake extension.
 *
 * ## Why a SETTING may be cached when a CURSOR may not
 *
 * The LAN sync works with no internet at all, so reading Supabase on every
 * cycle would put a network dependency on a path that has none. A setting can
 * be fetched once, cached, and refreshed opportunistically because it changes
 * only when a human changes it — a stale window is harmless, since the window
 * only ever bounds a read the cursor already bounds. That is precisely why
 * BACKLOG-2997 REJECTED a Supabase-backed sync CURSOR: a cursor changes every
 * cycle and cannot tolerate staleness. Different data, different rule.
 *
 * ## Two behaviours that are INTENDED, so nobody files them as bugs
 *
 * **A message can age out of the window while the queue is back-pressured.**
 * The window is rolling, so if the queue stays full long enough for the edge to
 * pass a message the phone had not yet reached, that message is never read. It
 * takes months of continuous back-pressure to bite, and it is what "Last N
 * months" asks for: a message older than the window is outside what the user
 * requested, not lost. The cursor still never advances past an unread message
 * that IS in window, because `max()` only ever raises the floor.
 *
 * **A pre-BACKLOG-2224 desktop can pair a phone to another account's desktop.**
 * `checkDesktopAccountMatch` allows pairing when the QR carries no
 * `desktopUserIdHash`, so on that legacy path the phone applies ITS OWN
 * account's window rather than the desktop's. No data leaks — the phone reads
 * only its own `user_preferences` row under RLS — and it is a degrading path
 * that disappears as desktops update.
 *
 * @module services/syncWindow
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Sentry from "@sentry/react-native";
import { supabase } from "./supabaseClient";

/**
 * The signed-in user's id, or undefined.
 *
 * Reads `supabase.auth` DIRECTLY rather than going through
 * `authService.getSession()`, which is the same one-line call but drags in a
 * module-load SIDE EFFECT: `authService` evaluates
 * `createURL('auth/callback', ...)` at import time, and `expo-linking` throws
 * without the expo-constants manifest. `smsQueueService` imports this module,
 * and half the companion's suites import `smsQueueService`, so that edge broke
 * five suites at PARSE time. Keeping this module's import graph to
 * `supabaseClient` + AsyncStorage + Sentry keeps it safe to import from
 * anywhere.
 */
async function currentUserId(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id;
}

// ============================================
// CONSTANTS
// ============================================

/**
 * Lookback shown (and now applied) when the user has stored NO preference.
 *
 * MIRROR of `DEFAULT_LOOKBACK_MONTHS` in
 * `src/components/settings/messageImportPreferences.ts`, which mirrors
 * `electron/services/macOSMessagesImportService/importHelpers.ts`.
 *
 * ## This is a THIRD mirror, and it has to be
 *
 * The renderer cannot value-import from `electron/` (Vite parses it as JS, and
 * `rootDir` forbids the reverse), which is why the second mirror exists.
 * `android-companion/` is a separate npm package with its OWN lockfile and its
 * own `node_modules` — it is not a workspace of the root project — so it can
 * import from neither. What holds this to the others is not the type system but
 * `__tests__/syncWindow.mirror-2800.test.ts`, which replays the
 * BACKLOG-2561 absent-vs-explicit-null cases against this resolver.
 */
export const DEFAULT_LOOKBACK_MONTHS = 3;

/** AsyncStorage key for the cached window setting. */
const SYNC_WINDOW_KEY = "@keepr/sync-window";

/** AsyncStorage key for the last FAILED fetch, used as a short backoff. */
const SYNC_WINDOW_FAILED_KEY = "@keepr/sync-window-failed-at";

/**
 * Refresh the cached setting when it is older than this.
 *
 * One hour, not six. The panel says "Importing messages from the last N months"
 * in the PRESENT tense, so a long TTL leaves the phone contradicting the screen
 * for many cycles after the user narrows the setting. This is the steady-state
 * refresh only — `forceRefresh` below covers the cases that actually matter.
 */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Hard ceiling on the Supabase read so a hung network cannot stall a cycle.
 *
 * Five seconds, not ten: this runs inside an Android background-fetch cycle,
 * whose total budget is small, and the ladder below already degrades safely.
 */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * How long to wait after a FAILED fetch before trying again.
 *
 * Without this an offline phone pays the full timeout on every cycle — most
 * visible on manual "Sync Now" taps, which a user can issue back to back. A
 * `forceRefresh` always ignores this backoff.
 */
const FAILED_FETCH_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

// ============================================
// TYPES
// ============================================

/**
 * The cached setting.
 *
 * `userId` is part of the record on purpose (BACKLOG-2800 SR review R12).
 * `unpairDevice` accepts an `account-switch` reason, so a cache that outlived a
 * re-pair under a DIFFERENT account would apply the previous user's window to
 * the new user's phone whenever the new user's fetch failed. Stamping the owner
 * makes a foreign cache read as ABSENT rather than as a value.
 */
interface CachedSyncWindow {
  userId: string;
  lookbackMonths: number | null;
  fetchedAt: number;
}

/**
 * Outcome of reading the setting from Supabase.
 *
 * BACKLOG-2800 SR review R1: a fetch that FAILED and a fetch that SUCCEEDED and
 * found no preferences row are different facts and must not collapse into one
 * `catch`. A brand-new user genuinely has no row (`maybeSingle()` yields `null`
 * with no error); that is a successful read of an empty preferences object, and
 * it must go through the resolver to `DEFAULT_LOOKBACK_MONTHS` — which is what
 * the panel displays for the same input. Treating it as "unreachable" would run
 * the phone unwindowed while the panel says "Last 3 months": a silent-catch
 * defect (PR-SOP §6.4) and a re-run of BACKLOG-2749.
 */
type WindowFetchResult =
  | { ok: true; lookbackMonths: number | null }
  | { ok: false; reason: "no_session" | "query_failed" | "timeout" };

// ============================================
// THE RESOLVER MIRROR
// ============================================

/** The stored filter object, exactly as persisted — RAW and unresolved. */
interface StoredFilters {
  lookbackMonths?: number | null;
  maxMessages?: number | null;
}

/** Narrow an unknown to a plain object without inheriting a prototype. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Resolve the lookback the ANDROID sync must apply, from a raw preferences blob.
 *
 * MIRROR of `resolveAndroidImportFilters` + `resolveStoredLookbackMonths` in
 * `src/components/settings/messageImportPreferences.ts`, with ONE DELIBERATE
 * DIVERGENCE — see the validation at the end of this function.
 *
 * ## The divergence, named so nobody "restores parity" by deleting it
 *
 * `resolveStoredLookbackMonths` returns a stored value VERBATIM once it is
 * neither `undefined` nor `null`. This resolver additionally requires it to be
 * a finite positive number, and falls back to the default otherwise.
 *
 * That is intentional and NOT drift. The renderer's value is rendered into a
 * dropdown, where a junk value simply fails to match an option. This one is fed
 * to calendar arithmetic and then onto a native query, where a junk value does
 * not throw — it POISONS, silently producing an unbounded read (the reasoning
 * is at the validation itself). The two consumers have different failure modes,
 * so they get different guards.
 *
 * Pinned by `syncWindow.mirror-2800.test.ts`, which asserts the SHARED rules as
 * parity cases AND asserts this divergence is intended.
 *
 * The three shared rules, every one of which has already been a bug here:
 *
 *   1. `messageImport.android` ABSENT falls back to the legacy shared key
 *      `messageImport.filters`. The desktop panel only seeds the `android`
 *      namespace the first time somebody OPENS that panel, so a user who chose
 *      "All time" before BACKLOG-2734 and has never opened it still has their
 *      choice only under the legacy key. Reading `android` alone would silently
 *      narrow them to 3 months.
 *   2. `lookbackMonths` ABSENT is "no preference", which resolves to
 *      `DEFAULT_LOOKBACK_MONTHS` — NOT to "All time" (BACKLOG-2561).
 *   3. `lookbackMonths === null` is an EXPLICIT "All time" and means no lower
 *      bound. `?? DEFAULT` and `?? null` both get this wrong; the test that
 *      distinguishes them is `=== undefined`.
 *
 * @returns months of lookback, or `null` for "All time" (no lower bound).
 */
export function resolveLookbackMonths(preferences: unknown): number | null {
  const prefs = asRecord(preferences);
  const messageImport = asRecord(prefs?.messageImport);

  // Rule 1 — absent `android` namespace falls back to the legacy shared key.
  const androidBranch = asRecord(messageImport?.android);
  const source = androidBranch
    ? (asRecord(androidBranch.filters) as StoredFilters | undefined)
    : (asRecord(messageImport?.filters) as StoredFilters | undefined);

  // Rules 2 and 3 — absent is the default, explicit null is All time.
  const raw = source?.lookbackMonths;
  if (raw === undefined) return DEFAULT_LOOKBACK_MONTHS;
  if (raw === null) return null;

  // Anything else must be a usable month count before it reaches the calendar
  // arithmetic. This blob crossed a process boundary AND a network, so it is
  // not trustworthy by construction — and a non-number does not throw here, it
  // POISONS: `setMonth(getMonth() - "abc")` yields NaN, `getTime()` yields NaN,
  // `Math.max(cursor, NaN)` is NaN, and `JSON.stringify` turns that into a
  // literal `null` on the wire, which the native side reads back as 0 — an
  // unbounded read, arrived at silently. Falling back to the default keeps a
  // corrupt preference from quietly disabling the window.
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_LOOKBACK_MONTHS;
}

/**
 * The oldest timestamp a read may reach, for a given lookback.
 *
 * Calendar months, CLAMPED at month ends. Naive `setMonth` overflows — 31 Aug
 * minus 6 months lands on 3 March rather than 28 February, and 31 March minus 1
 * month lands on 3 March, skipping February outright. Overflow always moves the
 * edge FORWARD, i.e. it silently NARROWS the window the user asked for, so the
 * clamp is the faithful reading of "the last N months" and not a nicety.
 * Boundary cases are swept, not sampled, in `syncWindow.window-2800.test.ts`.
 *
 * @returns the lower bound in epoch ms, or `null` for "All time".
 */
export function computeWindowStart(
  months: number | null,
  now: number
): number | null {
  if (months === null) return null; // All time — no lower bound.

  const from = new Date(now);
  const day = from.getDate();

  // Move to the 1st BEFORE shifting the month so the shift can never overflow,
  // then clamp the day to the target month's length.
  const target = new Date(now);
  target.setDate(1);
  target.setMonth(target.getMonth() - months);

  const daysInTargetMonth = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0
  ).getDate();
  target.setDate(Math.min(day, daysInTargetMonth));

  return target.getTime();
}

// ============================================
// FETCH + CACHE
// ============================================

/** Read the signed-in user's preferences row. Never throws. */
async function fetchLookbackFromSupabase(): Promise<
  WindowFetchResult & { userId?: string }
> {
  let userId: string | undefined;
  try {
    userId = await currentUserId();
  } catch {
    // BACKLOG-2284: the session read can THROW on corrupt/locked storage.
    return { ok: false, reason: "no_session" };
  }
  if (!userId) return { ok: false, reason: "no_session" };

  try {
    const query = supabase
      .from("user_preferences")
      .select("preferences")
      .eq("user_id", userId)
      .maybeSingle();

    // Race a timeout so a hung request cannot stall the sync cycle.
    //
    // The timer is CLEARED on every path. Left dangling it keeps the JS runtime
    // awake for the full timeout after the request has already resolved — on a
    // phone that holds a background-fetch cycle open doing nothing, and it is
    // what surfaced in jest as "Jest did not exit one second after the test
    // run" when this suite was first written.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), FETCH_TIMEOUT_MS);
    });

    let outcome: Awaited<typeof query> | "timeout";
    try {
      outcome = await Promise.race([query, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (outcome === "timeout") return { ok: false, reason: "timeout", userId };

    const { data, error } = outcome;
    if (error) return { ok: false, reason: "query_failed", userId };

    // R1: data === null means the read SUCCEEDED and the user simply has no
    // preferences row yet. That is an empty preferences object, not a failure,
    // and it must resolve to the same value the panel displays.
    return {
      ok: true,
      lookbackMonths: resolveLookbackMonths(data?.preferences ?? {}),
      userId,
    };
  } catch {
    return { ok: false, reason: "query_failed", userId };
  }
}

/** Read the cached record, ignoring one that belongs to a different user. */
async function readCache(userId?: string): Promise<CachedSyncWindow | null> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_WINDOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSyncWindow;
    if (typeof parsed?.userId !== "string") return null;
    // R12: a cache stamped with another account is ABSENT, never a value.
    if (userId && parsed.userId !== userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(record: CachedSyncWindow): Promise<void> {
  try {
    await AsyncStorage.setItem(SYNC_WINDOW_KEY, JSON.stringify(record));
  } catch {
    // A cache write failure is not worth failing a sync over — the next cycle
    // simply fetches again.
  }
}

/**
 * Drop the cached window.
 *
 * Called from `resetAllSyncData` (the unpair teardown). Belt-and-braces
 * alongside the `userId` stamp: the stamp is what actually makes an
 * account-switch safe, this keeps the store tidy.
 */
export async function clearSyncWindowCache(): Promise<void> {
  try {
    // Two removeItem calls rather than multiRemove: this project's pinned
    // @react-native-async-storage/async-storage does not expose multiRemove on
    // its type, and the rest of the codebase uses removeItem throughout.
    await Promise.all([
      AsyncStorage.removeItem(SYNC_WINDOW_KEY),
      AsyncStorage.removeItem(SYNC_WINDOW_FAILED_KEY),
    ]);
  } catch {
    // Best effort. A surviving record is not necessarily inert: `readCache`
    // only enforces the owner stamp when it KNOWS the current user
    // (`if (userId && parsed.userId !== userId)`), so a phone that cannot read
    // its session still accepts whatever is cached. That is the intended
    // behaviour — a signed-out but paired phone keeping its last known window
    // beats going unwindowed — but it means this removal is real hygiene, not a
    // no-op, and the owner stamp is not a guarantee on that path.
  }
}

/**
 * Fetch the setting and cache it. Called at pairing so the FIRST sync cycle —
 * the only one where the window materially bites, because after it the cursor
 * is above the window edge — has a real value rather than the fail-open default.
 */
export async function primeSyncWindow(): Promise<void> {
  const result = await fetchLookbackFromSupabase();
  if (result.ok && result.userId) {
    await writeCache({
      userId: result.userId,
      lookbackMonths: result.lookbackMonths,
      fetchedAt: Date.now(),
    });
  }
}

/**
 * The oldest timestamp this cycle's read may reach, or `null` for no bound.
 *
 * ## The fallback ladder, and why the last rung is fail-OPEN
 *
 *   fresh fetch -> cached value (however stale) -> NO lower bound
 *
 * The terminal rung reproduces today's behaviour rather than blocking, because
 * the two failure directions are not symmetric:
 *
 *   - Failing OPEN over-ingests, bounded by the queue's remaining capacity (at
 *     most `MAX_QUEUE_SIZE` per cycle). The next successful fetch raises the
 *     floor, and the surplus is deletable.
 *   - Failing CLOSED to a default would advance the cursor past history the
 *     user never asked to skip, and the cursor advance makes that history
 *     unreadable without a re-pair.
 *
 * Irreversible loss beats bounded, recoverable excess. This is soft state; the
 * founder-approved discriminator reserves fail-closed for access-control state,
 * which a display preference is not.
 */
export async function getSyncWindowStart(
  now: number,
  options: { forceRefresh?: boolean } = {}
): Promise<number | null> {
  // THIS FUNCTION MUST NEVER THROW.
  //
  // It is called inside `performSync`'s outer try/catch, whose catch sets
  // `readError = query_failed`. A throw from here would therefore be reported
  // to the user as an SMS READ failure: the cycle would count as a failed
  // reach, `lastSuccessfulSyncAt` would be held, the BACKLOG-2203 staleness
  // streak would tick, and the read-error/permission banner would appear — all
  // because Supabase was slow. Every rung below is individually guarded, and
  // this outer guard is the backstop.
  try {
    return await resolveWindowStart(now, options.forceRefresh === true);
  } catch (err) {
    console.warn(
      "[SyncWindow] Unexpected failure resolving the import window — syncing UNWINDOWED:",
      err
    );
    return null;
  }
}

async function resolveWindowStart(
  now: number,
  forceRefresh: boolean
): Promise<number | null> {
  let userId: string | undefined;
  try {
    userId = await currentUserId();
  } catch {
    userId = undefined;
  }

  const cached = await readCache(userId);
  const isFresh = cached !== null && now - cached.fetchedAt < CACHE_TTL_MS;

  // `forceRefresh` deliberately overrides a FRESH cache.
  //
  // The caller sets it when the message cursor is 0, which is exactly the set
  // {first-ever sync, first sync after pairing, force re-import}. BACKLOG-2995
  // resets the cursor on every successful pair, so on those cycles the read is
  // bounded by the WINDOW and nothing else — the one moment a stale or missing
  // window does maximum damage. Keying off the cursor rather than off a pairing
  // callback also covers force re-import without depending on how that reset
  // reaches the phone.
  if (isFresh && !forceRefresh) {
    return computeWindowStart(cached.lookbackMonths, now);
  }

  // Back off after a recent failure so an offline phone does not pay the full
  // timeout every cycle — but never when the cursor says this cycle matters.
  if (!forceRefresh && (await recentlyFailed(now))) {
    if (cached) return computeWindowStart(cached.lookbackMonths, now);
    return reportUnwindowed("backoff");
  }

  const result = await fetchLookbackFromSupabase();
  if (result.ok && result.userId) {
    await writeCache({
      userId: result.userId,
      lookbackMonths: result.lookbackMonths,
      fetchedAt: now,
    });
    await clearFailureMarker();
    return computeWindowStart(result.lookbackMonths, now);
  }

  await recordFailure(now);

  // Rung 2 — a stale cached value is still the user's real choice.
  if (cached) {
    console.warn(
      `[SyncWindow] Using stale cached window (fetch failed: ${result.ok ? "n/a" : result.reason})`
    );
    return computeWindowStart(cached.lookbackMonths, now);
  }

  // Rung 3 — nothing was ever obtained. Proceed UNWINDOWED rather than block.
  return reportUnwindowed(result.ok ? "unknown" : result.reason);
}

/**
 * The terminal fail-open rung, and it is never silent.
 *
 * An unwindowed run is indistinguishable in the field from the very bug this
 * item fixes — "the setting governs nothing and nobody can tell" — so it is
 * always logged and always reported.
 */
function reportUnwindowed(reason: string): null {
  console.warn(
    `[SyncWindow] No window available (${reason}) and nothing cached — syncing UNWINDOWED (BACKLOG-2800 fail-open)`
  );
  try {
    Sentry.captureMessage("Android sync ran with no import window", {
      level: "warning",
      tags: {
        component: "syncWindow",
        window_fallback: "unwindowed",
        fetch_reason: reason,
      },
    });
  } catch {
    // Reporting must never be the thing that breaks a sync cycle.
  }
  return null;
}

async function recentlyFailed(now: number): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_WINDOW_FAILED_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && now - at < FAILED_FETCH_BACKOFF_MS;
  } catch {
    return false;
  }
}

async function recordFailure(now: number): Promise<void> {
  try {
    await AsyncStorage.setItem(SYNC_WINDOW_FAILED_KEY, String(now));
  } catch {
    // Best effort — the cost of losing this is one extra timeout.
  }
}

async function clearFailureMarker(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SYNC_WINDOW_FAILED_KEY);
  } catch {
    // Best effort.
  }
}
