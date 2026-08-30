/**
 * Preference Helper
 *
 * Shared utility for checking user preferences.
 * Used by contact-handlers.ts and iPhoneSyncStorageService.ts
 * to gate imports based on user preference toggles.
 * Also used by emailSyncService.ts to read email cache duration (BACKLOG-1361).
 *
 * Reusable by TASK-1951 for inferred contact source preferences.
 */

import supabaseService from "../services/supabaseService";
import logService from "../services/logService";
import { EMAIL_CACHE_DURATION_MONTHS_DEFAULT } from "../constants";
import {
  BACKEND_DERIVED_DEFAULT_KEYS,
  isContactSourceKey,
  isContactSourceOnByDefault,
  normalizePhoneType,
} from "./contactSourceDefaults";

/**
 * BACKLOG-2986 — how long a preference read may take before it is abandoned.
 *
 * THE DEFECT THIS CLOSES. Every caller here passes a `defaultValue` and every
 * one of them fails OPEN on it. That covers a read that FAILS. It does not
 * cover a read that never returns: a promise that never settles is not an
 * error, so the `catch` never runs, the default is never applied, and the
 * caller waits forever.
 *
 * WHY IT BECAME URGENT. `localSyncService.storeContacts` now reads a preference
 * on the INBOUND HTTP handler of the LAN sync server (BACKLOG-2986). Before
 * that, the phone's POST touched only local SQLite. A hang there is not a slow
 * sync — it is a sync the phone cannot complete, and a desktop that accepts the
 * TCP connection and then hangs inside the handler is indistinguishable, from
 * the phone, from a desktop that is down. That is precisely the unexplained
 * "desktop unreachable" the field tester reports in BACKLOG-2955.
 *
 * WHERE THE NUMBER COMES FROM — the phone's own client timeout is the ceiling,
 * and the other half of the budget is MEASURED rather than estimated:
 *
 *   - The companion aborts at `REQUEST_TIMEOUT_MS = 10_000`
 *     (`android-companion/services/syncService.ts:120`), and `/sync/contacts`
 *     uses it (`:358-368`). Past 10s the phone reports `timeout`. Everything
 *     this handler does has to fit inside that.
 *   - THE WRITE COSTS ~0.36s at full address-book size. Measured, not guessed:
 *     `localSyncService.writeCost-2986.test.ts` drives the real shadow write
 *     and the real promotion over an on-disk SQLite file and prints the figure
 *     on every run — 121ms for 389 contacts, 358ms for 2,200, 88ms for a
 *     re-sync where every contact is already claimed (three runs, +/-5ms).
 *   - So the read gets 6s and ~4s is left for the write and the response. That
 *     reserve is ELEVEN TIMES the measured write, which is the margin for the
 *     things the measurement does not cover: page encryption, a cold cache, a
 *     busy Windows disk.
 *   - The read itself is a single-row primary-key `select` on
 *     `user_preferences`, so 6s is a very slow one, not a marginal one.
 *
 * THE SPLIT USED TO BE THE OTHER WAY ROUND — 3s for the read, 7s reserved for
 * the write — and both halves were wrong. The write is local `better-sqlite3`
 * and sub-second; the READ is the variable half, a Supabase round trip over
 * whatever connection the desktop has. The consequence was narrow and went
 * against this item's own promise: a read that WOULD have returned a stored
 * `androidContacts: false` at 3.5s was abandoned, fail-open applied, and an OFF
 * switch silently promoted. Failing open on an UNAVAILABLE preference is
 * correct; doing it because the read was merely slow is not.
 *
 * EXPORTED because the tests must advance fake timers by this constant rather
 * than by a literal that would silently stop matching it.
 */
export const PREFERENCES_READ_TIMEOUT_MS = 6_000;

