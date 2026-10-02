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
  "android-companion": "Android Companion",
};

/** The label of a stored import source, or null when none / unknown. */
export function importSourceLabel(source: ImportSource | null | undefined): string | null {
  return source && Object.prototype.hasOwnProperty.call(IMPORT_SOURCE_LABELS, source) ? IMPORT_SOURCE_LABELS[source] : null;
}
