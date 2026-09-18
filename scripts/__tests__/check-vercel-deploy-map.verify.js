#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-vercel-deploy-map.mjs — BACKLOG-3205
 * ===========================================================================
 * Runs in CI as the "Verify the guard itself" step of the Vercel Deploy Map
 * workflow. A harness that never executes is indistinguishable from one that
 * passes, so it fails when zero rows ran.
 *
 * Each row copies the REAL guard (not an embedded copy) into a temp tree with
 * the same relative layout, writes both portal vercel.json files from the
 * repo's real ones with one mutation applied through parsed JSON, reads the key
 * list back from the file the guard will read, and asserts the exit code.
 *
 * Rows
 *   G0  the repo's config as committed                     -> 0
 *   G1  explicit int-portal/** and hotfix-portal/** keys
 *       added before "**" (the documented fallback)        -> 0
 *   R1  int/** and hotfix/** true again (the old config)   -> 1
 *   R2  "*-portal/**" removed                              -> 1
 *   R3  "*-portal/**" set to false                         -> 1
 *   R4  "int/**": true re-added                            -> 1
 *   R5  "hotfix/**": true re-added                         -> 1
 *   R6  "**" moved to the first position                   -> 1
 *   R7  "develop" removed                                  -> 1
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const GUARD_REL = path.join("scripts", "ci", "check-vercel-deploy-map.mjs");
const PORTALS = ["broker-portal", "admin-portal"];

function readConfig(portal) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, portal, "vercel.json"), "utf8"));
}

// Rebuild git.deploymentEnabled from an ordered list of [key, value] pairs.
function withMap(doc, entries) {
  const copy = JSON.parse(JSON.stringify(doc));
  copy.git.deploymentEnabled = Object.fromEntries(entries);
  return copy;
}

const MUTATIONS = {
  G0: (e) => e,
  G1: (e) => [...e.slice(0, -1), ["int-portal/**", true], ["hotfix-portal/**", true], ...e.slice(-1)],
  R1: (e) => [...e.slice(0, 2), ["int/**", true], ["hotfix/**", true], ...e.slice(2)],
  R2: (e) => e.filter(([k]) => k !== "*-portal/**"),
  R3: (e) => e.map(([k, v]) => [k, k === "*-portal/**" ? false : v]),
  R4: (e) => [...e.slice(0, 2), ["int/**", true], ...e.slice(2)],
  R5: (e) => [...e.slice(0, 2), ["hotfix/**", true], ...e.slice(2)],
  R6: (e) => [["**", false], ...e.filter(([k]) => k !== "**")],
  R7: (e) => e.filter(([k]) => k !== "develop"),
};

const ROWS = [
  ["G0", "committed config", 0],
  ["G1", "fallback keys added before the catch-all", 0],
  ["R1", "int/** and hotfix/** true again", 1],
  ["R2", "*-portal/** removed", 1],
  ["R3", "*-portal/** set to false", 1],
  ["R4", "int/** re-added", 1],
  ["R5", "hotfix/** re-added", 1],
  ["R6", "catch-all moved first", 1],
  ["R7", "develop removed", 1],
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-map-verify-"));
let ran = 0;
let failed = 0;

try {
  for (const [id, name, expected] of ROWS) {
    const root = path.join(tmpRoot, id);
    fs.mkdirSync(path.join(root, "scripts", "ci"), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, GUARD_REL), path.join(root, GUARD_REL));

    const keyLists = [];
    for (const portal of PORTALS) {
      const doc = readConfig(portal);
      const entries = Object.entries(doc.git.deploymentEnabled);
      const mutated = withMap(doc, MUTATIONS[id](entries));
      fs.mkdirSync(path.join(root, portal), { recursive: true });
      const file = path.join(root, portal, "vercel.json");
      fs.writeFileSync(file, JSON.stringify(mutated, null, 2));
      // Read back what the guard will read, so a mutation that did not apply is visible.
      const readBack = JSON.parse(fs.readFileSync(file, "utf8")).git.deploymentEnabled;
      keyLists.push(Object.entries(readBack).map(([k, v]) => `${k}=${v ? "T" : "F"}`).join(" "));
    }

    const r = spawnSync(process.execPath, [path.join(root, GUARD_REL)], { encoding: "utf8" });
    ran += 1;
    const ok = r.status === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}: expected exit ${expected}, got ${r.status}`);
    console.log(`      keys: ${keyLists[0]}`);
    if (!ok) console.log((r.stdout || "") + (r.stderr || ""));
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (ran === 0) {
  console.error("check-vercel-deploy-map.verify: 0 rows ran. A harness that runs nothing proves nothing.");
  process.exit(1);
}
console.log(`\ncheck-vercel-deploy-map.verify: ${ran} row(s) ran, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
