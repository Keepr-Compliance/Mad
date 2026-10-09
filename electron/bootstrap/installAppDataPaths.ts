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
import { installLogRedactionHook } from "../config/logFileConfig";
import { setLogDirectoryResolver } from "../services/logScrub";
import { installSealedFileTransport } from "../config/sealedLogTransport";
import { getLogSink } from "../services/sealedLogSink";

// BACKLOG-3819: redact customer emails and phone numbers from every log line.
// Installed here, the first import in main.ts, because modules imported after
// this one (installSentry, installNativeCapabilities, services) already log
// during import — main.ts's own `applyLogFileConfig` line runs too late for
// those writes. Unconditional: dev and packaged builds both redact.
installLogRedactionHook(log);
// BACKLOG-3819: log files are encrypted at rest. The file transport is replaced
// HERE, before any module can write, so no line ever reaches main.log as
// plaintext. Until the data key opens (atRest/startup.ts "logs" job, after the
// database opens) lines are held in memory; see services/sealedLogSink.ts for
// the plaintext window. If the process ends first, the held lines are written,
// redacted, to main.unsealed.log and sealed at the next launch.
installSealedFileTransport(log as unknown as { transports: Record<string, unknown> }, getLogSink());
process.on("exit", () => getLogSink().flushAtExit());
// Where the at-rest startup job (atRest/startup.ts "logs") applies retention and
// the one-time scrub. Resolved when the job runs, after any path override below.
setLogDirectoryResolver(() => path.dirname(log.transports.file.getFile().path));

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
