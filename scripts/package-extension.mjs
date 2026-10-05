#!/usr/bin/env node
/**
 * SR clean-up C8 — the Chrome Web Store package of the Keepr extension.
 *
 *   node scripts/package-extension.mjs        → release/keepr-extension-<version>.zip
 *
 * The zip is chrome-extension/ as it ships to the store:
 * - manifest.json WITHOUT "key" (the store assigns the published id; the key
 *   stays in the source so the dev / unpacked install keeps its stable id);
 * - no dev-only files (DEV_ONLY: the bundle's build entry and notes, the SBOM,
 *   dotfiles). The vendored code's licence ships.
 *
 * No dependencies: a stored-or-deflated zip written with node:zlib (CRC-32 by
 * table, so it runs on every Node the CI uses). Deterministic: sorted entries
 * and a fixed timestamp, so the same source gives the same bytes.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION_DIR = path.join(ROOT, "chrome-extension");

/** Never in the store package (paths relative to chrome-extension/, "/" separated). */
export const DEV_ONLY = new Set(["vendor/noble-p256.entry.mjs", "vendor/README.md", "vendor/SBOM.json"]);

/** Is this file left out of the store package? */
export function isDevOnly(rel) {
  return DEV_ONLY.has(rel) || rel.split("/").some((part) => part.startsWith(".")) || rel.endsWith(".map");
}

/** Every file to package (sorted), relative and "/" separated. */
export function packageFiles(dir = EXTENSION_DIR) {
  const out = [];
  const walk = (sub) => {
    for (const name of fs.readdirSync(path.join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (fs.statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else if (!isDevOnly(rel)) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** manifest.json for the store: the same, minus "key". */
export function storeManifest(text) {
  const manifest = JSON.parse(text);
  delete manifest.key;
  return JSON.stringify(manifest, null, 2) + "\n";
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00 in DOS time: fixed, so the bytes do not depend on the clock.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A zip of [name, bytes] entries (deflated). */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** The store package: { version, files, bytes }. */
export function buildExtensionZip(dir = EXTENSION_DIR) {
  const files = packageFiles(dir);
  const manifestText = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  const version = JSON.parse(manifestText).version;
  const entries = files.map((rel) => [
    rel,
    rel === "manifest.json" ? Buffer.from(storeManifest(manifestText), "utf8") : fs.readFileSync(path.join(dir, rel)),
  ]);
  return { version, files, bytes: zip(entries) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, files, bytes } = buildExtensionZip();
  const outDir = path.join(ROOT, "release");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `keepr-extension-${version}.zip`);
  fs.writeFileSync(out, bytes);
  console.log(`${path.relative(ROOT, out)}: ${files.length} files, ${bytes.length} bytes (no manifest key, no dev-only files)`);
}