/**
 * Read the preferences bag, or REJECT once `PREFERENCES_READ_TIMEOUT_MS` has
 * passed. Every function in this module reads through here.
 *
 * IT REJECTS, AND THAT IS THE WHOLE DESIGN. Resolving with `{}` instead would
 * be worse than the bug it fixes: an empty bag is a READABLE bag, so it flows
 * into the derived-default rule, an absent `androidContacts` derives FALSE, and
 * a hung network would silently switch the user's Android contact import off.
 * Rejecting routes a hang into the same fail-open `catch` each caller already
 * has for a failed read, which is the behaviour every one of them documents.
 *
 * TWO THINGS THIS DOES NOT DO, stated so nobody assumes otherwise:
 *
 * 1. IT DOES NOT CANCEL THE REQUEST. `supabaseService.getPreferences` takes no
 *    `AbortSignal`, so the hung read stays hung in the background holding its
 *    socket. What is fixed is the CALLER being unblocked — which is the defect:
 *    a handler that never returns. A true cancellation needs an `AbortSignal`
 *    threaded through `supabaseService`.
 * 2. IT IS NOT APPLIED IN `supabaseService.getPreferences` ITSELF. That function
 *    has around ten other consumers — `preferenceHandlers`, `permissionHandlers`,
 *    `userSettingsHandlers`, `supportTicketService`, `importPlanInputs` — whose
 *    failure semantics nobody has audited. Timing them out is a behaviour change
 *    to five modules this item has no business touching. Every contact-source
 *    gate goes through `isContactSourceEnabled` below, so covering this module
 *    covers all three of them, and a fourth gate must come through here too.
 *
 * The `clearTimeout` in `finally` is not tidiness: a pending timer keeps the
 * Node event loop alive, so without it every successful read would leave a live
 * handle behind for up to three seconds.
 */
async function readPreferences(
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches getPreferences
): Promise<Record<string, any>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      supabaseService.getPreferences(userId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- never resolves
      new Promise<Record<string, any>>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Logged HERE, not in the callers' catch blocks, because their message
          // says "could not load" — which reads as a failed read. "The read
          // failed" and "the read never returned" are different states, and
          // collapsing them once already hid a zero-message release for weeks
          // (BACKLOG-2206). A support investigation must be able to tell them
          // apart from the log alone.
          logService.warn(
            `[PreferenceHelper] Preference read did not return within ` +
              `${PREFERENCES_READ_TIMEOUT_MS}ms — abandoning it and falling back. ` +
              `The underlying request is still outstanding; it was not cancelled.`,
            "Preferences",
            { userId, timeoutMs: PREFERENCES_READ_TIMEOUT_MS },
          );
          reject(
            new Error(
              `Preference read timed out after ${PREFERENCES_READ_TIMEOUT_MS}ms`,
            ),
          );
        }, PREFERENCES_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Check if a specific contact source is enabled in user preferences.
 *
 * Three different situations get three different answers:
 *
 * 1. **The user expressed a preference.** It wins, always.
 * 2. **The user expressed no preference** — skipped the onboarding step,
 *    onboarded before the step existed, or the best-effort write failed.
 *    BACKLOG-2476: for the direct sources in `BACKEND_DERIVED_DEFAULT_KEYS`
 *    this is now answered by the SAME rule onboarding pre-selects with, so a
 *    skip no longer switches on a source the step deliberately left off. Every
 *    other key keeps `defaultValue`; see that constant's docblock for why the
 *    list is not all five.
 * 3. **Preferences could not be READ at all** — Supabase offline, or, since
 *    BACKLOG-2986, a read that did not return within
 *    `PREFERENCES_READ_TIMEOUT_MS`. Fail open on `defaultValue`, unchanged.
 *    Before that timeout existed this case covered a rejection only, and a hung
 *    read reached neither branch: it simply never returned. Deliberately NOT
 *    folded into case 2:
 *    when the read fails we cannot see `phone_type` either, so applying the
 *    rule would be guessing — and guessing OFF silently breaks a working
 *    import.
 *
 * @param userId - The user's UUID
 * @param category - 'direct' for direct imports, 'inferred' for auto-discovered
 * @param key - The specific source key (e.g., 'outlookContacts', 'macosContacts')
 * @param defaultValue - Default if preference is not set (defaults to true)
 * @returns Whether the source is enabled
 */
