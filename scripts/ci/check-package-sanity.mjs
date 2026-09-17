#!/usr/bin/env node
/**
 * Release gate: refuse to ship a package that contains build output (BACKLOG-3425).
 *
 * ## What it is for
 *
 * v2.35.0, v2.36.0 and v2.37.0 all shipped an Intel macOS build that cannot launch. The
 * x64 `app.asar` was 2,280,219,194 bytes and contained the arm64 pass's entire output —
 * a 1.1 GB copy of the arm64 DMG, the finished arm64 `Keepr.app`, and two copies of the
 * Electron runtime. 1,396 of its 17,517 entries end at or past the 2 GiB mark, and
 * `package.json` — the first file Electron reads, to find `main` — was one of them. It
 * extracted as corrupted bytes, so the app died before running a line of its own code.
 * One Dock bounce, then nothing. No Sentry event: the crash precedes SDK init.
 *
 * Three releases went out with a 3.2x size gap between the two Mac DMGs and nothing
 * looked. This is the check that looks.
 *
 * ## What it inspects
 *
 * The asar HEADER only — a JSON manifest of every entry with its size and its offset.
 * No extraction, no `require`, no content read. Deliberately NOT "extract package.json
 * and JSON.parse it": Node's own `fs.readSync` handles positions past 2^31 perfectly
 * well, so that check would have PASSED on the broken artifact. The corruption is in
 * Electron's asar layer, not in Node's file I/O.
 *
 * ## The rules
 *
 * 1. NESTED BUILD OUTPUT — an entry under the packager's output directory, an entry
 *    inside a `.app` bundle, a nested `.asar`, a bundled `Electron Framework`, or an
 *    installer artifact (`.dmg`/`.zip`/`.exe`/…). This names the actual defect and does
 *    not depend on how big the result happens to be.
 * 2. TWO-GIB BOUNDARY — no packed entry may end at or past 2^31. This is the reason the
 *    Intel build would not launch. The exact boundary at which extraction corrupts is
 *    not pinned: `/dist-electron/main.js` at 162,318,770 was fine and `/package.json` at
 *    2,377,960,725 was not. 2 GiB is the conservative line.
 * 3. CEILING + CROSS-ARCHITECTURE RATIO — total packed content per archive, and the
 *    spread between archives when more than one is given. Blunt instruments, kept as a
 *    backstop for a future defect that rule 1 has no signature for.
 *
 * ## Usage
 *
 *   # after packaging — inspect the artifacts
 *   node scripts/ci/check-package-sanity.mjs \
 *     --output-dir release --max-content-mb 400 --max-ratio 1.5 \
 *     release/mac-arm64/Keepr.app release/mac/Keepr.app
 *
 *   # on every commit — inspect the config that caused it
 *   node scripts/ci/check-package-sanity.mjs --config package.json
 *
 * Each artifact path may be a `.app` bundle, a directory holding `resources/app.asar`
 * (electron-builder's `*-unpacked` layout), or an `app.asar` file directly.
 *
 * The `--config` mode needs no build, which is the point: packaging only runs on pushes
 * to develop and main, so a config edit could sit green through every PR check that ever
 * looks at it. It asserts the one invariant that makes this defect possible —
 * `build.directories.output` must be set, and must not be a directory that any
 * `build.files` include pattern reaches. package.json cannot carry a comment saying so.
 *
 * Exit 0 = clean. Exit 1 = violations (each printed as a GitHub Actions `::error::`).
 * Exit 2 = usage or I/O failure — never a silent pass.
 */
import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// Both workflows invoke this with plain `node`, where this is an inert property. Under
// Electron -- including ELECTRON_RUN_AS_NODE, which the pre-push hook uses -- `fs` is
// patched to treat any path ending in `.asar` as an ARCHIVE TO LOOK INSIDE, and reading
// `app.asar` as a file fails with "Invalid package". This guard must read it as a file.
process.noAsar = true;

