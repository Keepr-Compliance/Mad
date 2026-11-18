#!/usr/bin/env node
// Verification harness for scripts/ci/jest-shard-guard.mjs (BACKLOG-4125).
// Every guard is driven red on purpose; each case states the exit code it expects.
// A .verify.js (not a jest suite) so the jest suite total is unchanged by this file.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const script = path.join(__dirname, "..", "ci", "jest-shard-guard.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jest-shard-guard-"));
const w = (name, value) => {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
  return p;
};
const jestResult = (suites, tests) => ({
  numTotalTestSuites: suites, numTotalTests: tests, numFailedTestSuites: 0, numFailedTests: 0,
  numPendingTestSuites: 0, numPendingTests: 0, numRuntimeErrorTestSuites: 0, success: true,
});
const summary = (shard, shards, suites, tests) => ({ shard, shards, numTotalTestSuites: suites, numTotalTests: tests });
const dir = (name, entries) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, v] of Object.entries(entries)) fs.writeFileSync(path.join(d, f), JSON.stringify(v));
  return d;
};

const good4 = dir("good4", {
  "s1.json": summary(1, 4, 483, 7000), "s2.json": summary(2, 4, 482, 7100),
  "s3.json": summary(3, 4, 482, 7200), "s4.json": summary(4, 4, 482, 7540),
});
const needsOk = { a: { result: "success" }, b: { result: "success" } };

const cases = [
  // expected
  ["expected: 3 listed", ["expected", "--list", w("l3.json", ["a", "b", "c"])], 0],
  ["expected: empty list", ["expected", "--list", w("l0.json", [])], 1],
  ["expected: missing file", ["expected", "--list", path.join(tmp, "nope.json")], 1],
  ["expected: not an array", ["expected", "--list", w("lobj.json", { a: 1 })], 1],
  // shard
  ["shard: good", ["shard", "--json", w("j-good.json", jestResult(483, 7000)), "--shard", "1/4", "--out", path.join(tmp, "o/1.json")], 0],
  ["shard: JSON missing", ["shard", "--json", path.join(tmp, "missing.json"), "--shard", "1/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: JSON empty file", ["shard", "--json", w("j-empty.json", ""), "--shard", "1/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: JSON truncated", ["shard", "--json", w("j-trunc.json", '{"numTotalTestSuites": 4'), "--shard", "1/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: zero suites", ["shard", "--json", w("j-0s.json", jestResult(0, 0)), "--shard", "2/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: zero tests", ["shard", "--json", w("j-0t.json", jestResult(3, 0)), "--shard", "2/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: counts absent", ["shard", "--json", w("j-none.json", { success: true }), "--shard", "2/4", "--out", path.join(tmp, "o/x.json")], 1],
  ["shard: bad --shard", ["shard", "--json", w("j-good2.json", jestResult(1, 1)), "--shard", "5/4", "--out", path.join(tmp, "o/x.json")], 2],
  // results
  ["results: all success", ["results", "--require", "a,b"], 0, { NEEDS_JSON: JSON.stringify(needsOk) }],
  ["results: one failure", ["results", "--require", "a,b"], 1, { NEEDS_JSON: JSON.stringify({ ...needsOk, b: { result: "failure" } }) }],
  ["results: one cancelled", ["results", "--require", "a,b"], 1, { NEEDS_JSON: JSON.stringify({ ...needsOk, b: { result: "cancelled" } }) }],
  ["results: one skipped", ["results", "--require", "a,b"], 1, { NEEDS_JSON: JSON.stringify({ ...needsOk, a: { result: "skipped" } }) }],
  ["results: one absent", ["results", "--require", "a,b,c"], 1, { NEEDS_JSON: JSON.stringify(needsOk) }],
  ["results: NEEDS_JSON unset", ["results", "--require", "a"], 2, { NEEDS_JSON: "" }],
  // aggregate
  ["aggregate: good", ["aggregate", "--dir", good4, "--shards", "4", "--expected", "1929"], 0],
  ["aggregate: sum != expected", ["aggregate", "--dir", good4, "--shards", "4", "--expected", "1930"], 1],
  ["aggregate: 3 of 4 summaries", ["aggregate", "--dir", dir("three", {
    "s1.json": summary(1, 4, 483, 1), "s2.json": summary(2, 4, 482, 1), "s3.json": summary(3, 4, 964, 1) }), "--shards", "4", "--expected", "1929"], 1],
  ["aggregate: duplicate shard", ["aggregate", "--dir", dir("dup", {
    "s1.json": summary(1, 4, 483, 1), "s2.json": summary(2, 4, 482, 1), "s3.json": summary(3, 4, 482, 1), "s4.json": summary(3, 4, 482, 1) }), "--shards", "4", "--expected", "1929"], 1],
  ["aggregate: zero-suite shard", ["aggregate", "--dir", dir("zero", {
    "s1.json": summary(1, 4, 965, 1), "s2.json": summary(2, 4, 482, 1), "s3.json": summary(3, 4, 482, 1), "s4.json": summary(4, 4, 0, 0) }), "--shards", "4", "--expected", "1929"], 1],
  ["aggregate: summary for other shard count", ["aggregate", "--dir", dir("wrongn", {
    "s1.json": summary(1, 3, 643, 1), "s2.json": summary(2, 4, 482, 1), "s3.json": summary(3, 4, 482, 1), "s4.json": summary(4, 4, 322, 1) }), "--shards", "4", "--expected", "1929"], 1],
  ["aggregate: no dir", ["aggregate", "--dir", path.join(tmp, "absent"), "--shards", "4", "--expected", "1929"], 1],
  ["aggregate: expected empty", ["aggregate", "--dir", good4, "--shards", "4", "--expected", ""], 1],
  ["unknown mode", ["frobnicate"], 2],
];

let failed = 0;
for (const [label, args, want, env] of cases) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", ...(env || {}) },
  });
  const ok = r.status === want;
  if (!ok) {
    failed++;
    console.log(r.stdout + r.stderr);
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: want ${want} got ${r.status}`);
}

// The shard summary must round-trip into aggregate (writer and reader agree on shape).
const rt = path.join(tmp, "roundtrip");
for (const [i, n] of [[1, 483], [2, 482], [3, 482], [4, 482]]) {
  spawnSync(process.execPath, [script, "shard", "--json", w(`rt${i}.json`, jestResult(n, 10)), "--shard", `${i}/4`, "--out", path.join(rt, `s${i}.json`)]);
}
const agg = spawnSync(process.execPath, [script, "aggregate", "--dir", rt, "--shards", "4", "--expected", "1929"], { encoding: "utf8" });
const rtOk = agg.status === 0;
if (!rtOk) failed++;
console.log(`${rtOk ? "PASS" : "FAIL"} round-trip shard -> aggregate: want 0 got ${agg.status}`);

fs.rmSync(tmp, { recursive: true, force: true });
const total = cases.length + 1;
console.log(`${total} cases ran, ${failed} failed`);
process.exit(failed || total === 0 ? 1 : 0);
