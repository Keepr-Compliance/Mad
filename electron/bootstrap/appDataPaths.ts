/**
 * Development data-directory isolation (BACKLOG-2709).
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in this app ever overrode the userData path for development. The
 * packaged `build.productName` is "Keepr" and package.json `name` is "keepr",
 * which resolve to the SAME directory on a case-insensitive filesystem, so
 * `npm run dev`, every packaged QA build and the installed app all opened
 * `~/Library/Application Support/keepr/mad.db` — the founder's real database.
 *
 * That cost a migration rehearsal on 11-12 Aug 2026. Dev builds running on a
 * feature branch upgraded the production database from schema v55 to v62 days
 * before v2.28.0 was installed. The installed app then found nothing left to
 * migrate and wrote no pre-migration backup — `databaseService.runMigrations`
 * writes one only when a migration will actually run, so its absence is the
 * evidence. That upgrade path can never be observed on that machine again.
 *
 * ORDERING IS A CORRECTNESS CONSTRAINT, NOT A STYLE CHOICE
 * --------------------------------------------------------
 * `applyAppDataPaths()` MUST run before anything reads `app.getPath("userData")`.
 * In `main.ts` that means before `app.requestSingleInstanceLock()`, which writes
 * `SingletonLock` *inside* userData, and before the first `electron-log` write.
 * It therefore ships as a side-effect import on the first line of `main.ts`
 * (see `installAppDataPaths.ts`). `tsconfig.electron.json` emits CommonJS, which
 * preserves statement order — `main.ts` proves this by placing an `import` below
 * executable code.
 *
 * Accepted consequence: dev and the installed app now take SEPARATE singleton
 * locks and can run at the same time. Before this change, launching dev while
 * the installed app was open made dev lose the lock and quit.
 */

import { app } from "electron";
import fs from "fs";
import path from "path";

/** Directory name used for the development profile, under the platform appData root. */
export const DEV_DIR_NAME = "keepr-dev";

/**
 * Explicit override for the whole app-data directory.
 *
 * Env var ONLY — it can never be set in `.env.local`, because dotenv is loaded
 * in `main.ts` long after this module has already run. Honoured even in packaged
 * builds, which is what lets a QA build be pointed at a seeded fixture instead
 * of live data.
 */
export const USER_DATA_ENV_VAR = "KEEPR_USER_DATA_DIR";

export interface AppDataDirInput {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** True when Chromium's `--user-data-dir` switch was supplied. */
  hasUserDataDirSwitch: boolean;
  /** Raw `process.env.KEEPR_USER_DATA_DIR`. */
  envOverride: string | undefined;
  /** `app.getPath("appData")` — the per-user application-data root. */
  appDataPath: string;
}

/**
 * Decide the app-data directory, or `null` to leave Electron's default alone.
 *
 * Pure so the precedence can be tested by flipping one input at a time; the
 * `main.ts` wiring around it cannot be unit-tested.
 *
 * Precedence, highest first:
 *
 *   1. `--user-data-dir` switch present -> null (change NOTHING).
 *      Non-negotiable: `e2e/driver/launch.ts` relies on Electron mapping that
 *      Chromium switch onto userData to give each E2E run a hermetic profile.
 *      Overriding it here would silently collapse every isolated profile onto
 *      one shared directory.
 *   2. `KEEPR_USER_DATA_DIR` set -> use it verbatim, packaged or not.
 *   3. Packaged -> null. The installed app's path NEVER changes. This is the
 *      guard that keeps the founder's real database where it is.
 *   4. Otherwise (unpackaged dev) -> `<appData>/keepr-dev`.
 */
export function resolveAppDataDir(input: AppDataDirInput): string | null {
  if (input.hasUserDataDirSwitch) {
    return null;
  }

  const override = input.envOverride?.trim();
  if (override) {
    return override;
  }

  if (input.isPackaged) {
    return null;
  }

  return path.join(input.appDataPath, DEV_DIR_NAME);
}

