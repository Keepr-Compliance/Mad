/**
 * BACKLOG-3598: quitting Keepr stops a running iPhone backup.
 *
 * `before-quit` handlers are synchronous, so the only way to wait for idevicebackup2 to
 * exit is to cancel this quit, stop the backup, and quit again. `stop` returns null
 * when no backup is running — that quit goes ahead untouched. `stop` never waits
 * longer than its own bound (BackupService.QUIT_STOP_TIMEOUT_MS) and never rejects,
 * but the re-quit is also issued if it does, so a quit can never be swallowed.
 */
export interface QuitEventLike {
  preventDefault(): void;
}

export interface QuittableApp {
  quit(): void;
}

/**
 * Returns the `before-quit` check. It returns true when it deferred the quit; the
 * caller must then return without running its other cleanup, which runs on the
 * re-quit instead.
 */
export function createBackupStopOnQuit(
  app: QuittableApp,
  stop: () => Promise<unknown> | null,
): (event: QuitEventLike) => boolean {
  let stopped = false;
  return (event) => {
    // One deferral per app run: the re-quit must not be deferred again.
    if (stopped) return false;
    let stopping: Promise<unknown> | null;
    try {
      stopping = stop();
    } catch {
      stopping = null;
    }
    if (!stopping) return false;
    stopped = true;
    event.preventDefault();
    const requit = () => app.quit();
    stopping.then(requit, requit);
    return true;
  };
}
