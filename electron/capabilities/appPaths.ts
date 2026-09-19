/**
 * The host's writable application directories, as an interface
 * (BACKLOG-2962, seam 3 of 5).
 *
 * WHY THIS EXISTS, AND WHY IT IS THE SMALLEST EDIT WITH THE LARGEST EFFECT
 * ------------------------------------------------------------------------
 * BACKLOG-2961 enumerated all 31 subsets of epic 9's five seams and
 * re-partitioned the 122-module extraction closure for each. Four of the five
 * free ZERO modules on their own. This one frees zero on its own too — and yet
 * `electron/services/db/core/dbConnection.ts:163`, a SINGLE `app.getPath` call,
 * is what holds 19 modules (every `db/*DbService.ts` in the closure, plus
 * `messageMatchingService` and `llm/llmConfigService`) in the coupled set. They
 * come free only at the conjunction of Logger + ErrorReporter + AppPaths, which
 * is why those three ship as one PR: 81 platform-free modules become 115.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a wrapper for `Electron.app.getPath`. That function takes 14 names, and
 * a seam that exposed all 14 would be describing Electron rather than
 * describing what the core needs. Enumerated by the compiler across the whole
 * closure: the four call sites this seam replaces pass **`"userData"`, and
 * nothing else** — `dbConnection.ts:163`, `databaseEncryptionService.ts:59`
 * and `:386`, `databaseService.ts:203`. So there is one accessor. `"logs"`,
 * `"temp"`, `"downloads"`, `"exe"`, `"home"` and `"appData"` are used elsewhere
 * in the repo, all of it inside the Electron shell, and none of it here.
 *
 * A second accessor is added when the first core caller needs one — the same
 * rule `secretStore.ts` states for its three methods.
 *
 * WHY IT IS A METHOD AND NOT A STRING
 * -----------------------------------
 * `electron/bootstrap/installAppDataPaths.ts` (imported first at `main.ts:6`)
 * repoints userData with `app.setPath` so a dev build cannot open the installed
 * app's database — the BACKLOG-2709 incident. An implementation that captured
 * the path once at construction could silently answer the pre-override value.
 * A method forces the read to happen when the answer is wanted.
 *
 * @module electron/capabilities/appPaths
 */

/**
 * The directories a host shell lets the core write to.
 *
 * Implementations MUST be synchronous, because every existing caller is, and
 * MUST read the host's current answer rather than a cached one.
 */
export interface AppPaths {
  /**
   * The per-user directory this application owns and may write to.
   *
   * Electron's `userData`; on Android, the app's private files directory. It is
   * where `mad.db`, the encryption key store, backups and the session file
   * live, so an implementation that returns the wrong directory is a data-loss
   * bug rather than a cosmetic one.
   */
  userData(): string;
}

/** Raised by {@link UnavailableAppPaths}. */
export class AppPathsUnavailableError extends Error {
  constructor(pathName: string) {
    super(
      `No app paths are installed, so ${pathName} cannot be resolved. The host ` +
        "shell must install an AppPaths at its composition root before any code " +
        "reaches this capability (Electron does so in " +
        "electron/bootstrap/installNativeCapabilities.ts).",
    );
    this.name = "AppPathsUnavailableError";
  }
}

/**
 * An {@link AppPaths} that throws on every accessor.
 *
 * THIS ONE THROWS, WHERE `SilentLogger` AND `SilentErrorReporter` DO NOT — and
 * the asymmetry is forced, not chosen. A logger can honestly do nothing; a path
 * accessor cannot. Its contract is to return a string, and every substitute is
 * worse than a named error:
 *
 *   - Returning `""` or `undefined` makes `path.join(userData, "mad.db")`
 *     resolve somewhere unintended, which is the shape of the BACKLOG-2709
 *     incident (dev builds opening the founder's real `mad.db` and consuming an
 *     untested upgrade path).
 *   - Guessing a platform default would put this file back in the business of
 *     knowing which platform it is on, which is the whole thing epic 9 removes.
 *
 * So it throws, and it names the capability, matching `UnavailableSecretStore`.
 * The measured cost of that choice is recorded where it lands: a jest suite that
 * calls `jest.resetModules()` gets a fresh, uninstalled provider, so those
 * suites re-install via `tests/helpers/installTestCapabilities.js` — the same
 * thing the SecretStore seam already requires of six suites.
 */
export class UnavailableAppPaths implements AppPaths {
  userData(): string {
    throw new AppPathsUnavailableError("userData");
  }
}
