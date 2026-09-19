/**
 * The AppPaths composition seam (BACKLOG-2962, seams PR A).
 *
 * Mirrors `loggerProvider.test.ts` and `errorReporterProvider.test.ts`, with
 * one deliberate difference asserted rather than described: this default
 * THROWS. A logger can honestly do nothing; a path accessor cannot, and every
 * substitute for a throw — `""`, `undefined`, a guessed platform default — puts
 * `path.join(…, "mad.db")` somewhere unintended, which is the shape of the
 * BACKLOG-2709 incident.
 */

import { AppPathsUnavailableError, UnavailableAppPaths, type AppPaths } from "../appPaths";
import {
  getAppPaths,
  hostAppPaths,
  installAppPaths,
  isAppPathsInstalled,
  resetAppPaths,
} from "../appPathsProvider";

const fake = (dir: string): AppPaths => ({ userData: () => dir });

describe("appPathsProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later case in this file inherits the throwing default.
    installAppPaths(fake("/tmp/test-user-data"));
  });

  it("reports NOT installed while the throwing default is in force", () => {
    resetAppPaths();
    expect(isAppPathsInstalled()).toBe(false);
    expect(getAppPaths()).toBeInstanceOf(UnavailableAppPaths);
  });

  it("the default THROWS a named error — the deliberate divergence from Logger and ErrorReporter", () => {
    resetAppPaths();
    expect(() => hostAppPaths.userData()).toThrow(AppPathsUnavailableError);
    // The message names the capability and points at the composition root, so a
    // developer meeting it in a new shell is told what to do rather than what
    // went wrong.
    expect(() => hostAppPaths.userData()).toThrow(/userData cannot be resolved/);
    expect(() => hostAppPaths.userData()).toThrow(/installNativeCapabilities/);
  });

  it("hostAppPaths forwards to whatever is installed", () => {
    installAppPaths(fake("/tmp/test-user-data"));
    expect(hostAppPaths.userData()).toBe("/tmp/test-user-data");
  });

  it("forwards at CALL time, not at bind time", () => {
    // `dbConnection`, `databaseService` and `databaseEncryptionService` all bind
    // `hostAppPaths` when their module loads, which is before any shell has
    // installed anything.
    resetAppPaths();
    const bound = hostAppPaths;
    installAppPaths(fake("/tmp/installed-later"));
    expect(bound.userData()).toBe("/tmp/installed-later");
  });

  it("reads the answer per call, so an override after install is respected", () => {
    // This is the property that keeps `installAppDataPaths` (main.ts:6) working:
    // it calls `app.setPath("userData", …)`, and a provider that had cached a
    // string would answer with the pre-override directory — the founder's real
    // mad.db, in a dev build (BACKLOG-2709).
    let dir = "/tmp/before";
    installAppPaths({ userData: () => dir });
    expect(hostAppPaths.userData()).toBe("/tmp/before");
    dir = "/tmp/after-setPath";
    expect(hostAppPaths.userData()).toBe("/tmp/after-setPath");
  });

  it("installing twice replaces the implementation", () => {
    installAppPaths(fake("/tmp/first"));
    installAppPaths(fake("/tmp/second"));
    expect(hostAppPaths.userData()).toBe("/tmp/second");
  });

  it("resetAppPaths puts the throwing default back", () => {
    installAppPaths(fake("/tmp/x"));
    expect(isAppPathsInstalled()).toBe(true);
    resetAppPaths();
    expect(isAppPathsInstalled()).toBe(false);
  });
});
