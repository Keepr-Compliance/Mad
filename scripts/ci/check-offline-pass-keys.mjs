#!/usr/bin/env node
/**
 * Release gate for the offline pass verification keys (BACKLOG-3675).
 *
 * electron/constants/offlinePassKeys.ts ships with an EMPTY key map as a
 * placeholder until the production signing key exists. An empty map means
 * the desktop rejects every offline pass. This check fails unless the map
 * holds at least one entry and every entry is a valid Ed25519 public key
 * (SPKI DER, base64). It runs in the release workflow only, so ordinary PRs
 * stay green while the placeholder is in place.
 *
 * Usage: node scripts/ci/check-offline-pass-keys.mjs [--file <path>]
 * Exit 0 = ready to release; exit 1 = placeholder or invalid key.
 */

import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_FILE = path.join(ROOT, "electron/constants/offlinePassKeys.ts");

const fileArg = process.argv.indexOf("--file");
const file = fileArg !== -1 && process.argv[fileArg + 1] ? path.resolve(process.argv[fileArg + 1]) : DEFAULT_FILE;

function fail(message) {
  console.error(`check-offline-pass-keys: FAIL — ${message}`);
  console.error(
    "  Set the production Ed25519 public key in electron/constants/offlinePassKeys.ts before releasing.",
  );
  process.exit(1);
}

let source;
try {
  source = readFileSync(file, "utf8");
} catch (error) {
  fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
}

const match = source.match(/OFFLINE_PASS_PUBLIC_KEYS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
if (!match) fail(`no OFFLINE_PASS_PUBLIC_KEYS = Object.freeze({...}) found in ${file}`);

// Drop comments so a commented-out example key does not count.
const body = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const entries = [...body.matchAll(/["']?([A-Za-z0-9_-]+)["']?\s*:\s*["']([^"']*)["']/g)].map((m) => ({
  kid: m[1],
  value: m[2],
}));
const leftover = body.replace(/["']?[A-Za-z0-9_-]+["']?\s*:\s*["'][^"']*["']/g, "").replace(/[\s,]/g, "");
if (leftover.length > 0) fail(`unrecognised content in the key map: ${leftover.slice(0, 40)}`);

if (entries.length === 0) fail("the offline pass key map is empty (placeholder)");

for (const { kid, value } of entries) {
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") fail(`kid "${kid}" is ${key.asymmetricKeyType}, not ed25519`);
  } catch (error) {
    fail(`kid "${kid}" is not a valid SPKI DER base64 public key (${error instanceof Error ? error.message : String(error)})`);
  }
}

console.log(`check-offline-pass-keys: OK — ${entries.length} key(s): ${entries.map((e) => e.kid).join(", ")}`);
