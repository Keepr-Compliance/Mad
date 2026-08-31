/**
 * Message-import preferences, as the RENDERER reads and writes them.
 *
 * Two panels configure message imports — `MacOSMessagesImportSettings` and
 * `AndroidMessagesSettings` — and until BACKLOG-2734 they were two UIs over ONE
 * stored fact, so each silently reconfigured the other. This module owns the
 * three things they genuinely share:
 *
 *   1. the defaults a stored preference falls back to when a key is ABSENT,
 *   2. the absent-vs-explicit-null resolution those defaults exist for,
 *   3. the per-panel key namespacing that keeps the two panels independent.
 *
 * ## These defaults are MIRRORS, and mirrors is all they can be
 *
 * The values the main process actually imports with live in
 * `electron/services/macOSMessagesImportService/importHelpers.ts` and
 * `electron/services/importPlan.ts`. The renderer cannot value-import from
 * `electron/` — the Vite renderer build parses it as JavaScript, and `rootDir`
 * forbids the reverse — so they are duplicated here on purpose.
 *
 * What this module changes is that there is now ONE renderer-side mirror
 * instead of two that could drift apart from each other as well as from the
 * resolver. It does not, and cannot, make the value single-definition across
 * the process boundary; the suites named on each constant are what hold it to
 * the resolver.
 *
 * ## There is now a THIRD copy, in the Android companion (BACKLOG-2800)
 *
 * `android-companion/services/syncWindow.ts` restates
 * `resolveAndroidImportFilters` + `resolveStoredLookbackMonths` so the PHONE can
 * apply the same window this panel displays. The companion is a separate npm
 * package with its own lockfile and its own `node_modules`, and
 * `android-companion/metro.config.js` roots Metro at that directory with no
 * `watchFolders` — so `src/` is unreachable from it at bundle time. A
 * cross-package import would pass jest and then fail the bundler, which is the
 * "every green check reads source, none runs a bundler" trap. It is a
 * restatement, not shared code, and it cannot be anything else.
 *
 * What holds the three copies together is tests, on both sides:
 *   - here: `__tests__/AndroidMessagesSettings.allTime-2561.test.tsx`
 *   - companion: `android-companion/services/__tests__/syncWindow.mirror-2800.test.ts`
 *
 * If you change the absent-vs-explicit-null rules below, change them there too.
 *
 * @module settings/messageImportPreferences
 */

/**
 * Lookback window shown when the user has stored NO `lookbackMonths` preference.
 *
 * BACKLOG-2561: must equal `DEFAULT_LOOKBACK_MONTHS` in
 * `electron/services/macOSMessagesImportService/importHelpers.ts`, which is what
 * the main process actually imports with. Pinned by
 * `__tests__/MacOSMessagesImportSettings.allTime-2561.test.tsx` and
 * `__tests__/AndroidMessagesSettings.allTime-2561.test.tsx`, which assert the
 * dropdown reads "Last 3 months" for the exact preference shape the app writes
 * when only the message cap has ever been changed.
 */
export const DEFAULT_LOOKBACK_MONTHS = 3;

/**
 * Cap shown when the user has stored NO `maxMessages` preference.
 *
 * BACKLOG-2749: must equal `DEFAULT_MAX_MESSAGES` in
 * `electron/services/importPlan.ts`, which is what the resolver actually
 * enforces. Duplicated here for the same reason `DEFAULT_LOOKBACK_MONTHS` is.
 *
 * It exists because the absent key was being read as "Unlimited". A panel doing
 * `maxMessages ?? null` conflates it with the `null` this dropdown writes for an
 * explicit Unlimited, so a user who had only ever changed the LOOKBACK — which
 * leaves `maxMessages` absent through the preferences deep-merge — saw
 * "Unlimited" while their run was capped at 50,000 by `resolveMaxMessages`. The
 * setting said one thing and the run did another, with no dialog in between
 * because the panel believed there was no cap to disclose.
 *
 * Fixed for the macOS panel in PR #2345 and for the Android panel in
 * BACKLOG-2795 — the same defect, ported, and the reason this module exists.
 */
export const DEFAULT_MAX_MESSAGES = 50000;

/** The stored filter object, exactly as persisted — RAW and unresolved. */
export interface StoredMessageImportFilters {
  lookbackMonths?: number | null;
  maxMessages?: number | null;
  skipAttachments?: boolean;
}

/**
 * The `messageImport` preference branch as the renderer sees it.
 *
 * `filters` is the ORIGINAL shared key and remains the macOS panel's — and the
 * main process's — home (`electron/services/importPlanInputs.ts`
 * `loadStoredImportFilters`). `android` is the namespace BACKLOG-2734 added, and
 * nothing in the main process reads it.
 */
