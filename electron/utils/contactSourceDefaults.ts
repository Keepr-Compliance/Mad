/**
 * Which contact sources are ON by default? — CANONICAL COPY.
 *
 * ===========================================================================
 * THIS IS THE CANONICAL COPY. THE RENDERER MIRROR IS `src/utils/contactSourceDefaults.ts`
 * ===========================================================================
 *
 * BACKLOG-2479 / BACKLOG-2476. One rule, asked in two places:
 *   - onboarding's ContactSourceStep, to decide which cards start ticked
 *   - `preferenceHelper.isContactSourceEnabled`, to decide what an ABSENT
 *     preference means
 *
 * Before this module those two answers were written separately and disagreed:
 * onboarding pre-selected per platform/phone/SSO, while the backend defaulted
 * every source to `true`. A user who skipped the step — or whose preference
 * write failed — got the backend's answer, which switched on sources the step
 * had deliberately left off.
 *
 * The rule cannot simply be imported by both. `tsconfig.electron.json` sets
 * `rootDir: "./electron"`, so nothing under `electron/` may import from `src/`
 * or `shared/`. (`@keepr/shared` is not a way out either: its entry point is
 * unbuilt TypeScript and `electron-builder`'s `files` list excludes
 * `packages/**`, which is why `electron/types/license.ts` is a hand-duplicate
 * of `shared/types/license.ts`.) The repo's answer to this is a mirror plus a
 * parity test — see `contactNameCompat` and `contactDisplayLabel`.
 *
 * What keeps the two copies honest is not this comment.
 * `src/utils/__tests__/contactSourceDefaults.parity.test.ts` imports BOTH
 * implementations and asserts an identical verdict for every point in the full
 * platform x phoneType x authProvider x key cross-product. Edit one without the
 * other and that test goes red.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — THIS MODULE DECIDES ENABLEMENT DEFAULTS AND NOTHING ELSE.
 * ---------------------------------------------------------------------------
 * A contact-source preference is a CONSENT setting: "yes, go and look in my
 * Outlook". It is not provenance. It must never be consulted by anything that
 * displays, filters, or records where a contact actually came from — that
 * question is answered by `contact_source_links.source_type` and its vocabulary
 * in `contactSourceVocabulary.ts`, which this module has no relationship to.
 * The name is deliberately `contactSourceDefaults`, not `contactSources`, so
 * the two cannot be confused at an import site.
 */

/** The five direct contact-source preference keys. */
export type ContactSourceKey =
  | "macosContacts"
  | "outlookContacts"
  | "iphoneContacts"
  | "googleContacts"
  | "androidContacts";

/** Everything the rule needs to know about the user. */
export interface ContactSourceDefaultContext {
  /** The desktop the app is running on. */
  platform: "macos" | "windows";
  /** What the user answered at the phone-type step. `null` = never answered. */
  phoneType: "iphone" | "android" | null;
  /** The SSO provider the user signed in with. `null` = not known here. */
  authProvider: "google" | "microsoft" | null;
}

/** Every key, in a stable order. */
export const CONTACT_SOURCE_KEYS: readonly ContactSourceKey[] = [
  "macosContacts",
  "outlookContacts",
  "iphoneContacts",
  "googleContacts",
  "androidContacts",
];