const TWO_GIB = 2 ** 31;

const DEFAULTS = {
  maxContentMb: 400,
  maxRatio: 1.5,
};

/**
 * Installer/packaging artifact extensions. `.snap` is deliberately ABSENT: it is also
 * jest's snapshot extension, and the repo ships `__snapshots__/*.snap` inside the app.
 * Measured against the published v2.37.0 manifests — with `.snap` in this list it fired
 * on two legitimate files; without it, zero false positives across 16,752 real entries
 * per architecture.
 */
const ARTIFACT_EXTENSIONS = ['dmg', 'zip', 'exe', 'pkg', 'blockmap', 'msi', 'appx', 'deb', 'rpm', 'appimage'];
const ARTIFACT_RE = new RegExp(`\\.(${ARTIFACT_EXTENSIONS.join('|')})$`, 'i');

/**
 * asar container layout (see @electron/asar `readArchiveHeaderSync`):
 *   [0..3]   uint32 = 4                  pickle header of the size pickle
 *   [4..7]   uint32 = headerPickleSize
 *   [8..11]  uint32 = header pickle payload size
 *   [12..15] uint32 = JSON string length
 *   [16..]   the header JSON
 * Entry offsets are relative to `8 + headerPickleSize`.
 */
export function readAsarHeader(archivePath) {
  const fd = openSync(archivePath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    if (readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
      throw new Error(`${archivePath}: too short to hold an asar size pickle`);
    }
    if (sizeBuf.readUInt32LE(0) !== 4) {
      throw new Error(`${archivePath}: not an asar archive (unexpected size pickle header)`);
    }
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    if (readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
      throw new Error(`${archivePath}: truncated asar header`);
    }
    const stringLength = headerBuf.readUInt32LE(4);
    const json = headerBuf.toString('utf8', 8, 8 + stringLength);
    return { header: JSON.parse(json), dataStart: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

/** Flatten the manifest tree to `{ path, size, offset, unpacked, link }` records. */
export function flattenHeader(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, value] of Object.entries(node.files || {})) {
      const path = `${prefix}/${name}`;
      if (value.files) {
        walk(value, path);
        continue;
      }
      out.push({
        path,
        size: value.size || 0,
        offset: value.offset === undefined ? null : Number(value.offset),
        unpacked: value.unpacked === true,
        link: value.link,
      });
    }
  })(header, '');
  return out;
}

/** Why this entry looks like build output that has been swallowed by the package. */
export function buildOutputReason(path, outputDir) {
  const segments = path.split('/').filter(Boolean);
  if (outputDir && segments[0] === outputDir) {
    return `inside the packager's own output directory "${outputDir}/"`;
  }
  const bundle = segments.find((s) => s.toLowerCase().endsWith('.app'));
  if (bundle) return `inside a nested application bundle "${bundle}"`;
  const nested = segments.find((s) => s.toLowerCase().endsWith('.asar'));
  if (nested) return `a nested asar archive "${nested}"`;
  if (segments[segments.length - 1] === 'Electron Framework') {
    return 'a bundled copy of the Electron runtime';
  }
  if (ARTIFACT_RE.test(path)) return 'a packaged installer artifact';
  return null;
}

