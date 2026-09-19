/**
 * The Electron shell's {@link ErrorReporter}: `@sentry/electron/main`
 * (BACKLOG-2962, seam 2 of 5).
 *
 * This is the only place in the core's dependency closure that may import the
 * Sentry SDK. The shell's own files still import it directly and are not
 * affected — `electron/main.ts` calls `Sentry.init()` with the DSN, the release
 * and the environment, which is a shell decision and stays one.
 *
 * WHY IT IS A THIN FORWARDER AND NOTHING ELSE
 * -------------------------------------------
 * The whole promise of this seam is that Sentry receives the SAME events with
 * the SAME tags it received before. So the options object is passed through by
 * reference — not rebuilt, not defaulted, not merged with anything — and the
 * method names map one-to-one. `electronErrorReporter.test.ts` asserts that by
 * identity (`toBe`, not `toEqual`) so a "harmless" reshaping cannot slip past.
 *
 * The interface's option types are structural subsets of the SDK's own, so no
 * cast is needed in either direction and nothing here has to know what a
 * `SeverityLevel` is.
 *
 * @module electron/capabilities/electron/electronErrorReporter
 */

import * as Sentry from "@sentry/electron/main";

import type {
  Breadcrumb,
  CaptureExceptionOptions,
  CaptureMessageOptions,
  ErrorReporter,
  ReportedUser,
} from "../errorReporter";

/** {@link ErrorReporter} backed by the Sentry Electron main-process SDK. */
export class ElectronErrorReporter implements ErrorReporter {
  captureException(error: unknown, options?: CaptureExceptionOptions): void {
    Sentry.captureException(error, options);
  }

  captureMessage(message: string, options?: CaptureMessageOptions): void {
    Sentry.captureMessage(message, options);
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    Sentry.addBreadcrumb(breadcrumb);
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return Sentry.flush(timeoutMs);
  }

  setUser(user: ReportedUser | null): void {
    Sentry.setUser(user);
  }
}
