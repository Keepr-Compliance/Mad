/**
 * The names of the text-message import sources, as Settings → Messages shows
 * them. ONE copy: the source picker (ImportSourceSettings) and the
 * Contacts → Auto-discover "Messages / SMS" row (BACKLOG-3670) both read it.
 */

import type { ImportSource } from "../../services/settingsService";

export const IMPORT_SOURCE_LABELS: Readonly<Record<ImportSource, string>> = {
  "macos-native": "macOS Messages",
  "iphone-sync": "iPhone Sync",
  "android-messages-web": "Android: Google Messages",
  // C6: no longer offered; a stored "android-companion" is shown as Google
  // Messages (shownImportSource). Kept so a stored value still has a name.
  "android-companion": "Android: Google Messages",
};

/**
 * SR clean-up C6 (founder: the Android Companion's UI is removed): the source
 * the UI shows and acts on. A stored "android-companion" is shown — and
 * behaves — as Google Messages. The stored value is never rewritten here (the
 * parked Companion backend and its data stay as they are).
 */
export function shownImportSource(source: ImportSource): ImportSource {
  return source === "android-companion" ? "android-messages-web" : source;
}

/** The label of a stored import source, or null when none / unknown. */
export function importSourceLabel(source: ImportSource | null | undefined): string | null {
  return source && Object.prototype.hasOwnProperty.call(IMPORT_SOURCE_LABELS, source) ? IMPORT_SOURCE_LABELS[shownImportSource(source)] : null;
}
