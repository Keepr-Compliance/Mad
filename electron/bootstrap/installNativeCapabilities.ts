/**
 * The Electron shell's composition root for native capabilities (BACKLOG-2962).
 *
 * Imported for its side effect from `main.ts`, in the same style as
 * `installAppDataPaths` — this is the single place where the Electron shell
 * declares which implementation of each capability the core will get.
 *
 * Import position matters less here than it does for `installAppDataPaths`,
 * because `hostSecretStore` forwards at call time and nothing calls the store
 * during module construction. It still belongs near the top: the rule is
 * "install before anything can call", and the cheapest way to keep that true as
 * the codebase changes is to install first.
 *
 * TWO GUARDS WATCH THIS FILE, AND YOU CANNOT DELETE EITHER QUIETLY
 * ---------------------------------------------------------------
 * 1. `assertNativeCapabilitiesInstalled()` below is the RUNTIME guard: it
 *    throws during `main.ts` module evaluation if this file finished without
 *    installing something the core will demand. That is before
 *    `app.whenReady()` and therefore before the window opens. The `catch`
 *    below turns that throw into a Sentry event, a named error box and a
 *    non-zero exit — see "WHAT HAPPENS WHEN IT FIRES".
 * 2. `electron/capabilities/__tests__/compositionRootGuard.test.ts` is the
 *    STATIC guard: it AST-matches every `installFunction` in
 *    `NATIVE_CAPABILITIES` — **and the `assertNativeCapabilitiesInstalled()`
 *    call itself** — against this file, and asserts `main.ts` still imports it.
 *    Deleting the assertion line below takes that test red.
 *
 * WHAT HAPPENS WHEN IT FIRES — and why the handling is HERE
 * ---------------------------------------------------------
 * Founder decision, BACKLOG-2962: the app must say what is missing and then
 * DIE, rather than sit in the Dock with no window.
 *
 * Before this `catch` existed, the throw left this module during `main.ts`'s
 * evaluation at its line 12, and:
 *
 *   - `main.ts`'s own `process.on("uncaughtException")` could not run. It is
 *     registered at `main.ts:259`, BELOW the import at line 12, so at this
 *     point it does not exist yet — and its body would not have helped: it
 *     logs, and says in its own comments not to exit and not to show a dialog.
 *   - Electron's single default `uncaughtException` listener, installed before
 *     the main script loads, handled it instead: `App threw an error during
 *     load` plus the stack on stderr, then a modal error box reached through
 *     an async `import("electron")` — several seconds after the throw — and
 *     then a process that KEPT RUNNING, windowless, before and after OK.
 *
 * All of that was MEASURED on this repo's own Electron binary by SR's review of
 * PR #2515 (probes A, B and C), not traced.
 *
 * The assertion's throw no longer escapes, so neither handler is involved and
 * the behaviour does not depend on how much of `main.ts` has evaluated. Only
 * the assertion's: `installSecretStore(new ElectronSecretStore())` sits outside
 * the `try` deliberately, because a constructor that throws is a different
 * failure with a different message, and swallowing it into this box would
 * mislabel it. That is
 * also why the handling lives here rather than in `main.ts`: a TypeScript
 * `import` statement cannot be wrapped in `try`/`catch`, so catching there
 * would mean rewriting `main.ts:12` as a `require()` call — which rule E1 does
 * not recognise as an entry import, taking this item's own static guard red.
 *
 * SENTRY, AND WHAT WAITING FOR IT CHANGES (BACKLOG-2962 follow-up, 2026-09-06)
 * ---------------------------------------------------------------------------
 * The founder's launch probe at `139913c51` passed and then asked "did it also
 * fire a Sentry log?" — no, by construction: `Sentry.init` sat at `main.ts:223`,
 * after this module, and this `catch` never called it. Now `main.ts` imports
 * `./installSentry` ABOVE this module, and the `catch` captures the error and
 * waits for the flush before the box. Two consequences, both traced at
 * `139913c51` and since MEASURED on this repo's own binary at `a6afebc1c` by
 * SR's review of PR #2535 (pm_comments `692ff00b`) — with a DSN the event
 * lands in Sentry, `main.ts` evaluates to the end, and a Dock icon with NO
 * window shows for ~1.5 s (box +1559 ms after the failure, after `ready`)
 * before the box and `exit 1`; with no DSN the behaviour is identical to what
 * the founder observed at `139913c51` (box +1130 ms, still before `ready`):
 *
 *   1. With Sentry ENABLED the box comes AFTER `ready`. The Electron transport
 *      sends only once `app.whenReady()` resolves (`@sentry/electron/main`
 *      `transports/electron-net.js`), so no flush can settle before `ready`.
 *      Up to `SENTRY_FLUSH_TIMEOUT_MS` may pass between the failure and the
 *      box. With Sentry DISABLED (no DSN → no transport) the flush resolves at
 *      once and the box follows on the microtask after `main.ts` finishes
 *      evaluating — still before `ready`, which is a macrotask.
 *   2. `main.ts` keeps evaluating while the flush is pending, because an
 *      `import` cannot be caught and this `catch` no longer blocks. Its
 *      ready-time paths are told to stand down through `./startupFailure`,
 *      which this `catch` writes BEFORE anything asynchronous starts. The
 *      three sites are listed in that module's header and pinned by
 *      `electron/__tests__/main.startupFailureGuards-2962.test.ts`.
 *
 * SR's #2518 ruling on `app.exit(1)` ("its safety is a consequence of WHERE the
 * catch sits ... if the catch ever moves into any post-ready path this ruling
 * must be re-derived") is re-derived here: the exit may now run after `ready`,
 * when `main.ts`'s `before-quit` handlers exist — but the `whenReady` body
 * returned at its first statement, so no worker pool, backup or interval was
 * ever started and those handlers have nothing to end. `exit`, not `quit`,
 * for the same reasons as before: not cancellable, carries the code.
 *
 * `dialog.showErrorBox` is the one dialog API usable before `app.whenReady()`.
 * Measured rather than assumed, though not by me: SR's probe C watched
 * Electron's own default handler render a `showErrorBox` at this same point in
 * the lifecycle, while `whenReady()` was never reached. That box was Electron's
 * own, titled "A JavaScript error occurred in the main process" — so what is
 * established is the API working pre-ready, not this call site's box. Visual
 * confirmation of THIS box is the founder's launch test, not something any
 * instrument here has shown. `app.exit(1)` rather than `app.quit()` — quit runs
 * `before-quit` handlers and can be cancelled, while exit ends the process
 * immediately with the code, so crash reporting and the updater see a failed
 * launch.
 *
 * @module electron/bootstrap/installNativeCapabilities
 */

