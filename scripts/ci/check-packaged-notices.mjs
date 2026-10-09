#!/usr/bin/env node
/**
 * Release gate: the packaged app must contain the third-party licence files (BACKLOG-3803).
 *
 * electron-builder only WARNS when an extraResources source is missing, so a package built
 * without the Electron binary's licence files would otherwise ship silently without them.
 *
 * Usage: node scripts/ci/check-packaged-notices.mjs <mac|win> <appDir>
 *   mac: appDir is the .app bundle   (files under Contents/Resources/third-party/)
 *   win: appDir is win-unpacked      (Electron/Chromium licences beside the exe; notices under resources/third-party/)
 * Every listed file must exist and be non-empty. Exit 1 listing each failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED = {
  mac: [
    "Contents/Resources/third-party/LICENSES.chromium.html",
    "Contents/Resources/third-party/LICENSE.electron.txt",
    "Contents/Resources/third-party/THIRD_PARTY_NOTICES.txt",
  ],
  win: [
    "LICENSE.electron.txt",
    "LICENSES.chromium.html",
    "resources/third-party/THIRD_PARTY_NOTICES.txt",
  ],
};

export function checkPackagedNotices(platform, appDir) {
  const list = EXPECTED[platform];
  if (!list) throw new Error(`platform must be one of ${Object.keys(EXPECTED).join(", ")}`);
  const problems = [];
  for (const rel of list) {
    const p = path.join(appDir, rel);
    let size = -1;
    try {
      size = fs.statSync(p).size;
    } catch {
      /* missing */
    }
    if (size < 0) problems.push(`missing: ${rel}`);
    else if (size === 0) problems.push(`empty: ${rel}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, appDir] = process.argv.slice(2);
  if (!platform || !appDir) {
    console.error("usage: check-packaged-notices.mjs <mac|win> <appDir>");
    process.exit(2);
  }
  const problems = checkPackagedNotices(platform, path.resolve(appDir));
  if (problems.length) {
    console.error(`::error::${appDir} is missing third-party licence files:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${appDir}: third-party licence files present`);
}
