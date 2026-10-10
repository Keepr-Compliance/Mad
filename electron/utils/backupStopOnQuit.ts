/**
 * BACKLOG-3598: quitting Keepr stops a running iPhone backup.
 *
 * `before-quit` handlers are synchronous, so the only way to wait for idevicebackup2 to
 * exit is to cancel this quit, stop the backup, and quit again. `stop` returns null
 * when no backup is running — that quit goes ahead untouched. `stop` never waits
 * longer than its own bound (BackupService.QUIT_STOP_TIMEOUT_MS) and never rejects,
 * but the re-quit is also issued if it does, so a quit can never be swallowed.
 * A second quit while that wait runs is held too (BACKLOG-3785), not let through.
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
  // "idle" -> "waiting" (first deferral) -> "done" (wait ended, re-quit issued).
  let state: "idle" | "waiting" | "done" = "idle";
  return (event) => {
    // The re-quit that ends the wait must not be deferred again.
    if (state === "done") return false;
    // A further quit while the single wait is running is held, not let through,
    // and does not start a second wait. The one wait carries its own max bound.
    if (state === "waiting") {
      event.preventDefault();
      return true;
    }
    let stopping: Promise<unknown> | null;
    try {
      stopping = stop();
    } catch {
      stopping = null;
    }
    if (!stopping) return false;
    state = "waiting";
    event.preventDefault();
    const requit = () => {
      state = "done";
      app.quit();
    };
    stopping.then(requit, requit);
    return true;
  };
}