export async function isContactSourceEnabled(
  userId: string,
  category: "direct" | "inferred",
  key: string,
  defaultValue: boolean = true,
): Promise<boolean> {
  try {
    const preferences = await readPreferences(userId);
    const value = preferences?.contactSources?.[category]?.[key];
    if (typeof value === "boolean") return value;

    // BACKLOG-2476: no stored preference. Answer with onboarding's own rule
    // where it is safe to, instead of a blanket `true`.
    if (
      category === "direct" &&
      isContactSourceKey(key) &&
      BACKEND_DERIVED_DEFAULT_KEYS.includes(key)
    ) {
      return isContactSourceOnByDefault(key, {
        platform: process.platform === "darwin" ? "macos" : "windows",
        // Already inside the object we just fetched — no extra round trip.
        // Narrowed rather than cast: `getPreferences` returns
        // `Record<string, any>`, so a stray "ios" must read as unknown.
        phoneType: normalizePhoneType(preferences?.phone_type),
        // Not knowable here: only `phone_type` lives in the preferences bag,
        // and `users.oauth_provider` is in the local SQLite DB this helper must
        // work without. No key in BACKEND_DERIVED_DEFAULT_KEYS depends on it.
        authProvider: null,
      });
    }

    return defaultValue;
  } catch {
    logService.warn(
      `[PreferenceHelper] Could not load preferences for contact source check, defaulting to ${defaultValue}`,
      "Preferences",
      { userId, category, key },
    );
    return defaultValue;
  }
}

/**
 * BACKLOG-2565: resolve the email cache duration from a preferences bag.
 *
 * Precedence, highest first:
 *   1. `emailCache.durationMonths` — the key TASK-2072 introduced and the ONLY
 *      key any current writer produces (`EmailSettings.tsx:249`). PRESENCE
 *      wins, not validity: a stored key that is present but out of domain
 *      (0, negative, a string) lands on the default rather than reaching past
 *      itself to the legacy key. See "byte-for-byte" below for why.
 *   2. `emailSync.lookbackMonths` — the pre-TASK-2072 name for the same
 *      setting. No writer produces it any more; it survives only in the stored
 *      preferences of users who set the value before the rename.
 *   3. `EMAIL_CACHE_DURATION_MONTHS_DEFAULT` (3).
 *
 * THE DEFECT THIS CLOSES: the Settings screen has honoured the legacy key
 * since TASK-2072 (`EmailSettings.tsx:40-44`, the `??` fallback) while this
 * reader — the one `emailSyncService` actually caches against — did not. A
 * user carrying `emailSync.lookbackMonths = 12` and no `emailCache` key read
 * "12 months" off the screen while the backend cached 3. Two readers of one
 * user-facing setting disagreed; they now resolve it the same way.
 *
 * WHY A READER FALLBACK AND NOT A ONE-TIME KEY MIGRATION: preferences live in
 * **Supabase**, not local SQLite (`supabaseService.getPreferences`, below) —
 * so there is no schema-chain migration to write, and no preference-
 * normalisation step exists at app start to hang a one-time fixup on. A fixup
 * would also reach only users who launch the app while online, and would leave
 * the disagreement standing for every session before the write succeeds. This
 * fallback needs neither a write nor a network round trip, and it COMPOSES
 * with a later fixup or server-side backfill rather than foreclosing one: once
 * the canonical key is present, rule 1 wins and rule 2 never fires again.
 *
 * BYTE-FOR-BYTE THE SCREEN'S EXPRESSION. The bug was two readers DISAGREEING,
 * so the fix is not "this reader should also see 12" — it is "this reader
 * resolves the setting the way the screen does, for every stored shape". The
 * `??` (not `||`) and the single trailing `> 0` validation are transcribed
 * from `EmailSettings.tsx:40-44` deliberately, and a parity sweep in
 * `preferenceHelper.test.ts` compares the two for every shape the JSON can
 * hold. An earlier draft of this function validated the canonical key BEFORE
 * falling through to the legacy one; that sweep caught it, because a stored
 * `emailCache.durationMonths = 0` made the two sides answer 3 and 12.
 *
 * NOT to be confused with `messageImport.filters.lookbackMonths`
 * (BACKLOG-2561/2733) — a different key on a different path.
 *
 * @param preferences - The preferences bag as stored (may be null/undefined).
 *   Typed `Record<string, any>` to match `supabaseService.getPreferences`'s own
 *   return type: this is arbitrary stored JSON, and `Record<string, unknown>`
 *   would force a cast at every nested access without making one of them safer.
 *   The single read below narrows with `typeof` before returning.
 * @returns Duration in months
 */