/** Resolve a CLI path to the app.asar it names. */
export function resolveArchive(target) {
  if (!existsSync(target)) throw new Error(`no such path: ${target}`);
  if (statSync(target).isFile()) return target;
  for (const candidate of [
    join(target, 'Contents', 'Resources', 'app.asar'), // macOS .app bundle
    join(target, 'resources', 'app.asar'), // win-unpacked / linux-unpacked
    join(target, 'app.asar'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no app.asar found under ${target}`);
}

export function inspectArchive(archivePath, { outputDir }) {
  const { header, dataStart } = readAsarHeader(archivePath);
  const entries = flattenHeader(header);

  const buildOutput = [];
  const past2Gib = [];
  let packedBytes = 0;
  let unpackedBytes = 0;

  for (const entry of entries) {
    if (entry.link !== undefined) continue; // symlink: no content of its own
    if (entry.offset === null) {
      unpackedBytes += entry.size;
    } else {
      packedBytes += entry.size;
      if (dataStart + entry.offset + entry.size >= TWO_GIB) {
        past2Gib.push({ path: entry.path, end: dataStart + entry.offset + entry.size });
      }
    }
    const reason = buildOutputReason(entry.path, outputDir);
    if (reason) buildOutput.push({ path: entry.path, size: entry.size, reason });
  }

  return { archivePath, dataStart, entries: entries.length, packedBytes, unpackedBytes, buildOutput, past2Gib };
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function check(targets, options) {
  const { outputDir, maxContentMb, maxRatio } = options;
  const errors = [];
  const reports = [];

  for (const target of targets) {
    const report = inspectArchive(resolveArchive(target), { outputDir });
    reports.push(report);

    const label = report.archivePath;
    console.log(
      `${label}: ${report.entries} entries, ${mb(report.packedBytes)} packed, ` +
        `${mb(report.unpackedBytes)} unpacked`,
    );

    if (report.buildOutput.length > 0) {
      const biggest = [...report.buildOutput].sort((a, b) => b.size - a.size).slice(0, 10);
      errors.push(
        `${label} contains ${report.buildOutput.length} build-output file(s) — the package has ` +
          `swallowed the build's own artifacts. Largest:\n` +
          biggest.map((e) => `    ${mb(e.size).padStart(12)}  ${e.path}  (${e.reason})`).join('\n'),
      );
    }

    if (report.past2Gib.length > 0) {
      const furthest = report.past2Gib.reduce((a, b) => (b.end > a.end ? b : a));
      // package.json is the entry Electron reads FIRST, to find `main`. If it is past the
      // boundary the app is dead on arrival — it never runs a line of its own code — so
      // say so separately instead of leaving it inside a count.
      const manifest = report.past2Gib.find((e) => e.path === '/package.json');
      errors.push(
        `${label} has ${report.past2Gib.length} entr(ies) at or past the 2 GiB offset boundary — ` +
          `Electron extracts those as corrupted bytes. ` +
          `Furthest: ${furthest.path} ends at ${furthest.end}.` +
          (manifest
            ? ` /package.json is one of them (ends at ${manifest.end}) — that is the first file ` +
              `Electron reads to find "main", so this build cannot launch at all.`
            : ''),
      );
    }

    if (report.packedBytes > maxContentMb * 1e6) {
      errors.push(
        `${label} holds ${mb(report.packedBytes)} of packed content, over the ${maxContentMb} MB ceiling.`,
      );
    }
  }

  if (reports.length > 1 && maxRatio > 0) {
    const sizes = reports.map((r) => r.packedBytes);
    const smallest = Math.min(...sizes);
    const largest = Math.max(...sizes);
    if (smallest > 0 && largest / smallest > maxRatio) {
      errors.push(
        `Packaged content differs by ${(largest / smallest).toFixed(2)}x across architectures ` +
          `(${mb(smallest)} .. ${mb(largest)}), over the ${maxRatio}x limit. The builds should be ` +
          `near-identical apart from the native binaries.`,
      );
    }
  }

  return { errors, reports };
}

/**
 * Static check on the electron-builder config: the packager's output directory must not
 * be reachable by any `build.files` include pattern.
 *
 * This is exactly what shipped broken. `files` listed `dist/**` + `dist` was also the
 * default output directory, so the arm64 pass wrote its artifacts into `dist/` and the
 * x64 pass, running second, packed them. electron-builder DOES compute an
 * `!<outDir>{,/**\/*}` exclusion for this — `app-builder-lib/out/fileMatcher.js`,
 * `getMainFileMatchers` — but splices it in at an index ahead of the user's own include,
 * and `util/filter.js` `minimatchAll` skips negate patterns while nothing has matched
 * yet. The exclusion exists and is inert. Do not rely on it.
 */
