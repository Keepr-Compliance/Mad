/**
 * The host application's own lifecycle, as an interface (BACKLOG-2962).
 *
 * WHY THIS IS A THIRD SEAM AND NOT PART OF `Dialog` OR `Windows`
 * --------------------------------------------------------------
 * BACKLOG-2961's five-seam table (`pm_comments` `4c10fdb4` §5) had ONE row named
 * "AppLifecycle" covering `app.isReady`/`whenReady`/`quit`/`isPackaged` **and**
 * `dialog.showMessageBox`; the founder's decision (`3fd7e871`) relabelled that
 * row "Dialog". Enumerated by the compiler, the row is twelve call expressions
 * in two unrelated concerns, and seven of them are neither a dialog nor a
 * window:
 *
 *   `app.isPackaged`  databaseService.ts:192   — gates a dev-only test seam
 *   `app.isReady()`   databaseService.ts:330, :476
 *   `app.whenReady()` databaseService.ts:331, :477
 *   `app.quit()`      databaseService.ts:420, :507
 *
 * Splitting the row is what lets each interface describe one thing. Leaving the
 * seven out would leave `import { app } from "electron"` in `databaseService.ts`
 * and the extraction closure reading 1 rather than 0.
 *
 * WHY `isReady`/`whenReady` ARE NOT FOLDED INTO THE DIALOG ADAPTER
 * ----------------------------------------------------------------
 * They exist only to make a dialog showable — `databaseService.ts:329` says
 * "Ensure app is ready before showing dialog" — so hiding them inside
 * `ElectronDialog.showMessageBox` looks tidy. It is not: today the ready-wait
 * completes BEFORE `closeDb()` and `this.db = null` on the terminal
 * BACKLOG-2999 path, and moving it into the dialog call would reorder the handle
 * teardown against it. That file's own comment calls the order load-bearing.
 * A seam may not quietly reorder the code it seams.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a wrapper for Electron's `app`. That object has some sixty methods and
 * thirty events; this has the four the core calls, and a fifth is added when a
 * core caller needs one — the rule `appPaths.ts` states for having a single
 * `userData()` accessor.
 *
 * @module electron/capabilities/appLifecycle
 */

/**
 * The host application's readiness and shutdown, as far as the core is
 * concerned.
 *
 * Every accessor is a METHOD, including {@link isPackaged}, for the reason
 * `appPaths.ts` records: the answer is read when it is wanted, never captured at
 * construction.
 */
export interface AppLifecycle {
  /**
   * Whether this is a packaged build rather than a development run.
   *
   * Its one caller gates a test-only delay seam that must be DEAD CODE in any
   * shipped build, so an implementation that answered `false` in production
   * would arm that seam. A host that has no such distinction should return
   * `true`, the safe answer.
   */
  isPackaged(): boolean;

  /** Whether the host is ready to show UI. */
  isReady(): boolean;

  /** Resolves once the host is ready to show UI. */
  whenReady(): Promise<void>;

  /**
   * Ask the host to shut down.
   *
   * This is Electron's `app.quit()`, which runs `before-quit` handlers and can
   * be cancelled — NOT the composition root's `app.exit(1)`, which ends the
   * process immediately. Both callers here are terminal database failures where
   * a graceful quit is what is wanted.
   */
  quit(): void;
}

/** Raised by {@link UnavailableAppLifecycle}. */
export class AppLifecycleUnavailableError extends Error {
  constructor(member: string) {
    super(
      `No app lifecycle is installed, so ${member} cannot be answered. The host ` +
        "shell must install an AppLifecycle at its composition root before any " +
        "code reaches this capability (Electron does so in " +
        "electron/bootstrap/installNativeCapabilities.ts).",
    );
    this.name = "AppLifecycleUnavailableError";
  }
}

/**
 * An {@link AppLifecycle} that throws on every member.
 *
 * THIS ONE THROWS, WHERE `SilentWindows` DOES NOT, and the reason is the same
 * one `UnavailableAppPaths` gives: none of these four has an honest no-op.
 *
 *   - `isPackaged()` — `false` arms a test-only delay seam in a shipped build;
 *     `true` disarms a developer's own seam silently. Both are wrong answers
 *     given confidently.
 *   - `isReady()`/`whenReady()` — answering "ready" when nothing is ready sends
 *     the caller straight into a dialog that cannot render; answering "not
 *     ready" forever hangs startup.
 *   - `quit()` — a `quit` that does not quit leaves the app running on a
 *     database it has already condemned, which is the windowless-hang shape the
 *     founder ruled against on this very item.
 */
export class UnavailableAppLifecycle implements AppLifecycle {
  isPackaged(): boolean {
    throw new AppLifecycleUnavailableError("isPackaged");
  }

  isReady(): boolean {
    throw new AppLifecycleUnavailableError("isReady");
  }

  whenReady(): Promise<void> {
    throw new AppLifecycleUnavailableError("whenReady");
  }

  quit(): void {
    throw new AppLifecycleUnavailableError("quit");
  }
}
