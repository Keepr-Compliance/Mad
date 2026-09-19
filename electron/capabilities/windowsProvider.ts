/**
 * The composition seam for {@link Windows} (BACKLOG-2962, seam 4 of 5).
 *
 * Same shape as `secretStoreProvider`, `loggerProvider`, `errorReporterProvider`
 * and `appPathsProvider`: core modules bind {@link hostWindows}, a forwarder
 * that resolves to whatever the host shell installed.
 *
 * ORDERING
 * --------
 * {@link hostWindows} forwards at CALL time, and neither caller broadcasts
 * during module construction — `initializationBroadcaster` broadcasts from
 * `broadcast()`, `reviewStateService` from `broadcastReviewQueueChanged()`, both
 * of which run in response to work. So installing anywhere in the composition
 * root is early enough, and no window handle is captured at install time.
 *
 * @module electron/capabilities/windowsProvider
 */

import { SilentWindows, type Windows } from "./windows";

let installed: Windows = new SilentWindows();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installWindows(windows: Windows): void {
  installed = windows;
}

/**
 * Drop back to the delivering-nothing {@link SilentWindows}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetWindows(): void {
  installed = new SilentWindows();
}

/** The currently installed implementation. */
export function getWindows(): Windows {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check lives HERE, beside the only `new SilentWindows()`
 * sites, for the reason `secretStoreProvider` records: `jest.isolateModules`
 * gives a class loaded twice two distinct constructors, and an `instanceof`
 * written across that boundary answers `false` for an object that really is one.
 *
 * This predicate carries more weight for this capability than for most: the
 * default is silent, so the guard is the ONLY thing that can notice a missing
 * install. Nothing at a call site will.
 */
export function isWindowsInstalled(): boolean {
  return !(installed instanceof SilentWindows);
}

/**
 * A {@link Windows} that forwards each call to the installed implementation at
 * the moment of the call.
 */
export const hostWindows: Windows = {
  broadcast: (channel, payload) => installed.broadcast(channel, payload),
};
