/**
 * The composition seam for {@link Logger} (BACKLOG-2962, seam 1 of 5).
 *
 * Same shape and the same reasoning as `secretStoreProvider`: core modules bind
 * {@link hostLogger}, a forwarder that resolves to whatever the host shell
 * installed, so no core module has to import `electron-log` to obtain one. The
 * import IS the coupling — a module that opens with
 * `import log from "electron-log"` cannot be loaded by a non-Electron shell
 * whatever it does at runtime.
 *
 * WHY A FORWARDER AND NOT AN INJECTED PARAMETER
 * ---------------------------------------------
 * `SecretStore` is taken as a constructor parameter because its consumers are a
 * handful of classes. Logging is not that shape: `logService.ts` is a
 * module-level singleton, `schemas/validate.ts` is a set of free functions, and
 * `databaseService.ts` logs from six methods on a 2,215-line class. Threading a
 * logger through every one of those signatures would be a behaviour-preserving
 * refactor of the whole call graph, not a seam. The forwarder gives the same
 * decoupling with a one-line change per call site.
 *
 * ORDERING
 * --------
 * {@link hostLogger} forwards at CALL time, not at bind time, so a module may
 * be imported before {@link installLogger} runs. That is not licence to install
 * late: `electron/bootstrap/installNativeCapabilities` is a side-effect import
 * at `main.ts:12`, and `installAppDataPaths` at `main.ts:6` has already pointed
 * `electron-log`'s file transport at the right directory by then. Verified when
 * this was written: none of the four consumers logs at module-construction
 * time, so no current path can observe the uninstalled default.
 *
 * @module electron/capabilities/loggerProvider
 */

import { SilentLogger, type Logger } from "./logger";

let installed: Logger = new SilentLogger();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installLogger(logger: Logger): void {
  installed = logger;
}

/**
 * Drop back to the silent {@link SilentLogger}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetLogger(): void {
  installed = new SilentLogger();
}

/** The currently installed implementation. */
export function getLogger(): Logger {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check deliberately lives HERE, in the module that imports
 * the class, for the reason `secretStoreProvider` records: `jest.isolateModules`
 * creates a fresh module registry, and a class loaded twice produces two
 * distinct constructors, so an `instanceof` written across that boundary
 * answers `false` for an object that really is a `SilentLogger`. Keeping the
 * comparison next to the only `new SilentLogger()` sites means both sides
 * always come from the same registry.
 */
export function isLoggerInstalled(): boolean {
  return !(installed instanceof SilentLogger);
}

/**
 * A {@link Logger} that forwards each call to the installed implementation at
 * the moment of the call.
 *
 * Method dispatch happens per call and the underlying function is never
 * captured, so a test that reconfigures its fake between cases still sees the
 * new behaviour.
 */
export const hostLogger: Logger = {
  debug: (message: string, ...args: unknown[]) => installed.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => installed.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => installed.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => installed.error(message, ...args),
};
