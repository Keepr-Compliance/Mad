#!/usr/bin/env node
/**
 * BACKLOG-3814: the iPhone tool binaries ship byte-identical in every release.
 *
 * resources/win/libimobiledevice holds the Authenticode-signed copies from the 2.40.0
 * Windows installer. resources/pinned/libimobiledevice.manifest.json lists each one with
 * its sha256. electron-builder must never copy them (its extraResources copy signs every
 * .exe/.dll it copies on Windows, which rewrites the bytes), so package.json excludes the
 * folder and scripts/afterPack.js calls placePinnedTools() instead. afterPack runs after
 * extraResources are copied and before signApp, which never walks resources/win.
 *
 * verifyDir() is the single rule used everywhere: the folder must hold exactly the
 * manifest's files plus its named companions, and every file's sha256 must match.
 *
 * CLI (no dependencies, no secrets):
 *   node scripts/release/pinnedIphoneTools.js --repo
 *       checks resources/win/libimobiledevice in this checkout
 *   node scripts/release/pinnedIphoneTools.js --packaged <win-unpacked | Keepr.app>
 *       checks the folder inside a packaged app
 *   node scripts/release/pinnedIphoneTools.js --dir <folder>
 *       checks an arbitrary folder
 * Exit 0 = OK, 1 = any problem (each one printed).
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO, "resources", "pinned", "libimobiledevice.manifest.json");

function loadManifest(manifestPath = MANIFEST_PATH) {
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (m.schemaVersion !== 1) throw new Error(`unsupported manifest schemaVersion: ${m.schemaVersion}`);
  if (!m.files || typeof m.files !== "object" || Object.keys(m.files).length === 0) {
    throw new Error("manifest lists no files");
  }
  for (const [name, sha] of Object.entries(m.files)) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`manifest sha256 for ${name} is not 64 hex characters`);
  }
  return m;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Compare a folder with the manifest. Returns a list of problems; empty = OK.
 * Names compare exactly (case-sensitive), so a renamed file is both missing and extra.
 */
function verifyDir(dir, manifest = loadManifest()) {
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [`folder not readable: ${dir} (${e.code || e.message})`];
  }
  const companions = new Set(manifest.companions || []);
  const present = new Set();
  for (const ent of entries) {
    present.add(ent.name);
    if (!ent.isFile()) {
      problems.push(`not a regular file: ${ent.name}`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(manifest.files, ent.name)) {
      const actual = sha256File(path.join(dir, ent.name));
      if (actual !== manifest.files[ent.name]) {
        problems.push(`sha256 mismatch: ${ent.name} is ${actual}, manifest pins ${manifest.files[ent.name]}`);
      }
    } else if (!companions.has(ent.name)) {
      problems.push(`extra file not in manifest: ${ent.name}`);
    }
  }
  for (const name of Object.keys(manifest.files)) {
    if (!present.has(name)) problems.push(`missing pinned file: ${name}`);
  }
  for (const name of companions) {
    if (!present.has(name)) problems.push(`missing companion file: ${name}`);
  }
  return problems.sort();
}

function fail(where, problems) {
  return new Error(`[pinned-iphone-tools] ${where}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
}

/** Resources directory of a packaged app: win-unpacked/resources or X.app/Contents/Resources. */
function resourcesDirOf(appDir) {
  return appDir.endsWith(".app") ? path.join(appDir, "Contents", "Resources") : path.join(appDir, "resources");
}

/**
 * afterPack step. `resourcesDir` is the packaged app's resources folder.
 * 1. The repo folder must match the manifest.
 * 2. The destination must NOT exist yet: if it does, electron-builder copied the folder
 *    itself, which means the package.json exclusion is gone and a signed build would have
 *    re-signed every file. Fails in unsigned builds too, so CI sees it without secrets.
 * 3. Copy, then check the destination against the manifest.
 */
function placePinnedTools(resourcesDir, { sourceDir, manifest = loadManifest(), log = console.log } = {}) {
  const src = sourceDir || path.join(REPO, manifest.dir);
  const srcProblems = verifyDir(src, manifest);
  if (srcProblems.length) throw fail(`source ${src}`, srcProblems);

  const dest = path.join(resourcesDir, ...manifest.packagedDir.split("/"));
  if (fs.existsSync(dest)) {
    throw new Error(
      `[pinned-iphone-tools] ${dest} already exists before afterPack placed it: electron-builder copied the ` +
        `iPhone tools itself, so a signed build re-signs them. Keep "!libimobiledevice/**" in the resources/win ` +
        `extraResources filter in package.json.`
    );
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of [...Object.keys(manifest.files), ...(manifest.companions || [])]) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
  const destProblems = verifyDir(dest, manifest);
  if (destProblems.length) throw fail(`packaged ${dest}`, destProblems);
  log(`[afterPack] Placed ${Object.keys(manifest.files).length} pinned iPhone tool files (sha256-verified) in ${dest}`);
  return dest;
}

function main(argv) {
  const [flag, arg] = argv;
  const manifest = loadManifest();
  let dir;
  if (flag === "--repo") dir = path.join(REPO, manifest.dir);
  else if (flag === "--packaged" && arg) dir = path.join(resourcesDirOf(path.resolve(arg)), ...manifest.packagedDir.split("/"));
  else if (flag === "--dir" && arg) dir = path.resolve(arg);
  else {
    console.error("usage: pinnedIphoneTools.js --repo | --packaged <appDir> | --dir <folder>");
    return 2;
  }
  const problems = verifyDir(dir, manifest);
  if (problems.length) {
    console.error(`::error::pinned iPhone tools differ from the manifest in ${dir}`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`PINNED IPHONE TOOLS: OK — ${Object.keys(manifest.files).length} files match the manifest in ${dir}`);
  return 0;
}

module.exports = { MANIFEST_PATH, loadManifest, verifyDir, placePinnedTools, resourcesDirOf, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