import { app, dialog } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";

import { recordStartupFailure } from "./startupFailure";
import { installLogger } from "../capabilities/loggerProvider";
import { ElectronLogger } from "../capabilities/electron/electronLogger";
import { installErrorReporter } from "../capabilities/errorReporterProvider";
import { ElectronErrorReporter } from "../capabilities/electron/electronErrorReporter";
import { installAppPaths } from "../capabilities/appPathsProvider";
import { ElectronAppPaths } from "../capabilities/electron/electronAppPaths";
import { installWindows } from "../capabilities/windowsProvider";
import { ElectronWindows } from "../capabilities/electron/electronWindows";
import { installAppLifecycle } from "../capabilities/appLifecycleProvider";
import { ElectronAppLifecycle } from "../capabilities/electron/electronAppLifecycle";
import { installDialog } from "../capabilities/dialogProvider";
import { ElectronDialog } from "../capabilities/electron/electronDialog";
import { installSecretStore } from "../capabilities/secretStoreProvider";
import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";
import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";

/** Title of the error box shown when a capability is missing at launch. */
export const STARTUP_FAILURE_TITLE = "Keepr cannot start";

/**
 * How long the fatal path waits for Sentry before showing the box and exiting.
 * Sentry's own `shutdownTimeout` default, and what its uncaught-exception
 * integration waits before its dialog.
 */
export const SENTRY_FLUSH_TIMEOUT_MS = 2000;

