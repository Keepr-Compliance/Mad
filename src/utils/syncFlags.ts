/**
 * Sync Flag Utilities
 *
 * Module-level flags to coordinate sync operations across components.
 * These prevent duplicate syncs when multiple code paths could trigger
 * the same sync operation (e.g., PermissionsStep vs useAutoRefresh).
 *
 * TASK-1786: Extracted from useMacOSMessagesImport.ts during cleanup.
 *
 * @module utils/syncFlags
 */

// Module-level flag to track if messages import has been triggered this session.
// This persists across component remounts and React StrictMode double-mounts.
// Used by useAutoRefresh (dashboard) to avoid duplicate message syncs.
// BACKLOG-1842: PermissionsStep no longer triggers sync itself (sync starts only
// in the fresh process after the FDA-grant relaunch, owned by useAutoRefresh), so
// this flag is now set exclusively on the dashboard side.
let hasTriggeredMessagesImport = false;

/**
 * Check if messages import has been triggered this session.
 * Used by useAutoRefresh to avoid duplicate message syncs on macOS.
 */
export function hasMessagesImportTriggered(): boolean {
  return hasTriggeredMessagesImport;
}

/**
 * Mark messages import as triggered.
 * Called by useAutoRefresh when it kicks off a macOS messages sync, so a later
 * re-fire in the same session doesn't duplicate the import.
 */
export function setMessagesImportTriggered(): void {
  hasTriggeredMessagesImport = true;
}

/**
 * Reset the import trigger flag.
 * Used for testing and logout scenarios.
 */
export function resetMessagesImportTrigger(): void {
  hasTriggeredMessagesImport = false;
}
