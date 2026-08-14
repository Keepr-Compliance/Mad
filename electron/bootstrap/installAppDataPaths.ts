/**
 * Side-effect entry point for the development data-directory override
 * (BACKLOG-2709).
 *
 * `main.ts` imports this module FIRST, before anything else, because the
 * override has to be in place before `app.requestSingleInstanceLock()` writes
 * `SingletonLock` into userData and before the first `electron-log` write picks
 * a log path.
 *
 * It exists as a separate module purely so `appDataPaths.ts` stays free of
 * import-time side effects and can be unit-tested.
 */

import { applyAppDataPaths, buildConsoleNotice } from "./appDataPaths";

const applied = applyAppDataPaths();

if (applied) {
  // Deliberately `console` and not `logService`: this must reach the terminal
  // running `npm run dev`, and it runs before logging is configured.
  // eslint-disable-next-line no-console
  console.warn(buildConsoleNotice(applied));
}
