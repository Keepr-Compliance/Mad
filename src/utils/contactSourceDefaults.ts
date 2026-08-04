/**
 * Which contact sources are ON by default? — RENDERER MIRROR.
 *
 * ===========================================================================
 * THIS IS A MIRROR. THE CANONICAL COPY IS `electron/utils/contactSourceDefaults.ts`
 * ===========================================================================
 *
 * BACKLOG-2479 / BACKLOG-2476. Onboarding's ContactSourceStep asks this to
 * decide which cards start ticked; `preferenceHelper.isContactSourceEnabled` in
 * the main process asks the same question to decide what an ABSENT preference
 * means. Those two answers used to be written separately and disagreed — the
 * backend defaulted everything to `true`, so skipping the step switched on
 * sources the step had deliberately left off.
 *
 * The rule cannot simply be imported across the boundary: `tsconfig.electron.json`
 * sets `rootDir: "./electron"`, so nothing under `electron/` may import from
 * `src/` or `shared/`, and `@keepr/shared` cannot carry runtime code into the
 * main process (unbuilt TS entry point, and `electron-builder`'s `files` list
 * excludes `packages/**`). The same constraint is why `electron/types/license.ts`
 * is a hand-duplicate of `shared/types/license.ts`.
 *
 * What keeps the two copies honest is not this comment.
 * `src/utils/__tests__/contactSourceDefaults.parity.test.ts` imports BOTH
 * implementations and asserts an identical verdict for every point in the full
 * platform x phoneType x authProvider x key cross-product. Edit one without the
 * other and that test goes red.
 *
 * Read the canonical file for the reasoning behind each clause — in particular
 * why `iphoneContacts` is OFF on macOS, and why `BACKEND_DERIVED_DEFAULT_KEYS`
 * deliberately excludes `macosContacts`.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — THIS MODULE DECIDES ENABLEMENT DEFAULTS AND NOTHING ELSE.
 * ---------------------------------------------------------------------------
 * A contact-source preference is a CONSENT setting ("yes, go and look in my
 * Outlook"), not provenance. It must never be consulted by anything that
 * displays, filters or records where a contact came from — that is
 * `contact_source_links.source_type` and `contactFilterModel.ts`, which this
 * module has no relationship to.
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
 * Keys whose ABSENT-preference backend default is derived from this rule.
 * Mirrored for the parity test; the renderer itself has no use for it.
 * See the canonical file for why this is not all five keys — in short,
 * `contactHandlers.ts:1294` gates Android companion contacts on
 * `macosContacts`, and `outlookContacts`/`googleContacts` need an
 * `authProvider` the main process cannot see.
 */
export const BACKEND_DERIVED_DEFAULT_KEYS: readonly ContactSourceKey[] = [
  "iphoneContacts",
];

/**
 * Narrow an untrusted `phone_type` value onto the rule's input type.
 * A stray `"ios"` or `"Android"` must land on `null` (unknown).
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
      return isMacOS && !isAndroid;

    case "iphoneContacts":
      // BACKLOG-2479. OFF on a Mac: the Mac address book already contains the
      // iPhone's contacts via iCloud, so pre-ticking both read the same people
      // out of two sources on the first sync. The card stays visible and
      // selectable — iCloud contact sync can be off, and then the iPhone is the
      // only address book there is. On Windows nothing else covers it, so ON.
      if (isAndroid) return false;
      return !isMacOS;

    case "androidContacts":
      return isAndroid;

    case "outlookContacts":
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
