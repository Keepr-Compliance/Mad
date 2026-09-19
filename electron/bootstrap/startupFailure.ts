/**
 * The one fact the composition root leaves behind when it fails (BACKLOG-2962).
 *
 * `installNativeCapabilities.ts` cannot stop `main.ts` from evaluating: a
 * TypeScript `import` cannot be caught, and the only thing that ends module
 * evaluation early is a throw — which lands on Electron's default handler, the
 * windowless hang SR measured on PR #2515. So when the fatal `catch` fires, the
 * rest of `main.ts` still runs while the Sentry flush is pending, and three of
 * its paths would act on a half-built shell:
 *
 *   - the lost single-instance lock's `app.quit()` — exit 0, before the exit 1
 *   - the `whenReady` body — `runStartupHealthChecks()` demands the missing
 *     capability; `createWindow()` opens a window
 *   - `activate` — `createWindow()` again, on first launch on macOS
 *
 * Each reads {@link getStartupFailure} first and stands down. This module has
 * no Electron import so that reading it costs nothing anywhere, and it holds a
 * single value rather than an event because the record is set exactly once,
 * synchronously, before anything that could consult it has run.
 *
 * `electron/__tests__/main.startupFailureGuards-2962.test.ts` pins the three
 * `main.ts` sites by source shape; `installNativeCapabilities.startupFailure.test.ts`
 * pins that the composition root writes the record before it flushes.
 *
 * @module electron/bootstrap/startupFailure
 */

let failure: Error | null = null;

/** Called once by the composition root's fatal `catch`, before its flush. */
export function recordStartupFailure(error: Error): void {
  failure = error;
}

/** The recorded failure, or `null` when the shell installed every capability. */
export function getStartupFailure(): Error | null {
  return failure;
}
