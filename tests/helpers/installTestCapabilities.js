/**
 * Install the non-secret native capabilities for a jest "shell"
 * (BACKLOG-2962, seams PR A).
 *
 * WHY THIS FILE EXISTS, BESIDE `installTestSecretStore`
 * ----------------------------------------------------
 * Same premise as its sibling: a jest run is just another host shell, and every
 * host has to say which implementation the core gets. Electron says so in
 * `electron/bootstrap/installNativeCapabilities.ts`; `tests/setup.js` says so
 * here. Without it, every suite that reaches a `hostLogger` call would exercise the
 * uninstalled default instead of the path it was written to test — 22 suites
 * assert on the `electron-log` mock, 6 on the `@sentry/electron` mock, and 62
 * mock `electron` with their own `getPath`.
 *
 * WHY IT RESOLVES THE SDK AT CALL TIME, WHEN `installTestSecretStore` DOES NOT
 * ---------------------------------------------------------------------------
 * `installTestSecretStore` reads `require("electron").safeStorage` at INSTALL
 * time and installs that object, so it must be called again by any suite whose
 * own `jest.mock("electron", …)` factory is registered later — six suites do.
 * The forwarders below instead call `require(…)` inside each method, so they
 * resolve against whatever module registry is in force AT THE MOMENT OF THE
 * CALL. A suite's own factory is therefore honoured with no second call, which
 * is what keeps suites like `electron/schemas/__tests__/validate.test.ts`
 * (`jest.mock('electron-log', …)` + `expect(log.warn).toHaveBeenCalledWith(…)`)
 * passing byte-for-byte unchanged.
 *
 * This is a TEST-shell concession and it lives only here. The production
 * adapters (`electron/capabilities/electron/*.ts`) take ordinary top-level
 * imports; there is one Electron in a real launch and nothing re-registers it.
 *
 * WHAT IT DOES NOT SOLVE
 * ----------------------
 * `jest.resetModules()` throws the registry away, so the next `require` of a
 * provider returns a BRAND NEW module with nothing installed. No jest hook fires
 * after an in-test reset. Suites that reset and then reach one of these
 * capabilities must call this themselves afterwards — exactly as they already
 * do for `installTestSecretStore`. That matters most for AppPaths, whose default
 * throws — a path accessor has no honest no-op.
 */

/** The `electron` mock's `app`. */
function currentApp() {
  const { app } = require("electron");
  if (!app) {
    throw new Error(
      "installTestCapabilities(): the `electron` mock in force has no `app`. " +
        "A suite that mocks `electron` with its own factory must include one, or " +
        "install an AppPaths of its own via installAppPaths().",
    );
  }
  return app;
}

/** The `@sentry/electron/main` namespace as the mock in force exposes it. */
function currentSentry() {
  const mod = require("@sentry/electron/main");
  return mod && mod.default && mod.default.captureException ? mod.default : mod;
}

/**
 * The `electron` mock's `BrowserWindow`.
 *
 * NO friendly guard here, on purpose — unlike `currentApp()`. The shared
 * `tests/__mocks__/electron.js` mocks `BrowserWindow` as a constructor with no
 * `getAllWindows` static, so a suite that reaches a broadcast without supplying
 * its own mock gets `TypeError: ...getAllWindows is not a function` from inside
 * the caller's own `try` — which is exactly what it got before this seam
 * existed, including the message `initializationBroadcaster` logs at debug.
 * Replacing that with a nicer error would change a log line 20 suites can see.
 */
function currentBrowserWindow() {
  const { BrowserWindow } = require("electron");
  return BrowserWindow;
}

/**
 * The `electron` mock's `dialog`.
 *
 * No friendly guard, for `currentBrowserWindow()`'s reason: a suite that reaches
 * a message box without one gets exactly the TypeError it got before this seam,
 * at the same place.
 */
function currentDialog() {
  const { dialog } = require("electron");
  return dialog;
}

/** `electron-log`'s default export, however the mock in force exposes it. */
function currentLog() {
  const mod = require("electron-log");
  return mod && mod.default ? mod.default : mod;
}

function installTestCapabilities() {
  const { installLogger } = require("../../electron/capabilities/loggerProvider");

  const {
    installErrorReporter,
  } = require("../../electron/capabilities/errorReporterProvider");
  const { installAppPaths } = require("../../electron/capabilities/appPathsProvider");
  const { installWindows } = require("../../electron/capabilities/windowsProvider");
  const { installDialog } = require("../../electron/capabilities/dialogProvider");
  const {
    installAppLifecycle,
  } = require("../../electron/capabilities/appLifecycleProvider");

  installLogger({
    debug: (message, ...args) => currentLog().debug(message, ...args),
    info: (message, ...args) => currentLog().info(message, ...args),
    warn: (message, ...args) => currentLog().warn(message, ...args),
    error: (message, ...args) => currentLog().error(message, ...args),
  });

  // Each method reaches the SDK property at call time, so a mock that omits one
  // — `tests/__mocks__/sentry-electron.js` has no `flush` — fails in exactly the
  // place and the same way it does today, rather than being papered over here.
  installErrorReporter({
    captureException: (error, options) => currentSentry().captureException(error, options),
    captureMessage: (message, options) => currentSentry().captureMessage(message, options),
    addBreadcrumb: (breadcrumb) => currentSentry().addBreadcrumb(breadcrumb),
    flush: (timeoutMs) => currentSentry().flush(timeoutMs),
    setUser: (user) => currentSentry().setUser(user),
  });

  // Resolved at call time for the same reason, and it matters more here: the
  // default throws, and 62 suites supply their own `electron` mock with their
  // own `getPath`. Binding one now would answer with the wrong directory for
  // every one of them.
  installAppPaths({
    userData: () => currentApp().getPath("userData"),
  });

  // The loop is TRANSCRIBED from `electron/capabilities/electron/electronWindows.ts`,
  // not paraphrased: ~20 suites supply their own `getAllWindows` and assert on
  // `webContents.send`, and every one of them depends on the two skip guards
  // behaving as they did when the loop sat inline in the two services. Resolved
  // at call time for the same reason AppPaths is — a suite's own `electron`
  // factory must win.
  // Forwarded BY REFERENCE, matching `ElectronDialog`: five suites assert on the
  // option object the production code builds, and a forwarder that rebuilt it
  // would make those assertions describe this file instead.
  installDialog({
    showMessageBox: (request) => currentDialog().showMessageBox(request),
  });

  // `isPackaged` is a PROPERTY on Electron's `app` and on the mock, so it is
  // read per call rather than bound — a suite that flips it between cases (the
  // KEEPR_TEST_DB_DELAY seam's own suite does) must see the new value.
  // `isReady` is deliberately NOT added to `tests/__mocks__/electron.js`: the
  // shared mock has never had one, so a suite reaching that path without its own
  // mock gets the same TypeError, in the same place, as it did before the seam.
  installAppLifecycle({
    isPackaged: () => currentApp().isPackaged,
    isReady: () => currentApp().isReady(),
    whenReady: () => currentApp().whenReady(),
    quit: () => currentApp().quit(),
  });

  installWindows({
    broadcast: (channel, payload) => {
      for (const win of currentBrowserWindow().getAllWindows()) {
        if (!win.isDestroyed() && win.webContents) {
          win.webContents.send(channel, payload);
        }
      }
    },
  });
}

module.exports = { installTestCapabilities };
