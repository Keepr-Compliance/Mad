#!/usr/bin/env node
/**
 * BACKLOG-4052: run the shipped CA denylist (electron/bootstrap/nodeCaDenylist.ts)
 * under the installed Electron's own Node and check the result exactly:
 *   (a) the store holds the pinned number of denylisted roots before,
 *   (b) after == before minus exactly those roots (set equality),
 *   (c) fingerprints computed here (sha256 of DER, lower-case hex), not by
 *       the filter.
 * Then, if openssl is on PATH, the eMudhra issuing CAs verify against the
 * store before and fail with error 20 after.
 *
 * Usage: node scripts/ci/check-node-ca-denylist.js
 *   (re-executes itself under Electron with ELECTRON_RUN_AS_NODE=1)
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.versions.electron) {
  const r = spawnSync(require('electron'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  process.exit(r.status === null ? 1 : r.status);
}

const tls = require('tls');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const EXPECTED_REMOVED = new Set([
  '40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367',
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  '125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f',
  'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3',
]);
/**
 * Denylisted roots present in Electron's bundled store, per bundled Node.
 * An unknown Node fails on purpose: re-measure and add it. A Node that
 * already dropped some of these (upstream 24.22.1+ drops three) changes this.
 */
const PRESENT_BEFORE = { '22.22.0': 4, '24.22.0': 4 };

const fail = (msg) => {
  console.error(`[check-node-ca-denylist] FAIL: ${msg}`);
  process.exit(1);
};
const fp = (pem) => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
const fps = (list) => new Set(list.map(fp));

const src = fs.readFileSync(path.join(ROOT, 'electron', 'bootstrap', 'nodeCaDenylist.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const Module = require('module');
const srcPath = path.join(ROOT, 'electron', 'bootstrap', 'nodeCaDenylist.js');
const mod = new Module(srcPath, module);
mod.filename = srcPath;
mod.paths = Module._nodeModulePaths(path.dirname(srcPath));
mod._compile(js, srcPath);

const { node, electron } = process.versions;
const pinned = PRESENT_BEFORE[node];
if (pinned === undefined) fail(`no pin for Electron ${electron} / Node ${node}; measure its store and add it to PRESENT_BEFORE`);

const beforePems = tls.getCACertificates('default');
const before = fps(beforePems);
const present = [...before].filter((f) => EXPECTED_REMOVED.has(f));
if (present.length !== pinned) fail(`expected ${pinned} denylisted roots before, found ${present.length}`);

const r = mod.exports.applyNodeCaDenylist();
const afterPems = tls.getCACertificates('default');
const after = fps(afterPems);
const expected = new Set([...before].filter((f) => !EXPECTED_REMOVED.has(f)));
const missing = [...expected].filter((f) => !after.has(f));
const extra = [...after].filter((f) => !expected.has(f));
if (missing.length || extra.length) {
  fail(`after != before minus the denylist: ${missing.length} other roots removed, ${extra.length} unexpected roots kept`);
}
console.log(`[check-node-ca-denylist] Electron ${electron} / Node ${node}: ${r.before} -> ${r.after}, removed: ${r.removedNames.join(', ')}`);

const which = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log('[check-node-ca-denylist] openssl not on PATH: chain check skipped');
  process.exit(0);
}
const fx = path.join(__dirname, 'fixtures', 'node-ca-denylist');
const cross = path.join(fx, 'cross-signed-root-tls-ca-g3.pem');
const issuing = fs.readdirSync(fx).filter((f) => f.startsWith('issuing-ca-')).map((f) => path.join(fx, f));
if (issuing.length !== 4) fail(`expected 4 issuing CA fixtures, found ${issuing.length}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-denylist-'));
const verify = (pems, label) => {
  const store = path.join(tmp, `${label}.pem`);
  fs.writeFileSync(store, pems.join('\n') + '\n');
  return issuing.map((cert) => {
    const v = spawnSync('openssl', ['verify', '-no_check_time', '-CAfile', store, '-untrusted', cross, cert], { encoding: 'utf8' });
    return `${v.stdout}${v.stderr}`;
  });
};
const okBefore = verify(beforePems, 'before');
const okAfter = verify(afterPems, 'after');
if (!okBefore.every((o) => /: OK\s*$/.test(o))) fail(`a chain did not verify against the unfiltered store:\n${okBefore.join('')}`);
if (!okAfter.every((o) => /error 20 /.test(o))) fail(`a chain still verifies (or fails differently) after the filter:\n${okAfter.join('')}`);
console.log(`[check-node-ca-denylist] openssl: ${issuing.length}/${issuing.length} OK before, ${issuing.length}/${issuing.length} error 20 after`);
