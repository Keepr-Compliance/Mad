#!/usr/bin/env node
// Verification harness for scripts/ci/check-node-version.mjs (BACKLOG-4053).
// Exit codes expected: 0 at/above minimum, 1 below, 2 unparseable (incl. suffixes).
const { spawnSync } = require("child_process");
const path = require("path");
const script = path.join(__dirname, "..", "ci", "check-node-version.mjs");
const cases = [
  ["v22.23.4", 0], ["22.23.4", 0], [" v22.23.4 ", 0], ["v22.24.0", 0], ["v24.1.0", 0],
  ["v22.23.3", 1], ["v22.22.9", 1], ["v20.19.0", 1],
  ["22.23.4-nightly", 2], ["22.23.4abc", 2], ["v22.23.3-rc.1", 2],
  ["", 2], ["garbage", 2], ["v22.23", 2],
];
let failed = 0;
for (const [input, want] of cases) {
  const got = spawnSync(process.execPath, [script, input], { encoding: "utf8" }).status;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(input)} want ${want} got ${got}`);
}
console.log(`${cases.length} cases ran, ${failed} failed`);
process.exit(failed || cases.length === 0 ? 1 : 0);
