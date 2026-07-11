'use strict';
/**
 * QA Harness — one-time Keychain provisioning for the DB set-diff asserter
 * (BACKLOG-1850 / QA-H3).
 *
 * WHY THIS EXISTS (live-validation round 4): the DB key lives in the macOS
 * Keychain and is read via Electron `safeStorage`. The FIRST time a given
 * Electron binary reads the "keepr Safe Storage" item, macOS shows a one-time
 * authorization prompt. When db-assert is launched by the harness under
 * `spawnSync` (a non-foreground child), that prompt does NOT reliably appear —
 * so the read blocks and the run times out.
 *
 * This script is run DIRECTLY (foreground) so the prompt appears reliably:
 *
 *   npm run qa:db-key
 *
 * Approve it with **"Always Allow"** ONCE. That adds this Electron binary to the
 * Keychain item's ACL, so every subsequent `npm run qa:ceremony … --live
 * --skip-seed --skip-driver --skip-export` reads the key SILENTLY (sub-second).
 *
 * SECURITY: the key is read into memory only to prove access; it is NEVER
 * printed or written to disk. Persistence is the Keychain ACL, nothing else.
 * (`--print-export` is an opt-in escape hatch that prints an `export
 * KEEPR_QA_DB_KEY=…` line for the node-mode/CI path — env only, still no disk.)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

function userDataPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Keepr');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Keepr');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Keepr');
}

const printExport = process.argv.includes('--print-export');

// The app's name is lowercase "keepr" (package.json name). safeStorage's macOS
// Keychain service is derived from it ("keepr Safe Storage"); using "Keepr"
// (capital) resolves to a DIFFERENT service and creates a bogus item whose key
// cannot decrypt the real blob. Match the app EXACTLY.
app.setName('keepr');

app.whenReady().then(() => {
  try {
    // Bring the app to the foreground so the SecurityAgent prompt is presented.
    try { app.focus({ steal: true }); } catch (_) { /* best-effort */ }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage/OS encryption is not available on this machine.');
    }
    const keyStorePath = path.join(userDataPath(), 'db-key-store.json');
    if (!fs.existsSync(keyStorePath)) {
      throw new Error(
        `Key store not found at ${keyStorePath}. Launch the Keepr app once (so it creates the DB) first.`,
      );
    }
    const store = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
    if (!store.encryptedKey) throw new Error(`Key store at ${keyStorePath} has no encryptedKey.`);

    process.stdout.write(
      '\nRequesting Keychain access to the Keepr DB key…\n' +
        'Approve the macOS prompt with "Always Allow" (one time). This binary is then\n' +
        'trusted, and future `npm run qa:ceremony … --live --skip-*` runs read silently.\n\n',
    );

    // Triggers the one-time authorization prompt (foreground → reliably shown).
    const key = safeStorage.decryptString(Buffer.from(store.encryptedKey, 'base64'));
    if (!key || key.length < 32) throw new Error('Decrypted key looks invalid.');

    if (printExport) {
      // Opt-in: env-only handoff for the node-mode/CI path. Never written to disk.
      process.stdout.write(`export KEEPR_QA_DB_KEY=${key}\n`);
    } else {
      process.stdout.write(
        `✓ Keychain access granted (key length ${key.length}). The key was NOT written to disk.\n` +
          'Now run:\n' +
          '  npm run qa:ceremony -- --scenario tx1-birchwood --live --skip-seed --skip-driver --skip-export\n',
      );
    }
    app.quit();
    process.exit(0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`\n✗ qa:db-key failed: ${msg}\n`);
    app.quit();
    process.exit(2);
  }
});
