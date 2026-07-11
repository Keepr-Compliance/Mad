'use strict';
/**
 * QA Harness — ISOLATED-PROFILE DB key emitter (BACKLOG-1950).
 *
 * Standalone Electron-MAIN helper. Decrypts the DB key from an ISOLATED QA profile's
 * `db-key-store.json` via the app's OWN `safeStorage`, and emits it as a single
 * sentinel-prefixed JSON line on stdout so the address-filter cell can pass it to
 * `db-assert.js --key <hex>` (node mode, no keychain prompt).
 *
 * WHY THIS EXISTS: the H3 asserter (db-assert.js / db-set-diff-asserter.ts) reads the key
 * from either `--key`/`KEEPR_QA_DB_KEY` (node mode) or the REAL Keepr profile's keychain
 * (electron mode, hardcoded `defaultUserDataPath`). Our fixture DB lives in an ISOLATED,
 * ephemeral profile, so we extract ITS key here and hand it over explicitly — avoiding the
 * keychain-prompt fragility and never touching the real profile.
 *
 * SAFETY — ISOLATED PROFILE ONLY: reuses seed-fixture.js's `assertIsolatedProfile` guard; it
 * REFUSES the real ~/Library/Application Support/keepr profile. The key belongs to a throwaway
 * profile that is re-seeded fresh each run.
 *
 * SECURITY: the key is emitted ONLY to stdout for immediate in-process capture by the cell
 * (which sets it as an env var for the child db-assert). It is NEVER written to disk here.
 *
 * USAGE (via the app electron binary, NOT node):
 *   node_modules/.bin/electron scripts/qa/harness/emit-profile-key.js --user-data-dir <isolatedProfile>
 *
 * EXIT CODES: 0 = emitted · 2 = usage / IO / decrypt / uncaught error.
 */

const fs = require('fs');
const path = require('path');

const { assertIsolatedProfile } = require('./seed-fixture.js');

const SENTINEL = '__QA_PROFILE_KEY_JSON__ ';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user-data-dir') opts.userDataDir = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function readKey(userDataDir) {
  assertIsolatedProfile(userDataDir);
  const resolved = path.resolve(userDataDir);
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption (safeStorage) unavailable — cannot read the profile DB key.');
  }
  const keyStorePath = path.join(resolved, 'db-key-store.json');
  if (!fs.existsSync(keyStorePath)) {
    throw new Error(`Key store not found at ${keyStorePath}. Seed the isolated profile first.`);
  }
  const store = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
  if (!store.encryptedKey) throw new Error(`Key store at ${keyStorePath} has no encryptedKey.`);
  const key = safeStorage.decryptString(Buffer.from(store.encryptedKey, 'base64'));
  if (!key || key.length < 32) throw new Error('Decrypted key looks invalid.');
  return key;
}

function emit(obj) {
  process.stdout.write(SENTINEL + JSON.stringify(obj) + '\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('emit-profile-key: emit an isolated QA profile DB key. See file header.\n');
    process.exit(0);
    return;
  }

  const fail = (err) => {
    const msg = err && err.message ? err.message : String(err);
    try { emit({ ok: false, error: msg }); } catch (_) { /* last resort */ }
    process.stderr.write(`\n  x emit-profile-key error: ${msg}\n`);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  const { app } = require('electron');
  app.setName('keepr'); // match the app's lowercase name so safeStorage resolves the profile key
  app.whenReady().then(() => {
    try {
      const key = readKey(opts.userDataDir);
      emit({ ok: true, key });
      app.quit();
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });
}

const isEntryScript = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isEntryScript || require.main === module) {
  main();
}

module.exports = { parseArgs, SENTINEL };
