/**
 * The Electron shell's {@link Logger}: `electron-log` (BACKLOG-2962).
 *
 * This is the ONLY place in the core's dependency closure that may import
 * `electron-log`. `scripts/ci/check-native-capabilities.mjs` enforces that for
 * every module on its PORTABLE list, and
 * `electron/capabilities/__tests__/coreLoadsWithoutElectron.test.ts` asserts the
 * same property at runtime by loading those modules with `electron-log` made to
 * throw.
 *
 * The shell's own files (`main.ts`, `bootstrap/installAppDataPaths.ts`,
 * `bootstrap/installNativeCapabilities.ts`) still import `electron-log`
 * directly and are not affected: they are the shell. In particular the
 * composition root's startup-failure handler writes with `electron-log`
 * directly and must keep doing so — routing "a capability is missing" through
 * a capability would be circular, and it runs while the registry is by
 * definition incomplete.
 *
 * WHY IT IS A THIN FORWARDER AND NOTHING ELSE
 * -------------------------------------------
 * Every byte that reaches `main.log` is decided by `electron-log`'s own
 * formatter and by the string `logService.formatLogEntry()` builds. This class
 * adds neither a prefix nor a level mapping nor a scope. The variadic tail is
 * spread through rather than collapsed, because `electron-log` joins extra
 * arguments with a space when it formats — four call sites in this codebase
 * rely on that (`databaseService.ts:310, 605, 691, 769`).
 *
 * @module electron/capabilities/electron/electronLogger
 */

import log from "electron-log";

import type { Logger } from "../logger";

/** {@link Logger} backed by `electron-log`'s default instance. */
export class ElectronLogger implements Logger {
  debug(message: string, ...args: unknown[]): void {
    log.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    log.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    log.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    log.error(message, ...args);
  }
}
