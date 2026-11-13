/**
 * BACKLOG-3283: whether the app is quitting. On macOS the main window's `close`
 * hides it unless this is set (`hideOnClose.ts`).
 *
 * Writers: `before-quit` in main.ts (after every deferral has let the quit
 * through), `install-update` in updaterHandlers.ts (native quitAndInstall closes
 * windows BEFORE before-quit), and the submission guard's "Quit Anyway".
 * Cleared where a quit is cancelled with no Electron event: the submission guard
 * preventing the window close.
 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function clearQuitting(): void {
  quitting = false;
}

export function isQuitting(): boolean {
  return quitting;
}
