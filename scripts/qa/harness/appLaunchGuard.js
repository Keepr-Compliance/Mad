'use strict';
/**
 * QA Harness — isolation guard for the UNPACKAGED app launch (BACKLOG-4054).
 *
 * Loaded with Electron's `-r` switch by e2e/driver/launchArgs.ts `buildUnpackagedLaunch`, so it runs
 * in the main process BEFORE the app's own entry (dist-electron/main.js): before any log, DB, keychain
 * or protocol-handler code. Same contract as the seeder (seederGuard.isolationFailure):
 *   - `--use-mock-keychain` present;
 *   - only the `--user-data-dir=<dir>` form;
 *   - app.getPath('userData') equals the requested dir (realpath both sides);
 *   - not inside <appData>/{keepr,Keepr,keepr-dev,Electron}.
 * Any failure: one stderr line and exit GUARD_EXIT_CODE. On success it points the main log into the
 * profile (<userData>/logs/main.log, the same two settings electron/bootstrap/installAppDataPaths.ts uses
 * for keepr-dev: app.setPath('logs') and electron-log's resolvePathFn) and sets
 * the globalThis.__keeprAppLaunchGuard sentinel ({ userData, log }). The driver asserts the sentinel after launch
 * (proves this file ran) and that log.transports.file.getFile().path is under the profile.
 * Without the redirect, a --user-data-dir launch logs to the INSTALLED app's ~/Library/Logs/keepr.
 *
 * It does NOT prove the sandbox-exec profile is active; the launch builder refuses to start the app
 * without the wrapper. See scripts/qa/harness/electron-sandboxed.sh.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const guard = require('./seederGuard');

const opts = guard.parseArgs(process.argv.slice(1));
const refusal = guard.isolationFailure({
  hasMockKeychain: app.commandLine.hasSwitch('use-mock-keychain'),
  opts,
  actualUserData: app.getPath('userData'),
  appData: app.getPath('appData'),
  label: 'app-launch',
});
if (refusal) {
  process.stderr.write(`app-launch guard: ${refusal}\n`);
  process.exit(guard.GUARD_EXIT_CODE);
}
const userData = app.getPath('userData');
const logsDir = path.join(userData, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
app.setPath('logs', logsDir);
const log = require('electron-log');
log.transports.file.resolvePathFn = () => path.join(logsDir, 'main.log');
globalThis.__keeprAppLaunchGuard = { userData, log };