export function resolveEmailCacheDurationMonths(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see @param
  preferences: Record<string, any> | null | undefined,
): number {
  const value =
    preferences?.emailCache?.durationMonths ??
    preferences?.emailSync?.lookbackMonths;

  if (typeof value === "number" && value > 0) {
    return value;
  }

  return EMAIL_CACHE_DURATION_MONTHS_DEFAULT;
}

/**
 * BACKLOG-1361: Get the email cache duration preference (in months).
 *
 * Reads the user's stored preferences from Supabase and resolves them with
 * `resolveEmailCacheDurationMonths` (new key → legacy key → default 3).
 * Falls back to EMAIL_CACHE_DURATION_MONTHS_DEFAULT (3) if the preferences
 * cannot be loaded at all.
 *
 * @param userId - The user's UUID
 * @returns Duration in months
 */
export async function getEmailCacheDurationMonths(
  userId: string,
): Promise<number> {
  try {
    const preferences = await readPreferences(userId);
    return resolveEmailCacheDurationMonths(preferences);
  } catch {
    logService.warn(
      `[PreferenceHelper] Could not load email cache duration preference, using default ${EMAIL_CACHE_DURATION_MONTHS_DEFAULT}`,
      "Preferences",
      { userId },
    );
    return EMAIL_CACHE_DURATION_MONTHS_DEFAULT;
  }
}

/**
 * BACKLOG-1831: Is the additive-only SHADOW-mode Outlook delta sync enabled?
 *
 * Default OFF in every environment. Enabled when EITHER:
 *   - env var KEEPR_SHADOW_DELTA_SYNC=1 (ops/demo enablement, wins immediately), OR
 *   - user preference shadowDeltaSync.enabled === true (nested boolean read).
 *
 * Fail-CLOSED: if preferences cannot be loaded, returns false (this is an opt-in
 * experiment, so a load failure must NOT silently turn it on).
 *
 * @param userId - The user's UUID
 */
export async function isShadowDeltaSyncEnabled(userId: string): Promise<boolean> {
  if (process.env.KEEPR_SHADOW_DELTA_SYNC === "1") return true;
  try {
    // BACKLOG-2986: a TIMEOUT lands in the catch below and therefore fails
    // CLOSED here, unlike the two readers above. Deliberate, and it is this
    // function's own documented rule: an opt-in experiment must never be turned
    // on by a read that did not answer.
    const preferences = await readPreferences(userId);
    return preferences?.shadowDeltaSync?.enabled === true;
  } catch {
    logService.warn(
      "[PreferenceHelper] Could not load shadow delta sync preference, defaulting to OFF",
      "Preferences",
      { userId },
    );
    return false;
  }
}

/**
 * BACKLOG-1361: Compute the email cache since-date based on the user's preference.
 *
 * @param durationMonths - Number of months to look back
 * @returns Date representing the earliest email date to fetch
 */
export function computeEmailCacheSinceDate(durationMonths: number): Date {
  // Approximate: 30 days per month is sufficient for cache window purposes
  return new Date(Date.now() - durationMonths * 30 * 24 * 60 * 60 * 1000);
}