// Logger FIRST, so that anything a later installer's constructor might log
// reaches the file transport rather than the silent default. Nothing logs
// during construction today; installing first is what keeps that cheap to stay
// true. `installAppDataPaths` (main.ts:6) has already pointed electron-log at
// the right directory, so the first line written from here lands in the right
// file.
installLogger(new ElectronLogger());
installErrorReporter(new ElectronErrorReporter());
// `ElectronAppPaths` reads `app.getPath` per call, never at construction, so
// installing it here does NOT freeze the value `installAppDataPaths`
// (main.ts:6, which has already run) set. Rule E2 keeps that import first.
installAppPaths(new ElectronAppPaths());
// `ElectronWindows` calls `BrowserWindow.getAllWindows()` per broadcast and
// holds no window handle, so installing it here — long before any window
// exists — captures nothing that could go stale.
installWindows(new ElectronWindows());
// The `dialog.showErrorBox` in the catch below is NOT routed through this
// capability, deliberately. This file is the shell: it runs before any
// capability is trusted, and reporting "a capability is missing" through a
// capability would be circular — the box would be the thing that failed. What
// is established about `showErrorBox` working at this point in the lifecycle is
// recorded in this file's header, and it is SR's measurement of Electron's own
// default handler, not of this call site.
installDialog(new ElectronDialog());
// `ElectronAppLifecycle` reads `app.isPackaged` per call rather than at
// construction, so installing it here — during `main.ts` evaluation, long before
// `ready` — freezes nothing.
installAppLifecycle(new ElectronAppLifecycle());
installSecretStore(new ElectronSecretStore());

// LAST — every capability above must now answer `isInstalled()`.
try {
  assertNativeCapabilitiesInstalled();
} catch (error) {
  // `error.message` names every uninstalled capability, and is passed through
  // verbatim: the whole value of this guard is that whoever reads the box is
  // told WHICH capability is missing.
  const message = error instanceof Error ? error.message : String(error);
  // TEXT FIRST, and both sinks. The box is dismissed and gone; a support report
  // needs something that stays. `console.error` reaches the terminal running
  // `npm run dev`, and any unattended launch that nobody is there to dismiss the
  // box for; `log.error` reaches the log file, which by now points at the right
  // directory because `installAppDataPaths` (main.ts:6) ran first. The whole
  // `error` is passed, not just `message`, so both sinks carry the stack.
  //
  // This mirrors `main.ts:261-262`, the app's only other fatal path, down to the
  // order. It deliberately does NOT use `logService`: `main.ts` does not either,
  // and that wrapper only writes a file once a `logDirectory` is configured,
  // which nothing has done at this point in startup.
  console.error("[FATAL] Native capability missing:", error);
  log.error("[FATAL] Native capability missing:", error);
  // RECORD, before anything asynchronous. `main.ts` keeps evaluating after
  // this module returns, and its ready-time paths consult this record — see
  // `./startupFailure` and this file's header, "what waiting for it changes".
  const failure = error instanceof Error ? error : new Error(message);
  recordStartupFailure(failure);
  // SENTRY, before the box. Raw `Sentry`, not the ErrorReporter capability,
  // for the reason the box below is raw `dialog`: this is the shell reporting
  // that a capability is missing, and reporting through a capability would be
  // circular. `Sentry.init` has already run — `main.ts` imports
  // `./installSentry` above this module, and `installSentry.test.ts` pins
  // that order. When Sentry is disabled (no DSN) the capture is dropped inside
  // Sentry, not raised.
  Sentry.captureException(failure, {
    tags: { component: "composition-root" },
    extra: { missingCapabilities: message },
  });
  // FLUSH, then box, then exit. `app.exit(1)` ends the process at once, so an
  // event still inside the transport dies with it; the flush waits for it, up
  // to SENTRY_FLUSH_TIMEOUT_MS. This is module scope in CommonJS, so it cannot
  // `await`: the box and the exit move into the continuation. The `.catch`
  // is what keeps a rejected flush from skipping them — and it LOGS, because a
  // rejected flush is the one case where this file's promise (the event reached
  // Sentry) has failed, and a missing event with no local line is
  // undiagnosable. It is still not a reason to leave the process windowless and
  // alive. Box before exit within the continuation for the reason SR measured
  // on #2518: exiting first ends the process before the box is reached.
  void Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)
    .catch((flushError) => {
      log.error("[FATAL] Sentry flush failed before exit:", flushError);
    })
    .then(() => {
      dialog.showErrorBox(STARTUP_FAILURE_TITLE, message);
      app.exit(1);
    });
}
