/**
 * The Electron shell's {@link AppLifecycle}: `app` (BACKLOG-2962).
 *
 * WHY EVERY MEMBER READS `app` INSIDE THE METHOD
 * -----------------------------------------------
 * `isPackaged` is Electron's only PROPERTY here, and it is the one that would
 * be tempting to capture at construction. It must not be: this adapter is
 * constructed during `main.ts` module evaluation, and reading a value there
 * freezes it — the shape `ElectronAppPaths` documents for `app.getPath`, and the
 * shape of the BACKLOG-2709 incident. `isReady()` obviously changes over the
 * process lifetime; so does the correct answer for the other three.
 *
 * `app.whenReady()` resolves with `void` in Electron and is passed straight
 * through. `quit()` is `app.quit()` — the cancellable, `before-quit`-running
 * shutdown the two call sites used — NOT `app.exit()`, which is the composition
 * root's fatal path and a different decision.
 *
 * @module electron/capabilities/electron/electronAppLifecycle
 */

import { app } from "electron";

import type { AppLifecycle } from "../appLifecycle";

/** {@link AppLifecycle} backed by Electron's `app`. */
export class ElectronAppLifecycle implements AppLifecycle {
  isPackaged(): boolean {
    return app.isPackaged;
  }

  isReady(): boolean {
    return app.isReady();
  }

  whenReady(): Promise<void> {
    return app.whenReady();
  }

  quit(): void {
    app.quit();
  }
}
