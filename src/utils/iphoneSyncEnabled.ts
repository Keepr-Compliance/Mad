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
 *   An UNKNOWN source (`null`, i.e. preferences not read yet or unreadable) is
 *   NOT a non-iPhone source: it falls through to the rules below, so a Windows
 *   iPhone user still gets detection from the first frame as before.
 * - An explicit `integrations.iphoneSyncEnabled` preference wins over the
 *   platform/source defaults below. This is what the Settings toggle writes, so
 *   within an iPhone source the user's choice is authoritative.
 * - When the preference is unset:
 *   - Windows / Linux keep their current behavior (enabled). On these platforms
 *     iPhone cable sync is the primary local import path, and detection has run
 *     at startup since the feature shipped — turning it off would be a regression.
 *   - macOS is OPT-IN. The panel + polling only run when the user's effective
 *     import source is `iphone-sync`. We key on the import source (not the raw
 *     onboarding phoneType) because that is the exact signal already used to gate
 *     the Dashboard "Import from iPhone" button (BACKLOG-1653). Keying on it keeps
 *     the button and the detection in lock-step and yields the required
 *     macOS-default-OFF: a fresh macOS user defaults to `macos-native`, so no
 *     iPhone detection runs until they deliberately choose iPhone sync.
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

  // 3. Non-macOS platforms keep current always-on behavior.
  if (platform !== "macos") {
    return true;
  }

  // 4. macOS is opt-in: only when the user selected iPhone sync as their source.
  return importSource === "iphone-sync";
}

export default resolveIphoneSyncEnabled;
