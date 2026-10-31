#!/usr/bin/env node
// Verification harness for scripts/ci/ensure-electron-dist.js (BACKLOG-4052).
// No network: every case points ELECTRON_PKG_DIR at a temp dir; install.js is a stub.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const script = path.join(__dirname, "..", "ci", "ensure-electron-dist.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-electron-dist-"));

function mk(name, { files = [], install } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, "dist", f), "x");
  if (install !== undefined) fs.writeFileSync(path.join(dir, "install.js"), install);
  return dir;
}
const BOTH = ["LICENSE", "LICENSES.chromium.html"];
const writeBoth = `const fs=require('fs'),p=require('path');for(const f of ${JSON.stringify(BOTH)})fs.writeFileSync(p.join(__dirname,'dist',f),'x');`;
const writeOne = `require('fs').writeFileSync(require('path').join(__dirname,'dist','LICENSE'),'x');`;

// [name, dir, args, wantExit, [substrings required], [substrings forbidden]]
const cases = [
  ["dist absent (no dist dir)", fs.mkdtempSync(path.join(root, "absent-")), ["--check-only"], 1, ["MISSING", "LICENSE", "LICENSES.chromium.html"], []],
  ["empty dist", mk("empty"), ["--check-only"], 1, ["MISSING", "LICENSE", "LICENSES.chromium.html"], []],
  ["only LICENSE", mk("only-license", { files: ["LICENSE"] }), ["--check-only"], 1, ["LICENSES.chromium.html"], ["MISSING in " + path.join(root, "only-license", "dist") + ": LICENSE,"]],
  ["both present", mk("both", { files: BOTH }), ["--check-only"], 0, ["OK"], ["MISSING"]],
  ["install.js exits 3", mk("install-fails", { install: "process.exit(3)" }), [], 1, ["install.js failed", "status 3"], []],
  ["install.js writes both", mk("install-ok", { install: writeBoth }), [], 0, ["OK"], ["MISSING"]],
  ["install.js succeeds but writes only LICENSE", mk("install-partial", { install: writeOne }), [], 1, ["MISSING", "LICENSES.chromium.html"], ["install.js failed"]],
  ["default mode, install.js absent", mk("no-install", { files: BOTH }), [], 1, ["install.js failed"], []],
];

let failed = 0;
for (const [name, dir, args, wantExit, must, mustNot] of cases) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ELECTRON_PKG_DIR: dir } });
  const out = (r.stdout || "") + (r.stderr || "");
  const problems = [];
  if (r.status !== wantExit) problems.push(`exit want ${wantExit} got ${r.status}`);
  for (const s of must) if (!out.includes(s)) problems.push(`missing message ${JSON.stringify(s)}`);
  for (const s of mustNot) if (out.includes(s)) problems.push(`unexpected message ${JSON.stringify(s)}`);
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "PASS"} ${name}${problems.length ? " :: " + problems.join("; ") + " :: " + out.trim() : ""}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`${cases.length} cases ran, ${failed} failed`);
process.exit(failed || cases.length === 0 ? 1 : 0);