/**
 * Keys whose ABSENT-preference backend default is derived from this rule
 * (see `preferenceHelper.isContactSourceEnabled`). Deliberately not all five.
 *
 * `iphoneContacts` is here because every backend consumer of it —
 * `contactHandlers.ts:1093, :1165, :1286` and `iPhoneSyncStorageService.ts:545`
 * — combines it with `macosContacts` via OR, so deriving it cannot suppress an
 * import that is happening today.
 *
 * `macosContacts` is EXCLUDED, and this is load-bearing rather than cautious.
 * `contactHandlers.ts:1294` is a catch-all that gates every external contact
 * whose source is not outlook/google_contacts/iphone/macos on `macosContacts`.
 * Android companion contacts are exactly that case: `localSyncService.ts` writes
 * them to `external_contacts` with `source = "android_sync"`, and the
 * `androidContacts` preference key is read by nothing in `electron/` at all. An
 * Android user never sees the macOS card either (it carries both
 * `platforms: ["macos"]` and `excludePhoneType: "android"`), so `macosContacts`
 * is never written for them and the absent-preference branch is the only thing
 * deciding it. Today that branch answers `true`, which is the sole reason
 * Android contacts reach the picker. Deriving it would answer `false` and every
 * Android companion contact would silently disappear.
 * `preferenceHelper.test.ts` pins this with an explicit Android assertion.
 *
 * `outlookContacts` / `googleContacts` are EXCLUDED because the rule needs
 * `authProvider`, which the main process cannot see at this layer: only
 * `phone_type` lives in the Supabase preferences bag, and `users.oauth_provider`
 * lives in the local SQLite DB that this helper must work without. Guessing
 * would risk defaulting a working mailbox import to OFF. The onboarding step
 * writes these on BOTH continue and skip, which covers the population that the
 * mismatch actually affected.
 */
export const BACKEND_DERIVED_DEFAULT_KEYS: readonly ContactSourceKey[] = [
  "iphoneContacts",
];

/**
 * Narrow an untrusted `phone_type` value onto the rule's input type.
 *
 * `supabaseService.getPreferences` returns `Record<string, any>`, so the value
 * read out of the preferences bag is unchecked. A stray `"ios"` or `"Android"`
 * must land on `null` (unknown) rather than sail into the rule as a phone type
 * it will silently mishandle.
 */
export function normalizePhoneType(
  value: unknown,
): "iphone" | "android" | null {
  return value === "iphone" || value === "android" ? value : null;
}

/**
 * Is this source ON by default for this user?
 *
 * Only consulted when the user has expressed no preference. An explicitly
 * stored `true`/`false` always wins over this.
 */
export function isContactSourceOnByDefault(
  key: ContactSourceKey,
  ctx: ContactSourceDefaultContext,
): boolean {
  const isAndroid = ctx.phoneType === "android";
  const isMacOS = ctx.platform === "macos";

  switch (key) {
    case "macosContacts":
      // The Mac's own address book. Not offered to Android users, who are
      // steered to the companion app instead.
      return isMacOS && !isAndroid;

    case "iphoneContacts":
      // BACKLOG-2479. On a Mac this is OFF by default, because the Mac address
      // book ALREADY contains the iPhone's contacts — iCloud syncs them across.
      // Pre-ticking both meant the default configuration read the same people
      // out of two sources on the very first sync.
      //
      // The card stays visible and selectable: iCloud contact sync can be
      // turned off, and for that user the iPhone is the only address book they
      // have. It is the pre-selection that is wrong, not the option.
      //
      // On Windows there is no macOS source to cover it, so it stays ON.
      if (isAndroid) return false;
      return !isMacOS;

    case "androidContacts":
      return isAndroid;

    case "outlookContacts":
      // Follow the SSO provider the user actually signed in with. An Android
      // user is steered to Google regardless.
      if (isAndroid) return false;
      return ctx.authProvider === "microsoft";

    case "googleContacts":
      if (isAndroid) return true;
      return ctx.authProvider === "google";
  }
}

/** The whole default selection, as one object keyed by preference key. */
export function getDefaultContactSourceSelection(
  ctx: ContactSourceDefaultContext,
): Record<ContactSourceKey, boolean> {
  return {
    macosContacts: isContactSourceOnByDefault("macosContacts", ctx),
    outlookContacts: isContactSourceOnByDefault("outlookContacts", ctx),
    iphoneContacts: isContactSourceOnByDefault("iphoneContacts", ctx),
    googleContacts: isContactSourceOnByDefault("googleContacts", ctx),
    androidContacts: isContactSourceOnByDefault("androidContacts", ctx),
  };
}

/** Is this string one of the five keys? Narrows an arbitrary preference key. */
export function isContactSourceKey(key: string): key is ContactSourceKey {
  return (CONTACT_SOURCE_KEYS as readonly string[]).includes(key);
}
