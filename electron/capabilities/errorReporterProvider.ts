/**
 * The composition seam for {@link ErrorReporter} (BACKLOG-2962, seam 2 of 5).
 *
 * Same shape and the same reasoning as `secretStoreProvider` and
 * `loggerProvider`: core modules bind {@link hostErrorReporter}, a forwarder
 * that resolves to whatever the host shell installed, so no core module has to
 * import `@sentry/electron/main` to obtain one.
 *
 * WHY A FORWARDER AND NOT AN INJECTED PARAMETER
 * ---------------------------------------------
 * The 35 call sites are spread over free functions (`schemas/validate.ts`,
 * `autoLinkService.ts`) and methods of long-lived singletons. Threading a
 * reporter through every one of those signatures would be a refactor of the
 * call graph rather than a seam, and error reporting is exactly the concern
 * that must not make a signature harder to call.
 *
 * ORDERING
 * --------
 * {@link hostErrorReporter} forwards at CALL time, so a module may be imported
 * before {@link installErrorReporter} runs. The Electron shell installs it from
 * `electron/bootstrap/installNativeCapabilities`, a side-effect import at
 * `main.ts:12`. Note what that does NOT mean: `Sentry.init()` still happens in
 * `main.ts` on the shell's own schedule, and events captured before it are
 * dropped by the SDK exactly as they are today. This seam changes who holds the
 * reference, not when the SDK becomes live.
 *
 * @module electron/capabilities/errorReporterProvider
 */

import {
  SilentErrorReporter,
  type Breadcrumb,
  type CaptureExceptionOptions,
  type CaptureMessageOptions,
  type ErrorReporter,
  type ReportedUser,
} from "./errorReporter";

let installed: ErrorReporter = new SilentErrorReporter();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installErrorReporter(reporter: ErrorReporter): void {
  installed = reporter;
}

/**
 * Drop back to the silent {@link SilentErrorReporter}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetErrorReporter(): void {
  installed = new SilentErrorReporter();
}

/** The currently installed implementation. */
export function getErrorReporter(): ErrorReporter {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check lives HERE, beside the only `new SilentErrorReporter()`
 * sites, for the reason `secretStoreProvider` records: `jest.isolateModules`
 * gives a class loaded twice two distinct constructors, and an `instanceof`
 * written across that boundary answers `false` for an object that really is one.
 */
export function isErrorReporterInstalled(): boolean {
  return !(installed instanceof SilentErrorReporter);
}

/**
 * An {@link ErrorReporter} that forwards each call to the installed
 * implementation at the moment of the call.
 */
export const hostErrorReporter: ErrorReporter = {
  captureException: (error: unknown, options?: CaptureExceptionOptions) =>
    installed.captureException(error, options),
  captureMessage: (message: string, options?: CaptureMessageOptions) =>
    installed.captureMessage(message, options),
  addBreadcrumb: (breadcrumb: Breadcrumb) => installed.addBreadcrumb(breadcrumb),
  flush: (timeoutMs?: number) => installed.flush(timeoutMs),
  setUser: (user: ReportedUser | null) => installed.setUser(user),
};
