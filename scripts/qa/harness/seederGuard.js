'use strict';
/**
 * QA Harness — isolation guard for the Electron-main fixture seeder (BACKLOG-4093).
 *
 * Pure CommonJS, no Electron import: seed-fixture.js calls these with values it reads from
 * `app` / `process.argv`, and the unit tests call them with literals.
 *
 * The seeder must only ever run when ALL of these hold, checked before `app.whenReady`, before
 * any safeStorage call and before any DB work:
 *   1. it was launched with the mock keychain (`--use-mock-keychain`), so safeStorage never asks
 *      the macOS login keychain for a real "<name> Safe Storage" item;
 *   2. it was given the Chromium form `--user-data-dir=<dir>` (the bare space form is not honoured
 *      by Chromium, and mixing both forms resets userData to `<appData>/Electron`);
 *   3. `app.getPath('userData')` resolves to the requested directory (realpath on both sides, so a
 *      symlinked input such as /tmp or /var/folders compares equal to what Chromium reports);
 *   4. that directory is not, is not under, and does not contain any real profile directory
 *      (`<appData>/{keepr,Keepr,keepr-dev,Electron}`).
 *
 * Any failure → the caller writes the reason on one stderr line and exits with GUARD_EXIT_CODE.
 */

const fs = require('fs');
const path = require('path');

const GUARD_EXIT_CODE = 3;

/** userData directory names under appData that belong to a real (non-QA) profile. */
const REAL_PROFILE_NAMES = ['keepr', 'Keepr', 'keepr-dev', 'Electron'];

/**
 * True when `filename` is one of the launched argv entries (any position after argv[0]).
 * Electron passes its own switches (e.g. `--no-sandbox` from the sandbox wrapper) in front of the
 * script, so the script is NOT reliably `argv[1]`.
 */
function isEntryScript(argv, filename) {
  const target = path.resolve(filename);
  return argv.slice(1).some((a) => typeof a === 'string' && !a.startsWith('-') && path.resolve(a) === target);
}

/**
 * Parse the seeder's switches from the FULL argv (switches may sit before or after the script).
 * `--user-data-dir=<dir>` sets `userDataDir`; the bare `--user-data-dir <dir>` form sets
 * `userDataDirSpaceForm` instead, which the guard refuses.
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--user-data-dir=')) opts.userDataDir = a.slice('--user-data-dir='.length);
    else if (a === '--user-data-dir') opts.userDataDirSpaceForm = argv[++i];
    else if (a === '--fixture') opts.fixture = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // ignore Electron's own flags
  }
  return opts;
}

/**
 * realpath that tolerates a path that does not exist yet: resolve the deepest existing ancestor,
 * then re-append the missing tail.
 */
function resolveReal(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSameOrUnder(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Returns null when the seeder may proceed, otherwise a one-line reason.
 *
 * @param {object} p
 * @param {boolean} p.hasMockKeychain   app.commandLine.hasSwitch('use-mock-keychain')
 * @param {object}  p.opts              parseArgs(process.argv)
 * @param {string}  p.actualUserData    app.getPath('userData')
 * @param {string}  p.appData           app.getPath('appData')
 * @param {(p: string) => string} [p.realpath]  injectable for tests; defaults to resolveReal
 */
function isolationFailure({ hasMockKeychain, opts, actualUserData, appData, realpath = resolveReal }) {
  if (!hasMockKeychain) {
    return 'seed-fixture requires --use-mock-keychain (it must never reach the real macOS keychain).';
  }
  if (opts.userDataDirSpaceForm !== undefined) {
    return 'seed-fixture refuses the space form "--user-data-dir <dir>" (Chromium ignores it); pass --user-data-dir=<dir> only.';
  }
  if (!opts.userDataDir) {
    return 'seed-fixture requires --user-data-dir=<isolated profile>.';
  }
  const requested = realpath(opts.userDataDir);
  const actual = realpath(actualUserData);
  if (actual !== requested) {
    return `seed-fixture userData mismatch: Electron is using ${actual}, requested ${requested}.`;
  }
  const appDataReal = realpath(appData);
  for (const name of REAL_PROFILE_NAMES) {
    const real = path.join(appDataReal, name);
    if (isSameOrUnder(actual, real)) {
      return `REFUSING to seed a real profile directory: ${actual} is inside ${real}.`;
    }
  }
  if (isSameOrUnder(appDataReal, actual)) {
    return `REFUSING to seed ${actual}: it contains the real application data directory ${appDataReal}.`;
  }
  return null;
}

module.exports = {
  GUARD_EXIT_CODE,
  REAL_PROFILE_NAMES,
  isEntryScript,
  parseArgs,
  resolveReal,
  isolationFailure,
};
