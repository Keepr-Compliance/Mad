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
 * Rules (founder, 2026-10-05: "decide by the device's platform"):
 * - A value this build does not know is read as the platform's default — it
 *   never switches anything off. The stored value is never rewritten here.
 * - On a Mac, Mac Messages sync is off ONLY when the stored source is iPhone
 *   Sync (the other Apple path for the same texts). An Android source (Google
 *   Messages, the Companion) is another device's choice and never turns Mac
 *   Messages off. (This reverses BACKLOG-1467's skip for Android sources.)
 * - When Mac Messages sync IS off, the UI says why (Settings › Messages).
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
 * Does THIS Mac import its Messages? Off only for iPhone Sync; an Android or
 * unknown source never turns it off. (Callers still require macOS and the
 * Full Disk Access permission.)
 */
export function macMessagesSyncOn(stored: unknown): boolean {
  return stored !== "iphone-sync";
}
