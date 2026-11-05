#!/usr/bin/env node
/**
 * Release-notes download table (BACKLOG-3200).
 *
 * The table used to be typed into release.yml, and its Intel row named a file
 * electron-builder never produces (it does not suffix the default macOS
 * architecture). This script builds the table from the files the release
 * actually attaches, and checks the result against the attached assets.
 *
 *   --write --version <v> --mac-dir <d> --win-dir <d> --out <file>
 *       Writes the release body. Fails unless it finds exactly one arm64 DMG,
 *       exactly one other DMG (the Intel build) and exactly one Setup .exe.
 *
 *   --check --body <file> --assets <json>
 *       <json> is the attached assets: an array of names, or of objects with
 *       a "name" (softprops/action-gh-release's `assets` output). Fails unless
 *       every filename the body's download table advertises is attached.
 *
 * Exit 0 = ok; exit 1 = mismatch or bad input.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};
function fail(message) {
  console.error(`release-download-table: FAIL — ${message}`);
  process.exit(1);
}
function need(name) {
  const v = opt(name);
  if (v === undefined || v === "") fail(`${name} is required`);
  return v;
}
function one(list, what, dir) {
  if (list.length !== 1) fail(`expected exactly one ${what} in ${dir}, found ${list.length}: ${JSON.stringify(list)}`);
  return list[0];
}

export function buildBody(version, macFiles, winFiles, macDir = "mac dir", winDir = "win dir") {
  const dmgs = macFiles.filter((f) => f.endsWith(".dmg"));
  const arm = one(dmgs.filter((f) => f.endsWith("-arm64.dmg")), "arm64 .dmg", macDir);
  const intel = one(dmgs.filter((f) => !f.endsWith("-arm64.dmg")), "Intel (non-arm64) .dmg", macDir);
  const exe = one(winFiles.filter((f) => /setup.*\.exe$/i.test(f)), "Setup .exe", winDir);
  return `## Keepr v${version}

### Downloads

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | \`${arm}\` |
| macOS (Intel) | \`${intel}\` |
| Windows | \`${exe}\` |

### What's New

<!-- Add release notes here -->

### Installation

**macOS**: Download the \`.dmg\` file, open it, and drag Keepr to your Applications folder.

**Windows**: Download the \`.exe\` installer and run it. The installer is signed by Blue Spaces LLC.

---

🤖 Release created automatically from main branch
`;
}

/** Filenames in the body's download table: the backticked cell of each platform row. */
export function advertised(body) {
  const names = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(macOS|Windows)[^|]*\|\s*`([^`]+)`\s*\|\s*$/);
    if (m) names.push(m[2]);
  }
  return names;
}

if (argv.includes("--write")) {
  const version = need("--version");
  const macDir = need("--mac-dir");
  const winDir = need("--win-dir");
  const out = need("--out");
  const list = (d) => {
    try {
      return readdirSync(d);
    } catch (error) {
      fail(`cannot read ${d}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const body = buildBody(version, list(macDir), list(winDir), macDir, winDir);
  writeFileSync(out, body);
  console.log(`release-download-table: wrote ${out}: ${advertised(body).join(", ")}`);
} else if (argv.includes("--check")) {
  const body = readFileSync(need("--body"), "utf8");
  let assets;
  try {
    assets = JSON.parse(need("--assets"));
  } catch (error) {
    fail(`--assets is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(assets) || assets.length === 0) fail("--assets is empty — nothing was attached, or the input is wrong");
  const attached = new Set(assets.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean));
  const names = advertised(body);
  if (names.length !== 3) fail(`expected 3 advertised downloads in the body, found ${names.length}: ${JSON.stringify(names)}`);
  const missing = names.filter((n) => !attached.has(n));
  if (missing.length) fail(`the release body advertises ${JSON.stringify(missing)}, which is not attached. Attached: ${JSON.stringify([...attached].sort())}`);
  console.log(`release-download-table: OK — all ${names.length} advertised downloads are attached`);
} else {
  fail("pass --write or --check");
}
