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
 * Two sets, never mixed:
 *   repoSet()          the committed folder: every manifest file plus its named companions
 *                      (checked by verifyRepo(): --repo, and afterPack's source check).
 *   expectedFor(ch)    what a packaged build ships (checked by verifyDir(): --packaged,
 *                      --dir, and afterPack's destination check).
 * Both require the folder to hold exactly the set, and every pinned file's sha256 to match.
 *
 * CLI (no dependencies, no secrets):
 *   node scripts/release/pinnedIphoneTools.js --repo
 *       checks resources/win/libimobiledevice in this checkout
 *   node scripts/release/pinnedIphoneTools.js --packaged <win-unpacked | Keepr.app>
 *       checks the folder inside a packaged app
 *   node scripts/release/pinnedIphoneTools.js --dir <folder>
 *       checks an arbitrary folder
 *   Append `--channel store` to --packaged / --dir to check the Microsoft Store build.
 * Exit 0 = OK, 1 = any problem (each one printed).
 *
 * BACKLOG-3927: channels "website" (the default everywhere) and "store".
 * BACKLOG-3689: both channels ship only manifest.store.files (the tools the app spawns and
 * the DLLs they load), no companions, and never a libusb* library or a .sys/.inf/.cat file.
 * The repo folder keeps every pinned file (repoSet), so the third-party notices check and
 * the CI signature check of the committed binaries are unchanged.
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
  if (!m.store || !Array.isArray(m.store.files) || m.store.files.length === 0) {
    throw new Error("manifest has no store.files list");
  }
  for (const name of m.store.files) {
    if (!Object.prototype.hasOwnProperty.call(m.files, name)) {
      throw new Error(`manifest store.files names ${name}, which is not a pinned file`);
    }
  }
  return m;
}

const CHANNELS = ["website", "store"];

/**
 * BACKLOG-3927: never in a shipped tools folder (the exact-set check also catches these).
 * BACKLOG-3689: applies to both channels.
 */
const STORE_FORBIDDEN = [/^libusb/i, /\.(sys|inf|cat)$/i];

/** The committed folder's set: every pinned file plus its companions. Never what ships. */
function repoSet(manifest) {
  return { files: Object.keys(manifest.files), companions: [...(manifest.companions || [])] };
}

/**
 * The files a channel ships: { files: pinned names, companions: unpinned names }.
 * BACKLOG-3689: the same set for both channels; the channel is still validated.
 */
function expectedFor(manifest, channel = "website") {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel} (expected website or store)`);
  return { files: [...manifest.store.files], companions: [] };
}

/**
 * The channel an electron-builder afterPack context is packaging. The Store run marks the
 * app with --config.extraMetadata.distributionChannel=store (release.yml), the same field
 * scripts/ci/check-packaged-drivers.mjs reads back out of app.asar, so the tools set and
 * the Store marker come from one value. Anything else is the website build.
 */
function channelOf(context) {
  const cfg = context && context.packager && context.packager.config;
  const value = cfg && cfg.extraMetadata ? cfg.extraMetadata.distributionChannel : undefined;
  return value === "store" ? "store" : "website";
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Compare a folder with an expected set. Returns a list of problems; empty = OK.
 * Names compare exactly (case-sensitive), so a renamed file is both missing and extra.
 * `forbiddenIn` names the build in the forbidden-file message, or null to skip that rule.
 */
function checkDir(dir, manifest, expected, forbiddenIn) {
  const pinnedSet = new Set(expected.files);
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [`folder not readable: ${dir} (${e.code || e.message})`];
  }
  const companions = new Set(expected.companions);
  const present = new Set();
  for (const ent of entries) {
    present.add(ent.name);
    if (forbiddenIn && STORE_FORBIDDEN.some((re) => re.test(ent.name))) {
      problems.push(`forbidden in a ${forbiddenIn} build: ${ent.name}`);
    }
    if (!ent.isFile()) {
      problems.push(`not a regular file: ${ent.name}`);
      continue;
    }
    if (pinnedSet.has(ent.name)) {
      const actual = sha256File(path.join(dir, ent.name));
      if (actual !== manifest.files[ent.name]) {
        problems.push(`sha256 mismatch: ${ent.name} is ${actual}, manifest pins ${manifest.files[ent.name]}`);
      }
    } else if (!companions.has(ent.name)) {
      problems.push(`extra file not in manifest: ${ent.name}`);
    }
  }
  for (const name of expected.files) {
    if (!present.has(name)) problems.push(`missing pinned file: ${name}`);
  }
  for (const name of companions) {
    if (!present.has(name)) problems.push(`missing companion file: ${name}`);
  }
  return problems.sort();
}

/** A packaged tools folder against what `channel` ships. */
function verifyDir(dir, manifest = loadManifest(), channel = "website") {
  const expected = expectedFor(manifest, channel);
  return checkDir(dir, manifest, expected, channel === "store" ? "Store" : "website");
}

/** The committed folder (or afterPack's source) against the full pinned set. */
function verifyRepo(dir, manifest = loadManifest()) {
  return checkDir(dir, manifest, repoSet(manifest), null);
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
 * 1. The source folder must hold the full pinned set (verifyRepo).
 * 2. The destination must NOT exist yet: if it does, electron-builder copied the folder
 *    itself, which means the package.json exclusion is gone and a signed build would have
 *    re-signed every file. Fails in unsigned builds too, so CI sees it without secrets.
 * 3. Copy the channel's set, then check the destination against it (verifyDir).
 */
function placePinnedTools(
  resourcesDir,
  { sourceDir, manifest = loadManifest(), log = console.log, copyFile = fs.copyFileSync, channel = "website" } = {}
) {
  const expected = expectedFor(manifest, channel);
  const src = sourceDir || path.join(REPO, manifest.dir);
  // The source is always the full pinned folder; the channel only selects what is copied.
  const srcProblems = verifyRepo(src, manifest);
  if (srcProblems.length) throw fail(`source ${src}`, srcProblems);

  const dest = path.join(resourcesDir, ...manifest.packagedDir.split("/"));
  if (fs.existsSync(dest)) {
    throw new Error(
      `[pinned-iphone-tools] ${dest} already exists before afterPack placed it: electron-builder copied the ` +
        `iPhone tools itself, so a signed build re-signs them. Keep "!libimobiledevice{,/**/*}" in the resources/win ` +
        `extraResources filter in package.json.`
    );
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of [...expected.files, ...expected.companions]) {
    copyFile(path.join(src, name), path.join(dest, name));
  }
  const destProblems = verifyDir(dest, manifest, channel);
  if (destProblems.length) throw fail(`packaged ${dest}`, destProblems);
  const which = channel === "store" ? " for the Microsoft Store build" : "";
  log(`[afterPack] Placed ${expected.files.length} pinned iPhone tool files${which} (sha256-verified) in ${dest}`);
  return dest;
}

function main(argv) {
  const args = [...argv];
  let channel = "website";
  const ci = args.indexOf("--channel");
  if (ci >= 0) {
    channel = args[ci + 1];
    args.splice(ci, 2);
    if (!CHANNELS.includes(channel)) {
      console.error(`--channel must be website or store, got ${JSON.stringify(channel)}`);
      return 2;
    }
  }
  const [flag, arg] = args;
  const manifest = loadManifest();
  let dir;
  if (flag === "--repo") dir = path.join(REPO, manifest.dir);
  else if (flag === "--packaged" && arg) dir = path.join(resourcesDirOf(path.resolve(arg)), ...manifest.packagedDir.split("/"));
  else if (flag === "--dir" && arg) dir = path.resolve(arg);
  else {
    console.error("usage: pinnedIphoneTools.js --repo | --packaged <appDir> | --dir <folder> [--channel website|store]");
    return 2;
  }
  if (flag === "--repo" && channel !== "website") {
    console.error("--repo checks the full pinned folder; --channel applies to --packaged and --dir only");
    return 2;
  }
  const problems = flag === "--repo" ? verifyRepo(dir, manifest) : verifyDir(dir, manifest, channel);
  if (problems.length) {
    console.error(`::error::pinned iPhone tools differ from the manifest in ${dir}`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  const n = (flag === "--repo" ? repoSet(manifest) : expectedFor(manifest, channel)).files.length;
  console.log(`PINNED IPHONE TOOLS: OK — ${n} files match the manifest${channel === "store" ? " (Microsoft Store set)" : ""} in ${dir}`);
  return 0;
}

module.exports = {
  MANIFEST_PATH,
  CHANNELS,
  loadManifest,
  expectedFor,
  repoSet,
  channelOf,
  verifyDir,
  verifyRepo,
  placePinnedTools,
  resourcesDirOf,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