export interface MessageImportPreferences {
  filters?: StoredMessageImportFilters;
  android?: { filters?: StoredMessageImportFilters };
}

/**
 * Resolve a stored `lookbackMonths` for DISPLAY.
 *
 * BACKLOG-2561: an ABSENT key is "no preference", not "All time". Only an
 * explicit `null` — what the dropdown writes for "All time" — means unbounded.
 * `?? DEFAULT` and `?? null` both get this wrong; the test is `=== undefined`.
 */
export function resolveStoredLookbackMonths(
  filters: StoredMessageImportFilters | undefined
): number | null {
  return filters?.lookbackMonths === undefined
    ? DEFAULT_LOOKBACK_MONTHS
    : filters.lookbackMonths;
}

/**
 * Resolve a stored `maxMessages` for DISPLAY.
 *
 * BACKLOG-2749 / BACKLOG-2795: the same distinction as the lookback, and the
 * same consequence for getting it wrong — an absent key shown as "Unlimited"
 * over a run the resolver caps at `DEFAULT_MAX_MESSAGES`.
 */
export function resolveStoredMaxMessages(
  filters: StoredMessageImportFilters | undefined
): number | null {
  return filters?.maxMessages === undefined
    ? DEFAULT_MAX_MESSAGES
    : filters.maxMessages;
}

/**
 * Read the `messageImport` branch out of a preferences payload.
 *
 * `settingsService.getPreferences` returns whatever is stored, so everything
 * here is optional and nothing may be assumed present.
 */
export function readMessageImportPreferences(
  preferences: unknown
): MessageImportPreferences | undefined {
  if (!preferences || typeof preferences !== "object") return undefined;
  const branch = (preferences as Record<string, unknown>).messageImport;
  if (!branch || typeof branch !== "object") return undefined;
  return branch as MessageImportPreferences;
}

/** What the Android panel should display, and whether its namespace needs seeding. */
export interface AndroidFilterResolution {
  lookbackMonths: number | null;
  maxMessages: number | null;
  /** True when `messageImport.android` is absent and the one-time seed is owed. */
  needsSeed: boolean;
}

/**
 * BACKLOG-2734 — resolve the ANDROID panel's filters, and say whether the
 * one-time migration is still owed.
 *
 * ## Why there are two keys
 *
 * Both panels wrote and read `messageImport.filters`, so setting "Last 3 months"
 * on the Android companion panel silently narrowed the macOS iMessage import,
 * and the macOS panel then displayed that window as though the user had chosen
 * it there. Neither screen said the setting was shared. The Android panel now
 * owns `messageImport.android.filters`; `messageImport.filters` stays exactly
 * where it is, because it is what the MAIN process imports with and changing it
 * would move a fact four suites pin at its current address.
 *
 * ## The migration, and why it is a read-then-seed rather than a data migration
 *
 * The first load that finds no `android` namespace adopts the CURRENT shared
 * value — resolved, so an absent key becomes the default and an explicit `null`
 * stays "All time" — and writes it back under `android`. Both panels therefore
 * start from the same value the user is looking at today; every write after that
 * is independent.
 *
 * It seeds the RESOLVED PAIR rather than the raw legacy object so that a later
 * partial write (the dropdowns write one key at a time) deep-merges onto a
 * complete object. Seeding `{ lookbackMonths: 18 }` alone would leave
 * `maxMessages` absent under `android`, and a legacy cap of 10,000 would be
 * silently replaced by the default — a preference lost by the very migration
 * meant to preserve it.
 *
 * Idempotence is by STATE, not by a first-run guard: once `android` exists this
 * returns `needsSeed: false` forever, so a second mount — including StrictMode's
 * — writes nothing. (Two mounts racing the very first load would emit two
 * byte-identical seeds, which the recursive merge in
 * `electron/handlers/preferenceHandlers.ts` collapses to the same stored state.)
 */
export function resolveAndroidImportFilters(
  preferences: unknown
): AndroidFilterResolution {
  const messageImport = readMessageImportPreferences(preferences);
  const androidFilters = messageImport?.android?.filters;
  const needsSeed = messageImport?.android === undefined;
  const source = needsSeed ? messageImport?.filters : androidFilters;

  return {
    lookbackMonths: resolveStoredLookbackMonths(source),
    maxMessages: resolveStoredMaxMessages(source),
    needsSeed,
  };
}

/**
 * The preferences patch that writes an Android filter change.
 *
 * BACKLOG-2734: the ONE place the Android namespace is spelled. A panel that
 * builds this object inline is a panel that can drift back onto the shared key,
 * which is the defect this module exists to make unrepeatable.
 */
export function androidFilterPatch(
  filters: StoredMessageImportFilters
): { messageImport: { android: { filters: StoredMessageImportFilters } } } {
  return { messageImport: { android: { filters } } };
}
