/**
 * BACKLOG-3749 — how a build acts on the stored text-message import source.
 *
 * `messages.source` is ONE account-wide preference (synced through Supabase),
 * but it describes a per-device choice: a Mac's Messages, an iPhone, or an
 * Android phone. A value written on one device (or by a newer build, e.g.
 * "android-messages-web") is read by every other device and build. Before
 * this, any value other than "macos-native" silently turned Mac Messages sync
 * off on a Mac — including a value the build did not even know.
 *
 * Rules (founder, 2026-10-05):
 * - A value this build does not know is read as the platform's default — it
 *   never switches anything off. The stored value is never rewritten here.
 * - An explicit, KNOWN selection is respected (BACKLOG-1467 stands): on a Mac,
 *   Mac Messages sync runs only for "macos-native" — iPhone Sync or a known
 *   Android source (Google Messages, the Companion) skips it, as before.
 * - When it is skipped, Settings › Messages shows the selected source.
 */

import type { ImportSource } from "./settingsService";

export const KNOWN_IMPORT_SOURCES: readonly ImportSource[] = [
  "macos-native",
  "iphone-sync",
  "android-companion",
  "android-messages-web",
];

export function isKnownImportSource(value: unknown): value is ImportSource {
  return typeof value === "string" && (KNOWN_IMPORT_SOURCES as readonly string[]).includes(value);
}

/** The platform's default source. */
export function defaultImportSource(isMacOS: boolean): ImportSource {
  return isMacOS ? "macos-native" : "iphone-sync";
}

/**
 * The source this build acts on: the stored one when it knows it, else the
 * platform's default (an unknown value never switches anything off).
 */
export function effectiveImportSource(stored: unknown, isMacOS: boolean): ImportSource {
  return isKnownImportSource(stored) ? stored : defaultImportSource(isMacOS);
}

/**
 * Does THIS Mac import its Messages? Yes for "macos-native" and for a value
 * this build does not know (the Mac default); no for an explicit known other
 * source. (Callers still require macOS and the Full Disk Access permission.)
 */
export function macMessagesSyncOn(stored: unknown): boolean {
  return effectiveImportSource(stored, true) === "macos-native";
}

/**
 * BACKLOG-3418 — the source the user has CHOSEN, or `null` when they have chosen
 * none. ONE derivation for every reader of "the source": the iPhone detection
 * gate (IPhoneSyncContext), Settings' Messages section (Settings.tsx), the
 * Settings source radio (ImportSourceSettings) and the Dashboard import button
 * (useImportSource). Before this each derived it on its own and they disagreed.
 *
 * Founder rule (2026-10-07): on Windows/Linux, iPhone checking is OFF unless the
 * user picked iPhone — the same opt-in macOS has. A user who picked nothing has
 * no source: Settings checks no radio, the Dashboard shows no import button,
 * and no device detection runs.
 *
 * Inputs: `stored` = `messages.source` from preferences; `localPhone` = the
 * local onboarding phone type (`users_local.mobile_phone_type`); `cloudPhone` =
 * `phone_type` from the same preferences object (a returning account whose
 * local phone type has not been recovered yet still has it).
 *
 * Rules as coded:
 * - macOS (unchanged): any stored value → `effectiveImportSource` (an unknown
 *   value reads as `macos-native`, BACKLOG-3749). Nothing stored → phone type
 *   android → `android-companion`, otherwise `macos-native`.
 * - Windows/Linux: a KNOWN stored source wins. Otherwise the phone type (local,
 *   else cloud): android → `android-companion`; iphone → `iphone-sync`;
 *   none → `null`. An unknown stored string is NOT a choice of iPhone.
 *
 * Effective precedence of iPhone detection on Windows/Linux, once the resolver
 * (utils/iphoneSyncEnabled.ts) applies the stored "iPhone Sync (USB)" toggle:
 *   known stored source > phone type android (non-iPhone source, resolver
 *   rule 1) > stored toggle > phone type iphone > OFF.
 * The stored-toggle-without-a-source shape (toggle true, nothing chosen → ON)
 * is legacy: no production Windows account has it, and once nothing is chosen
 * the toggle is disabled in Settings, so it cannot be newly written.
 *
 * Callers apply `shownImportSource` themselves where they display the value.
 */
export function chosenImportSource(input: {
  stored: unknown;
  localPhone: unknown;
  cloudPhone: unknown;
  isMacOS: boolean;
}): ImportSource | null {
  const { stored, localPhone, cloudPhone, isMacOS } = input;
  if (isMacOS) {
    if (stored) return effectiveImportSource(stored, true);
  } else if (isKnownImportSource(stored)) {
    return stored;
  }
  const phone = localPhone ? localPhone : cloudPhone;
  if (phone === "android") return "android-companion";
  if (phone === "iphone") return isMacOS ? "macos-native" : "iphone-sync";
  return isMacOS ? "macos-native" : null;
}

/** Whether `chosenImportSource` needs the phone type for this stored value. */
export function chosenImportSourceNeedsPhoneType(stored: unknown, isMacOS: boolean): boolean {
  return isMacOS ? !stored : !isKnownImportSource(stored);
}

/**
 * `chosenImportSource` from a preferences object, reading the local phone type
 * only when the stored source does not settle it. `getLocalPhoneType` is the
 * caller's `settingsService.getPhoneType(userId)`.
 */
export async function loadChosenImportSource(
  prefs: { messages?: { source?: unknown }; phone_type?: unknown } | null | undefined,
  isMacOS: boolean,
  getLocalPhoneType: () => Promise<{ success: boolean; data?: unknown }>,
): Promise<ImportSource | null> {
  const stored = prefs?.messages?.source;
  let localPhone: unknown = null;
  if (chosenImportSourceNeedsPhoneType(stored, isMacOS)) {
    const local = await getLocalPhoneType();
    localPhone = local.success ? local.data : null;
  }
  return chosenImportSource({ stored, localPhone, cloudPhone: prefs?.phone_type, isMacOS });
}