export function checkConfig(pkg) {
  const errors = [];
  const build = pkg.build;
  if (!build) {
    errors.push('package.json has no "build" section — electron-builder config is missing.');
    return errors;
  }

  const outputDir = build.directories && build.directories.output;
  if (!outputDir) {
    errors.push(
      'build.directories.output is not set, so electron-builder writes into "dist/" — the same ' +
        'directory the renderer build writes to and build.files ships. Set it to a directory ' +
        'build.files never names.',
    );
    return errors;
  }

  const outFirstSegment = String(outputDir).replace(/^\.\//, '').split('/').filter(Boolean)[0];
  const includes = (Array.isArray(build.files) ? build.files : [])
    .filter((p) => typeof p === 'string' && !p.startsWith('!'));
  for (const pattern of includes) {
    const first = pattern.replace(/^\.\//, '').split('/')[0];
    if (first === outFirstSegment || first === '**') {
      errors.push(
        `build.files pattern "${pattern}" reaches the packager's own output directory ` +
          `"${outputDir}/". The second architecture's pass then packs the first one's artifacts ` +
          `into its app.asar. This is the v2.35.0-v2.37.0 Intel failure (BACKLOG-3425).`,
      );
    }
  }
  return errors;
}

function parseArgs(argv) {
  const options = {
    outputDir: null,
    maxContentMb: DEFAULTS.maxContentMb,
    maxRatio: DEFAULTS.maxRatio,
    config: null,
  };
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output-dir') options.outputDir = argv[++i];
    else if (arg === '--max-content-mb') options.maxContentMb = Number(argv[++i]);
    else if (arg === '--max-ratio') options.maxRatio = Number(argv[++i]);
    else if (arg === '--config') options.config = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else targets.push(arg);
  }
  if (options.config == null && targets.length === 0) throw new Error('no package paths given');
  if (!Number.isFinite(options.maxContentMb) || !Number.isFinite(options.maxRatio)) {
    throw new Error('--max-content-mb and --max-ratio must be numbers');
  }
  return { options, targets };
}

function fail(errors, what) {
  for (const message of errors) console.error(`::error::${message}`);
  console.error(`check-package-sanity FAILED: ${errors.length} problem(s) in ${what}. See BACKLOG-3425.`);
  process.exit(1);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::check-package-sanity: ${err.message}`);
    console.error(
      'usage: check-package-sanity.mjs --config <package.json>\n' +
        '   or: check-package-sanity.mjs [--output-dir <name>] [--max-content-mb <n>] ' +
        '[--max-ratio <n>] <app-bundle-or-asar>...',
    );
    process.exit(2);
  }

  if (parsed.options.config) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(parsed.options.config, 'utf8'));
    } catch (err) {
      console.error(`::error::check-package-sanity could not read ${parsed.options.config}: ${err.message}`);
      process.exit(2);
    }
    const errors = checkConfig(pkg);
    if (errors.length > 0) fail(errors, parsed.options.config);
    console.log(
      `check-package-sanity: ${parsed.options.config} keeps the packager's output ` +
        `("${pkg.build.directories.output}/") out of build.files.`,
    );
    if (parsed.targets.length === 0) return;
  }

  let result;
  try {
    result = check(parsed.targets, parsed.options);
  } catch (err) {
    console.error(`::error::check-package-sanity could not inspect the package: ${err.message}`);
    process.exit(2);
  }

  if (result.errors.length > 0) fail(result.errors, `${result.reports.length} package(s)`);

  console.log(`check-package-sanity passed for ${result.reports.length} package(s).`);
}

if (process.argv[1] && basename(process.argv[1]) === 'check-package-sanity.mjs') main();