export interface AppliedAppDataPaths {
  /** The directory now backing userData. */
  dir: string;
  /** Where userData pointed before the override — i.e. the production profile. */
  previousDir: string;
  /**
   * True when `dir` did not exist before this call created it.
   *
   * Captured BEFORE the directory is created and long before the database
   * service can create `mad.db`, because it is the trigger for the first-run
   * notice: the one launch where the app will look empty.
   */
  isFirstRun: boolean;
  /** True when the path came from `KEEPR_USER_DATA_DIR` rather than the dev default. */
  isExplicitOverride: boolean;
}

let applied: AppliedAppDataPaths | null = null;

/** The applied override, or `null` when paths were left at Electron's default. */
export function getAppliedAppDataPaths(): AppliedAppDataPaths | null {
  return applied;
}

/** True when Chromium's `--user-data-dir` switch was supplied to this process. */
function hasUserDataDirSwitch(): boolean {
  try {
    if (app.commandLine.hasSwitch("user-data-dir")) {
      return true;
    }
  } catch {
    // `app.commandLine` is unavailable under some harnesses; fall through to argv.
  }
  return process.argv.some(
    (arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
  );
}

/**
 * Point userData (and everything derived from it) at the development directory.
 *
 * Also moves `logs` explicitly: electron-log is configured in `main.ts` with a
 * level only and no `resolvePathFn`, so its path derives from the app NAME, not
 * from userData, and would otherwise keep interleaving dev output into the
 * founder's production `~/Library/Logs/keepr/main.log`.
 *
 * `sessionData` is set explicitly rather than relying on Electron deriving it.
 *
 * Returns `null` when the default paths were deliberately left untouched.
 */
export function applyAppDataPaths(): AppliedAppDataPaths | null {
  const envOverride = process.env[USER_DATA_ENV_VAR];
  const previousDir = app.getPath("userData");

  const dir = resolveAppDataDir({
    isPackaged: app.isPackaged,
    hasUserDataDirSwitch: hasUserDataDirSwitch(),
    envOverride,
    appDataPath: app.getPath("appData"),
  });

  if (!dir) {
    return null;
  }

  const isFirstRun = !fs.existsSync(dir);
  const logsDir = path.join(dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  app.setPath("userData", dir);
  app.setPath("sessionData", dir);
  app.setPath("logs", logsDir);

  applied = {
    dir,
    previousDir,
    isFirstRun,
    isExplicitOverride: Boolean(envOverride?.trim()),
  };
  return applied;
}

/**
 * The first-run notice text.
 *
 * Separated from the dialog call so the wording is assertable without an
 * Electron window. The empty database is the whole point of the message: an
 * app that silently opens a blank contact list is indistinguishable from data
 * loss, on a machine where the real database still exists.
 */
export function buildFirstRunNotice(paths: AppliedAppDataPaths): {
  title: string;
  message: string;
  detail: string;
} {
  return {
    title: "Keepr — development database",
    message: "This is a development build. It has its own, empty database.",
    detail: [
      `Development data:  ${paths.dir}`,
      `Your real data:    ${paths.previousDir}`,
      "",
      "Starting empty is expected — this is NOT data loss. Development builds",
      "used to open your real database directly, which is how the v2.28.0",
      "upgrade got consumed before it could be tested.",
      "",
      "Your real database has not been moved, copied or modified. Open the",
      "installed Keepr app to see it.",
    ].join("\n"),
  };
}

/** The banner printed to the dev terminal on every launch that moved the paths. */
export function buildConsoleNotice(paths: AppliedAppDataPaths): string {
  const rule = "=".repeat(72);
  return [
    "",
    rule,
    "  KEEPR — DEVELOPMENT DATA DIRECTORY (BACKLOG-2709)",
    rule,
    `  Using:        ${paths.dir}`,
    `  NOT touching: ${paths.previousDir}`,
    paths.isExplicitOverride ? `  Source:       ${USER_DATA_ENV_VAR}` : "  Source:       unpackaged build (development default)",
    rule,
    "",
  ].join("\n");
}
