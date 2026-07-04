/**
 * iPhone Sync Enablement Resolver (BACKLOG-1706)
 *
 * Pure function that decides whether iPhone-over-USB detection/sync should be
 * active, given the user's explicit preference, the current platform, and the
 * effective message import source.
 *
 * Decision rationale (documented for BACKLOG-1706):
 * - An explicit `integrations.iphoneSyncEnabled` preference ALWAYS wins. This is
 *   what the Settings toggle writes, so the user's choice is authoritative.
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
  // 1. Explicit opt-in/opt-out always wins.
  if (typeof pref === "boolean") {
    return pref;
  }

  // 2. Non-macOS platforms keep current always-on behavior.
  if (platform !== "macos") {
    return true;
  }

  // 3. macOS is opt-in: only when the user selected iPhone sync as their source.
  return importSource === "iphone-sync";
}

export default resolveIphoneSyncEnabled;
