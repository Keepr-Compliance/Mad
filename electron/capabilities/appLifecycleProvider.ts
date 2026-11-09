/**
 * The composition seam for {@link AppLifecycle} (BACKLOG-2962).
 *
 * Same shape as the other four providers: core modules bind
 * {@link hostAppLifecycle}, a forwarder that resolves to whatever the host shell
 * installed.
 *
 * ORDERING
 * --------
 * {@link hostAppLifecycle} forwards at CALL time, and no core module asks about
 * readiness or quits during module construction — all seven call sites are
 * inside `DatabaseService.initialize()`. So no answer is captured at install
 * time, and installing this before `app.whenReady()` in the composition root is
 * not merely safe but required: the composition root runs during `main.ts`
 * evaluation, which is before ready by construction.
 *
 * @module electron/capabilities/appLifecycleProvider
 */

import { UnavailableAppLifecycle, type AppLifecycle } from "./appLifecycle";

let installed: AppLifecycle = new UnavailableAppLifecycle();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installAppLifecycle(lifecycle: AppLifecycle): void {
  installed = lifecycle;
}

/**
 * Drop back to the throwing {@link UnavailableAppLifecycle}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetAppLifecycle(): void {
  installed = new UnavailableAppLifecycle();
}

/** The currently installed implementation. */
export function getAppLifecycle(): AppLifecycle {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check lives HERE, beside the only
 * `new UnavailableAppLifecycle()` sites, for the reason `secretStoreProvider`
 * records: `jest.isolateModules` gives a class loaded twice two distinct
 * constructors, and an `instanceof` written across that boundary answers `false`
 * for an object that really is one.
 */
export function isAppLifecycleInstalled(): boolean {
  return !(installed instanceof UnavailableAppLifecycle);
}

/**
 * An {@link AppLifecycle} that forwards each call to the installed
 * implementation at the moment of the call.
 */
export const hostAppLifecycle: AppLifecycle = {
  isPackaged: () => installed.isPackaged(),
  isReady: () => installed.isReady(),
  whenReady: () => installed.whenReady(),
  quit: () => installed.quit(),
};
