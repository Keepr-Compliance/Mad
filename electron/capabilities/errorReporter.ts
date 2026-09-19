/**
 * Crash / error reporting, as an interface (BACKLOG-2962, seam 2 of 5).
 *
 * WHY THIS EXISTS
 * ---------------
 * `@sentry/electron/main` is Electron-main-only — the package name is not
 * incidental, it is the coupling. BACKLOG-2961's measurement (`pm_comments`
 * `4c10fdb4`) found seven of the ten Electron-touching modules in the
 * extraction closure reach the platform through it, and six of those reach it
 * through NOTHING ELSE. This interface is the cut.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a telemetry abstraction, and not a subset of the Sentry SDK chosen by
 * taste. The five methods and the exact option keys below were enumerated from
 * the 35 call sites in the closure, by parsing them rather than by reading
 * them:
 *
 *   | method             | sites | option keys the call sites actually pass |
 *   |--------------------|-------|------------------------------------------|
 *   | `captureException` |    16 | `tags` — and nothing else                 |
 *   | `addBreadcrumb`    |    13 | `category`, `message`, `level`, `data`    |
 *   | `flush`            |     3 | (a millisecond timeout)                   |
 *   | `captureMessage`   |     2 | `level`, `tags`, `extra`                  |
 *   | `setUser`          |     1 | `id`, `email`                             |
 *
 * `withScope`, `setTag`, `setContext`, `startTransaction` and the rest of the
 * SDK are absent because no core module calls them. `init()` is absent for a
 * stronger reason: initialising the reporter is a SHELL decision (it needs a
 * DSN, a release and an environment) and `electron/main.ts` already does it
 * directly. A core module must be able to report an error without being able to
 * configure where errors go.
 *
 * `level` is deliberately the two-value union the call sites use. Widening it
 * to Sentry's six speculatively would mean this file no longer describes the
 * codebase; a seventh caller that needs `"error"` adds it here, and the compile
 * error that prompts them to is the seam working, not the seam breaking.
 *
 * @module electron/capabilities/errorReporter
 */

/** A Sentry-style tag value: indexed, low-cardinality, never an object. */
export type TagValue = string | number | boolean | undefined;

/** Severity, restricted to the levels this codebase actually reports. */
export type ErrorLevel = "info" | "warning";

/** Options accepted by {@link ErrorReporter.captureException}. */
export interface CaptureExceptionOptions {
  tags?: Record<string, TagValue>;
}

/** Options accepted by {@link ErrorReporter.captureMessage}. */
export interface CaptureMessageOptions {
  level?: ErrorLevel;
  tags?: Record<string, TagValue>;
  extra?: Record<string, unknown>;
}

/** A trail entry attached to whatever event is reported next. */
export interface Breadcrumb {
  category?: string;
  message?: string;
  level?: ErrorLevel;
  data?: Record<string, unknown>;
}

/** Who the events belong to. */
export interface ReportedUser {
  id: string;
  email?: string;
}

/**
 * Report errors, messages and breadcrumbs to whatever the host shell uses.
 *
 * Implementations MUST NOT throw: every call site is either inside a `catch` or
 * on a startup path, and a reporter that throws while reporting turns a handled
 * failure into an unhandled one.
 */
export interface ErrorReporter {
  /** Report a thrown value. `error` is `unknown` because a `catch` binding is. */
  captureException(error: unknown, options?: CaptureExceptionOptions): void;

  /** Report an event that is not an exception. */
  captureMessage(message: string, options?: CaptureMessageOptions): void;

  /** Attach a breadcrumb to the next reported event. */
  addBreadcrumb(breadcrumb: Breadcrumb): void;

  /**
   * Wait for queued events to be sent.
   *
   * Called before a deliberate exit so a report is not lost with the process
   * (`databaseService.ts:405, 473, 1185`). Resolves `false` on timeout, which
   * every current caller ignores — they `await` it for the delay, not the
   * answer.
   */
  flush(timeoutMs?: number): Promise<boolean>;

  /** Attach a user to subsequent events. */
  setUser(user: ReportedUser | null): void;
}

/**
 * The {@link ErrorReporter} in force before a host shell installs one: it
 * reports nothing.
 *
 * WHY THIS DOES NOT THROW, WHEN `UnavailableSecretStore` DOES
 * -----------------------------------------------------------
 * Two reasons, and the second is the stronger one.
 *
 * 1. Every one of the 35 wrapped call sites is inside a `catch` or on a startup
 *    path. A throwing default would escape from inside an error handler — the
 *    worst possible place — and no happy-path test would see it.
 * 2. This default is not inventing a behaviour: it IS the SDK's behaviour. An
 *    uninitialised Sentry client drops events on the floor and returns, which
 *    is exactly what a Keepr build without a DSN configured does today. A
 *    throwing default would be LOUDER than the real thing, which makes it a
 *    behaviour change wearing a safety argument.
 *
 * "Nobody installed a reporter" is still impossible to reach in a shipped
 * build: `isErrorReporterInstalled()` + `assertNativeCapabilitiesInstalled()`
 * stop the launch and name the capability.
 */
export class SilentErrorReporter implements ErrorReporter {
  captureException(_error: unknown, _options?: CaptureExceptionOptions): void {
    /* intentionally silent — see the class doc for why this is not a throw */
  }

  captureMessage(_message: string, _options?: CaptureMessageOptions): void {
    /* intentionally silent */
  }

  addBreadcrumb(_breadcrumb: Breadcrumb): void {
    /* intentionally silent */
  }

  flush(_timeoutMs?: number): Promise<boolean> {
    // `true`, not `false`: there was nothing queued, so the flush succeeded
    // vacuously. The SDK answers the same way when nothing is pending.
    return Promise.resolve(true);
  }

  setUser(_user: ReportedUser | null): void {
    /* intentionally silent */
  }
}
