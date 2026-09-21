/**
 * iPhone Sync Enablement Resolver (BACKLOG-1706)
 *
 * Pure function that decides whether iPhone-over-USB detection/sync should be
 * active, given the user's explicit preference, the current platform, and the
 * effective message import source.
 *
 * Decision rationale (documented for BACKLOG-1706, amended by BACKLOG-3423):
 * - BACKLOG-3423 (founder, 2026-09-17): a KNOWN import source other than iPhone
 *   disables the integration outright, on every platform. This overrides the
 *   BACKLOG-1706 rule below, under which an explicit preference always won: a
 *   macOS Messages user whose stored `iphoneSyncEnabled` was `true` (set at some
 *   earlier point, and carried into every fresh profile because preferences live
 *   in Supabase) got USB device detection, a 2s device poll and an "iPhone Sync
 *   (USB)" toggle reading ON, for hardware his source will never use.
 *   The gate is on the EFFECTIVE value only — the stored preference is left
 *   alone, so switching back to iPhone restores whatever the user had chosen.
 *   An UNKNOWN source (`null`) is NOT a non-iPhone source: it falls through to
 *   the rules below.
 * - An explicit `integrations.iphoneSyncEnabled` preference wins over the
 *   platform/source defaults below. This is what the Settings toggle writes, so
 *   within an iPhone source the user's choice is authoritative.
 * - When the preference is unset, detection runs only when the user's effective
 *   import source is `iphone-sync` — on EVERY platform. We key on the import
 *   source (not the raw onboarding phoneType) because that is the exact signal
 *   already used to gate the Dashboard "Import from iPhone" button
 *   (BACKLOG-1653), which keeps the button and the detection in lock-step.
 *   The platform difference lives in the source DEFAULT, not here: with nothing
 *   stored, IPhoneSyncContext derives `macos-native` on macOS (so a fresh macOS
 *   user gets no detection until they choose iPhone sync) and `iphone-sync` on
 *   Windows / Linux unless the phone type is Android (so a signed-in Windows
 *   iPhone user still gets detection with no setup).
 * - BACKLOG-3418 (founder, 2026-09-21): an UNKNOWN source means OFF on every
 *   platform. The source is unknown while nobody is signed in (the login
 *   screen) and while a signed-in user's preferences are still loading.
 *   BACKLOG-1706 kept Windows / Linux ON in that state so their primary import
 *   path started on the first frame; that ran device detection on the login
 *   screen, before any user or preference existed. The `platform` argument no
 *   longer changes the outcome; it stays in the signature for callers.
 */

import type { Platform } from "./platform";
import type { ImportSource } from "../services/settingsService";

/**
 * Resolve the effective iPhone-sync enabled state.
 *
 * @param pref - Explicit `integrations.iphoneSyncEnabled` preference, or undefined if unset
 * @param platform - Current platform ('macos' | 'windows' | 'linux')
 * @param importSource - Effective message import source, or null if unknown
 * @returns Whether iPhone detection/sync should be active
 */
export function resolveIphoneSyncEnabled(
  pref: boolean | undefined,
  platform: Platform,
  importSource: ImportSource | null,
): boolean {
  // 1. BACKLOG-3423: a known non-iPhone source switches the integration off,
  //    whatever the stored preference says. `null` means "not known yet", not
  //    "not iPhone", so it deliberately falls through to the rules below.
  if (importSource !== null && importSource !== "iphone-sync") {
    return false;
  }

  // 2. Explicit opt-in/opt-out wins over the defaults below.
  if (typeof pref === "boolean") {
    return pref;
  }

  // 3. Otherwise only an iPhone source runs detection, on every platform. An
  //    unknown source (`null`: signed out, or preferences still loading) is OFF.
  //    BACKLOG-3418 removed the rule that returned `true` here for every
  //    non-macOS platform whatever the source.
  return importSource === "iphone-sync";
}

/**
 * The import source an onboarding phone-type answer stands for (BACKLOG-2408).
 *
 * One mapping for both places that act on the answer, so they cannot drift:
 * the onboarding save (`usePhoneTypeApi`) persists this value as
 * `messages.source`, and the onboarding flow hands the same value to
 * `IPhoneSyncProvider.applyImportSource` so device detection is re-gated the
 * moment the answer is given (BACKLOG-3418) instead of at the next app start.
 *
 *   Android          -> "android-companion"
 *   iPhone on macOS  -> "macos-native" (the Mac address book syncs via iCloud)
 *   iPhone elsewhere -> "iphone-sync"
 *
 * `isMacOS` is a boolean rather than a platform so Linux reads as "elsewhere",
 * matching the provider's own default.
 */
export function importSourceForPhoneType(
  phoneType: "iphone" | "android",
  isMacOS: boolean,
): ImportSource {
  if (phoneType === "android") return "android-companion";
  return isMacOS ? "macos-native" : "iphone-sync";
}

export default resolveIphoneSyncEnabled;
