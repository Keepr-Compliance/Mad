#!/usr/bin/env node
/**
 * BACKLOG-4052 (R-6): assert the Electron-ABI native module loads under the
 * installed Electron, not merely that scripts/rebuild-native.js exited.
 *
 * Usage: node scripts/ci/check-native-under-electron.js [runtime]
 *   runtime defaults to the Electron binary from require('electron').
 *   Passing `node` runs the same load under system Node (a control: it must
 *   fail, since the binary is built for Electron's ABI).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const binding = path.join(root, 'node_modules', 'better-sqlite3-multiple-ciphers', 'build', 'Release', 'better_sqlite3.node');
const runtime = process.argv[2] === 'node' ? process.execPath : require('electron');

const probe = `try { process.dlopen({ exports: {} }, ${JSON.stringify(binding)}); console.log('LOAD OK under ' + (process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.versions.node)); } catch (e) { console.log('LOAD FAILED: ' + e.message); process.exit(1); }`;
const r = spawnSync(runtime, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) {
  console.error(`[check-native-under-electron] FAILED (status ${r.status}${r.error ? ', ' + r.error.message : ''})`);
  process.exit(1);
}
