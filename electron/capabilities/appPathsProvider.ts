/**
 * The composition seam for {@link AppPaths} (BACKLOG-2962, seam 3 of 5).
 *
 * Same shape as `secretStoreProvider`, `loggerProvider` and
 * `errorReporterProvider`: core modules bind {@link hostAppPaths}, a forwarder
 * that resolves to whatever the host shell installed.
 *
 * ORDERING — THIS ONE HAS A REAL CONSTRAINT, NOT A PREFERENCE
 * -----------------------------------------------------------
 * `electron/main.ts:6` imports `./bootstrap/installAppDataPaths`, which calls
 * `app.setPath("userData", …)` for development builds. `main.ts:12` imports the
 * composition root, which installs this capability. Both are top-level imports
 * and TypeScript's CommonJS emit preserves statement order, so the override
 * always runs first — and rule E2 in
 * `electron/capabilities/__tests__/compositionRootGuard.test.ts` keeps it that
 * way by asserting `main.ts:6` is the FIRST statement.
 *
 * That is only half of what makes this safe. The other half is that
 * {@link hostAppPaths} forwards at CALL time and `ElectronAppPaths.userData()`
 * calls `app.getPath` at call time: no path is captured at install time, so
 * even a later `setPath` is respected. Nothing in the core reads a path during
 * module construction — verified when this was written; the three consumers
 * read inside `initializePaths()`, `initialize()` and `hasKeyStore()`.
 *
 * @module electron/capabilities/appPathsProvider
 */

import { UnavailableAppPaths, type AppPaths } from "./appPaths";

let installed: AppPaths = new UnavailableAppPaths();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installAppPaths(paths: AppPaths): void {
  installed = paths;
}

/**
 * Drop back to the throwing {@link UnavailableAppPaths}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetAppPaths(): void {
  installed = new UnavailableAppPaths();
}

/** The currently installed implementation. */
export function getAppPaths(): AppPaths {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check lives HERE, beside the only `new UnavailableAppPaths()`
 * sites, for the reason `secretStoreProvider` records: `jest.isolateModules`
 * gives a class loaded twice two distinct constructors, and an `instanceof`
 * written across that boundary answers `false` for an object that really is one.
 */
export function isAppPathsInstalled(): boolean {
  return !(installed instanceof UnavailableAppPaths);
}

/**
 * An {@link AppPaths} that forwards each call to the installed implementation
 * at the moment of the call.
 */
export const hostAppPaths: AppPaths = {
  userData: () => installed.userData(),
};
