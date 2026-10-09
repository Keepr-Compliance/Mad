#!/usr/bin/env node
/**
 * Release gate: the packaged app must not ship a Google Maps key (BACKLOG-3834).
 *
 * The desktop app used to carry GOOGLE_MAPS_API_KEY in resources/.env.production,
 * readable by anyone who installs it. Address lookups now go through the
 * maps-proxy Edge Function, so no Maps key belongs anywhere in the package.
 *
 * Usage: node scripts/ci/check-packaged-secrets.mjs <mac|win> <appDir>
 *   mac: appDir is the .app bundle (scans Contents/Resources)
 *   win: appDir is win-unpacked     (scans resources)
 *
 * Fails (exit 1) when, anywhere under the resources directory:
 *   - any `.env*` file contains a Google-API-key-shaped value or a forbidden
 *     variable name, or
 *   - app.asar contains a forbidden variable name or a key-shaped value.
 * Values are never printed: a hit reports the file and the rule only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESOURCES_DIR = {
  mac: "Contents/Resources",
  win: "resources",
};

/** Variable names that must never appear in a shipped artifact. */
export const FORBIDDEN_NAMES = ["GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_SERVER_KEY"];

/** Shape of a Google API key. */
export const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/;

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    // An .asar is a file; app.asar.unpacked is a directory and is walked.
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function scanText(text, rel) {
  const problems = [];
  for (const name of FORBIDDEN_NAMES) {
    if (text.includes(name)) problems.push(`${rel}: contains variable name ${name}`);
  }
  if (GOOGLE_KEY_RE.test(text)) problems.push(`${rel}: contains a Google API key-shaped value`);
  return problems;
}

export function checkPackagedSecrets(platform, appDir) {
  const sub = RESOURCES_DIR[platform];
  if (!sub) throw new Error(`platform must be one of ${Object.keys(RESOURCES_DIR).join(", ")}`);
  const resources = path.join(appDir, sub);
  if (!fs.existsSync(resources)) return [`missing resources directory: ${sub}`];

  const problems = [];
  let scanned = 0;
  for (const file of listFiles(resources)) {
    const base = path.basename(file);
    const rel = path.relative(appDir, file);
    if (base.startsWith(".env") || base === "app.asar") {
      // latin1 keeps every byte and is safe for the ASCII patterns above.
      problems.push(...scanText(fs.readFileSync(file).toString("latin1"), rel));
      scanned++;
    }
  }
  if (scanned === 0) problems.push(`nothing scanned under ${sub}: expected .env.production and app.asar`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, appDir] = process.argv.slice(2);
  if (!platform || !appDir) {
    console.error("usage: check-packaged-secrets.mjs <mac|win> <appDir>");
    process.exit(2);
  }
  const problems = checkPackagedSecrets(platform, path.resolve(appDir));
  if (problems.length) {
    console.error(`::error::${appDir} ships secret material it must not (BACKLOG-3834):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${appDir}: no Google Maps key in packaged env files or app.asar`);
}
