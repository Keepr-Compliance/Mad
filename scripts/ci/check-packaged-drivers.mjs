#!/usr/bin/env node
/**
 * Release gate: Apple driver payload per distribution channel (BACKLOG-3927).
 *
 * The Microsoft Store failed certification on policy 10.2.4.2 ("Your product
 * contains drivers that have not been provided by Microsoft") because the
 * Windows installer carried Apple Mobile Device Support. The Store build must
 * carry no driver payload at all; the website build must still carry Apple's
 * installer, which it installs with the user's consent.
 *
 * Usage: node scripts/ci/check-packaged-drivers.mjs <appDir> <website|store>
 *   appDir: a Windows app root (win-unpacked, or the app unpacked from the
 *           installer) — it contains resources/app.asar.
 *
 * store   fails when, anywhere under appDir, a file is a driver payload
 *         (.msi .sys .inf .cat) or is named AppleMobileDeviceSupport*, when
 *         any file sits under resources/win/apple-drivers/ (the folder must
 *         not ship at all), or when app.asar's package.json does not say
 *         distributionChannel "store".
 * website fails when resources/win/apple-drivers/AppleMobileDeviceSupport64.msi
 *         is absent or empty, or when app.asar's package.json says "store".
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Under Electron's node mode, fs treats *.asar as an archive; walk it as a file.
process.noAsar = true;

const require = createRequire(import.meta.url);

export const DRIVER_EXTENSIONS = [".msi", ".sys", ".inf", ".cat"];
export const APPLE_DRIVER_NAME_RE = /^AppleMobileDeviceSupport/i;
export const WEBSITE_MSI = "resources/win/apple-drivers/AppleMobileDeviceSupport64.msi";
export const APPLE_DRIVERS_DIR = "resources/win/apple-drivers/";
export const CHANNEL_FIELD = "distributionChannel";

/** Report paths with "/" on every platform (Windows path.relative uses "\\"). */
export function toPosixRelative(appDir, file, pathLib = path) {
  return pathLib.relative(appDir, file).split(pathLib.sep).join("/");
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** Returns the asar package.json's channel field, or an error string. */
function readChannel(appDir) {
  const asarPath = path.join(appDir, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) return { error: "missing resources/app.asar" };
  try {
    const asar = require("@electron/asar");
    const pkg = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
    return { value: pkg[CHANNEL_FIELD] };
  } catch (error) {
    return { error: `could not read package.json from app.asar: ${error.message}` };
  }
}

export function checkPackagedDrivers(appDir, channel) {
  if (channel !== "website" && channel !== "store") {
    throw new Error("channel must be website or store");
  }
  if (!fs.existsSync(appDir)) return [`missing app directory: ${appDir}`];

  const problems = [];
  const files = listFiles(appDir);
  if (files.length === 0) return [`nothing to scan under ${appDir}`];

  const pkg = readChannel(appDir);
  if (pkg.error) problems.push(pkg.error);

  if (channel === "store") {
    for (const file of files) {
      const base = path.basename(file);
      const ext = path.extname(base).toLowerCase();
      const rel = toPosixRelative(appDir, file);
      if (DRIVER_EXTENSIONS.includes(ext) || APPLE_DRIVER_NAME_RE.test(base)) {
        problems.push(`driver payload in a Store build: ${rel}`);
      } else if (rel.startsWith(APPLE_DRIVERS_DIR)) {
        problems.push(`Apple driver folder in a Store build: ${rel}`);
      }
    }
    if (!pkg.error && pkg.value !== "store") {
      problems.push(`app.asar package.json ${CHANNEL_FIELD} is ${JSON.stringify(pkg.value)}, expected "store"`);
    }
  } else {
    const msi = path.join(appDir, WEBSITE_MSI);
    let size = -1;
    try {
      size = fs.statSync(msi).size;
    } catch {
      /* missing */
    }
    if (size <= 0) problems.push(`website build is missing ${WEBSITE_MSI}`);
    if (!pkg.error && pkg.value === "store") {
      problems.push(`website build is marked ${CHANNEL_FIELD} "store"`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appDir, channel] = process.argv.slice(2);
  if (!appDir || !channel) {
    console.error("usage: check-packaged-drivers.mjs <appDir> <website|store>");
    process.exit(2);
  }
  let problems;
  try {
    problems = checkPackagedDrivers(path.resolve(appDir), channel);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(2);
  }
  if (problems.length) {
    console.error(`::error::${appDir} fails the ${channel} driver check (BACKLOG-3927):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    channel === "store"
      ? `${appDir}: Store build — no driver payload, marked store`
      : `${appDir}: website build — Apple driver installer present`,
  );
}
