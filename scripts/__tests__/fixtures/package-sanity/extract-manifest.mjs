#!/usr/bin/env node
/**
 * Fixture extractor for scripts/__tests__/checkPackageSanity.test.ts (BACKLOG-3425).
 *
 * Reads a REAL app.asar's header and writes a reduced transcript of its manifest as
 * JSON. The reduction is deterministic and stated below so the fixtures in this
 * directory can be regenerated from the published artifacts and checked against them.
 *
 * Nothing here is invented. Every `size` and `offset` is copied verbatim out of the
 * archive's own header. `integrity` (a SHA-256 per file plus per-block hashes) is
 * dropped — the guard never reads it and it would multiply the fixture size by ~8.
 *
 * ## The reduction
 *   keep  /package.json
 *   keep  every file directly under /dist/ and under /dist/assets/   (the renderer)
 *   keep  the 80 largest files by size, anywhere
 *   sort  by path
 *
 * `totals` records the aggregates of the FULL manifest, not of the reduction, so the
 * test can quote the real numbers while asserting on the subset.
 *
 * ## How the committed fixtures were produced
 *   # arm64 — the founder's installed v2.37.0 (this is the published arm64 artifact)
 *   node extract-manifest.mjs /Applications/Keepr.app/Contents/Resources/app.asar \
 *     keepr-2.37.0-arm64.manifest.json
 *
 *   # x64 — the published Intel DMG, mounted read-only
 *   gh release download v2.37.0 -R Keepr-Compliance/keepr-releases -p 'Keepr-2.37.0.dmg'
 *   hdiutil attach -readonly -nobrowse -mountpoint /tmp/k237 Keepr-2.37.0.dmg
 *   node extract-manifest.mjs /tmp/k237/Keepr.app/Contents/Resources/app.asar \
 *     keepr-2.37.0-x64.manifest.json 'Keepr-2.37.0.dmg -> Keepr.app/Contents/Resources/app.asar'
 *   hdiutil detach /tmp/k237
 *
 * The optional third argument is what `source.archive` records. Pass it whenever the
 * archive was read from a mount point or a scratch directory, so the fixture names the
 * artifact rather than one machine's temporary path.
 */
import { openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';

const TWO_GIB = 2 ** 31;

/**
 * asar container layout (see @electron/asar `readArchiveHeaderSync`):
 *   [0..3]   uint32  = 4                      (pickle header of the size pickle)
 *   [4..7]   uint32  = headerPickleSize
 *   [8..11]  uint32  = header pickle payload size
 *   [12..15] uint32  = JSON string length
 *   [16..]   the header JSON
 * File contents start at 8 + headerPickleSize; each entry's `offset` is relative to that.
 */
export function readAsarHeader(archivePath) {
  const fd = openSync(archivePath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('unable to read asar size pickle');
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    if (readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
      throw new Error('unable to read asar header pickle');
    }
    const stringLength = headerBuf.readUInt32LE(4);
    const json = headerBuf.toString('utf8', 8, 8 + stringLength);
    return { header: JSON.parse(json), dataStart: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

export function flatten(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, value] of Object.entries(node.files || {})) {
      const p = `${prefix}/${name}`;
      if (value.files) {
        walk(value, p);
        continue;
      }
      out.push({ path: p, entry: value });
    }
  })(header, '');
  return out;
}

function main() {
  const [archive, outFile, label] = process.argv.slice(2);
  if (!archive || !outFile) {
    console.error('usage: extract-manifest.mjs <app.asar> <out.json> [recorded-label]');
    process.exit(2);
  }

  const { header, dataStart } = readAsarHeader(archive);
  const all = flatten(header);

  let contentBytes = 0;
  let past2Gib = 0;
  for (const { entry } of all) {
    contentBytes += entry.size || 0;
    if (entry.offset !== undefined && dataStart + Number(entry.offset) + (entry.size || 0) >= TWO_GIB) {
      past2Gib += 1;
    }
  }

  const keep = new Map();
  const add = ({ path: p, entry }) => {
    const reduced = { path: p, size: entry.size };
    if (entry.offset !== undefined) reduced.offset = entry.offset;
    if (entry.unpacked) reduced.unpacked = true;
    if (entry.executable) reduced.executable = true;
    if (entry.link !== undefined) reduced.link = entry.link;
    keep.set(p, reduced);
  };

  for (const e of all) {
    if (e.path === '/package.json') add(e);
    else if (/^\/dist\/(assets\/)?[^/]+$/.test(e.path)) add(e);
  }
  for (const e of [...all].sort((a, b) => (b.entry.size || 0) - (a.entry.size || 0)).slice(0, 80)) {
    add(e);
  }

  const doc = {
    source: {
      archive: label || archive,
      archiveBytes: statSync(archive).size,
      dataStart,
      extractedAt: new Date().toISOString().slice(0, 10),
    },
    totals: { files: all.length, contentBytes, filesAtOrPast2Gib: past2Gib },
    reduction: '/package.json + every file directly under /dist and /dist/assets + the 80 largest files; integrity dropped',
    files: [...keep.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };

  writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`${outFile}: ${doc.files.length} of ${all.length} entries, totals ${JSON.stringify(doc.totals)}`);
}

if (process.argv[1] && process.argv[1].endsWith('extract-manifest.mjs')) main();
