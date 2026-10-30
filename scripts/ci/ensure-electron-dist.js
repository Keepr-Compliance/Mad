#!/usr/bin/env node
/**
 * BACKLOG-4052: make sure node_modules/electron/dist exists, then assert the two
 * files build.mac.extraResources copies out of it.
 *
 * Electron 44 has no postinstall: `npm install` no longer downloads the binary.
 * electron-builder skips a missing extraResources source without failing, so a
 * job that packages without first fetching the binary ships without the notices.
 *
 * Usage: node scripts/ci/ensure-electron-dist.js [--check-only]
 *   (default)     run electron's own install.js (a no-op when already installed),
 *                 then assert.
 *   --check-only  assert only; used by scripts/__tests__/ensure-electron-dist.verify.js.
 * Env: ELECTRON_PKG_DIR overrides the package directory (control/test use).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkgDir = process.env.ELECTRON_PKG_DIR || path.join(__dirname, '..', '..', 'node_modules', 'electron');
const REQUIRED = ['LICENSE', 'LICENSES.chromium.html'];

if (!process.argv.includes('--check-only')) {
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[ensure-electron-dist] install.js failed (status ${r.status}${r.error ? ', ' + r.error.message : ''})`);
    process.exit(1);
  }
}

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(pkgDir, 'dist', f)));
if (missing.length > 0) {
  console.error(`[ensure-electron-dist] MISSING in ${path.join(pkgDir, 'dist')}: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[ensure-electron-dist] OK: ${REQUIRED.join(', ')} present`);
