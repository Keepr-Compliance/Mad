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

import log from "electron-log";
import path from "path";
import { applyAppDataPaths, buildConsoleNotice } from "./appDataPaths";

const applied = applyAppDataPaths();

if (applied) {
  // `app.setPath("logs", ...)` is NOT enough, and this was caught by running the
  // control rather than by reading the code: a dev launch still moved the mtime
  // of the production ~/Library/Logs/keepr/main.log. electron-log v5 builds its
  // default macOS path from the app NAME itself rather than from
  // `app.getPath("logs")`, so the transport has to be pointed at the dev
  // directory explicitly.
  //
  // This must happen here, not at main.ts's `log.transports.file.level` line:
  // main.ts already logs during module evaluation, well before that line runs,
  // and those early writes would land in the production log.
  log.transports.file.resolvePathFn = () =>
    path.join(applied.dir, "logs", "main.log");

  // Deliberately `console` and not `logService`: this must reach the terminal
  // running `npm run dev`, and it runs before logging is configured.
  // eslint-disable-next-line no-console
  console.warn(buildConsoleNotice(applied));
}
