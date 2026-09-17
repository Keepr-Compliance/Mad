/**
 * Tests for scripts/ci/check-package-sanity.mjs — the release gate that refuses a package
 * containing the build's own output (BACKLOG-3425).
 *
 * Runs in CI: jest.config.js `testMatch` includes '<rootDir>/scripts/__tests__/**'.
 *
 * ## The fixtures are transcripts, not inventions
 *
 * Both manifests in fixtures/package-sanity/ were read out of a PUBLISHED v2.37.0
 * artifact's asar header. Every `size` and `offset` below is the archive's own number.
 *
 *   keepr-2.37.0-arm64.manifest.json
 *     /Applications/Keepr.app/Contents/Resources/app.asar on the founder's machine —
 *     the installed arm64 build, 466,812,761 bytes, 17,025 entries, 525.4 MB of content.
 *
 *   keepr-2.37.0-x64.manifest.json
 *     Keepr-2.37.0.dmg from Keepr-Compliance/keepr-releases, mounted read-only — the
 *     Intel build that will not launch. 2,280,219,194 bytes, 17,517 entries, 2,467.1 MB
 *     of content, 1,396 entries ending at or past 2 GiB.
 *
 * Both are reduced to 88 entries by the deterministic rule stated in
 * fixtures/package-sanity/extract-manifest.mjs, which also carries the commands that
 * regenerate them. `totals` in each file records the FULL manifest's aggregates.
 *
 * ## The third case is derived, and says so
 *
 * There is no "fixed" artifact to transcribe — the fix has never been built. The passing
 * case is the real arm64 manifest with every `/dist/mac-arm64/**` entry removed, which is
 * structurally what moving `directories.output` produces. It is labelled derived
 * everywhere it is used.
 *
 * ## Why header-only archives
 *
 * The guard reads the asar HEADER and nothing else, so each case is materialised as a
 * real asar container carrying a real header and no file content — ~15 KB instead of
 * 2.3 GB. `buildHeaderOnlyAsar` writes the exact container layout @electron/asar reads
 * (verified against both published archives), so the guard's own reader is under test,
 * not a stub of it.
 *
 * The guard is spawned as a subprocess rather than imported: that runs the exact CLI
 * contract release.yml and ci.yml invoke — argument parsing, exit code, `::error::`
 * output — instead of a function the workflows never call.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const GUARD = path.resolve(__dirname, '../ci/check-package-sanity.mjs');
const FIXTURES = path.resolve(__dirname, 'fixtures/package-sanity');

interface ManifestEntry {
  path: string;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
}

interface ManifestFixture {
  source: { archive: string; archiveBytes: number; dataStart: number; extractedAt: string };
  totals: { files: number; contentBytes: number; filesAtOrPast2Gib: number };
  files: ManifestEntry[];
}

const arm64: ManifestFixture = JSON.parse(
  readFileSync(path.join(FIXTURES, 'keepr-2.37.0-arm64.manifest.json'), 'utf8'),
);
const x64: ManifestFixture = JSON.parse(
  readFileSync(path.join(FIXTURES, 'keepr-2.37.0-x64.manifest.json'), 'utf8'),
);

/**
 * Write a real asar container holding `entries` in its header and no file content.
 *
 * Layout, as @electron/asar's `readArchiveHeaderSync` reads it:
 *   [0..3]   uint32  4                      pickle header of the size pickle
 *   [4..7]   uint32  headerPickleSize
 *   [8..11]  uint32  header pickle payload size
 *   [12..15] uint32  JSON string length
 *   [16..]   the header JSON, zero-padded to a 4-byte boundary
 *
 * `dataStart` (8 + headerPickleSize) is what entry offsets are relative to, so the header
 * has to be padded to the fixture's own dataStart for the recorded offsets to mean what
 * they meant in the published archive. The padding goes into an unreferenced key.
 */
function buildHeaderOnlyAsar(entries: ManifestEntry[], outPath: string, dataStart: number): string {
  const tree: Record<string, unknown> = { files: {} };
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    let node = tree as { files: Record<string, { files?: Record<string, unknown> }> };
    for (const dir of segments.slice(0, -1)) {
      if (!node.files[dir]) node.files[dir] = { files: {} };
      node = node.files[dir] as { files: Record<string, { files?: Record<string, unknown> }> };
    }
    const leaf: Record<string, unknown> = {};
    if (entry.link !== undefined) leaf.link = entry.link;
    else {
      leaf.size = entry.size ?? 0;
      if (entry.offset !== undefined) leaf.offset = entry.offset;
      if (entry.unpacked) leaf.unpacked = true;
      if (entry.executable) leaf.executable = true;
    }
    node.files[segments[segments.length - 1]] = leaf;
  }

  // Pad the header to the fixture's dataStart so the transcribed offsets stay meaningful.
  const pad = (n: number): string => {
    (tree as { padding?: string }).padding = 'x'.repeat(Math.max(0, n));
    return JSON.stringify(tree);
  };
  let json = pad(0);
  const overhead = 16; // the four uint32 fields
  const target = dataStart - overhead;
  if (Buffer.byteLength(json) < target) json = pad(target - Buffer.byteLength(json));

  const stringLength = Buffer.byteLength(json);
  const alignedLength = Math.ceil(stringLength / 4) * 4;
  const payloadSize = 4 + alignedLength;
  const headerPickleSize = 4 + payloadSize;

  const buf = Buffer.alloc(8 + headerPickleSize);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(headerPickleSize, 4);
  buf.writeUInt32LE(payloadSize, 8);
  buf.writeUInt32LE(stringLength, 12);
  buf.write(json, 16, 'utf8');
  writeFileSync(outPath, buf);
  return outPath;
}

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'keepr-pkg-sanity-'));
});

const materialised = new Map<string, string>();
/** Build (once per name) a header-only asar for these entries. */
function materialise(name: string, entries: ManifestEntry[], dataStart: number): string {
  const cached = materialised.get(name);
  if (cached) return cached;
  const built = buildHeaderOnlyAsar(entries, path.join(workDir, `${name}.asar`), dataStart);
  materialised.set(name, built);
  return built;
}

function runGuard(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The arm64 manifest with the packager's output removed — derived, not transcribed. */
const arm64Fixed = arm64.files.filter((f) => !f.path.startsWith('/dist/mac-arm64/'));
/** The x64 manifest's entries outside /dist — real, and one of them sits past 2 GiB. */
const x64OutsideDist = x64.files.filter((f) => !f.path.startsWith('/dist/'));

describe('check-package-sanity: the container reader', () => {
  it('reads back a header it wrote, and agrees with the published archives', () => {
    // The transcript's own dataStart is reproduced, which is what makes the recorded
    // offsets comparable to the 2 GiB boundary.
    const asar = materialise('roundtrip', arm64.files, arm64.source.dataStart);
    const { status, stdout } = runGuard(['--max-content-mb', '100000', '--max-ratio', '0', asar]);
    expect(stdout).toContain(`${arm64.files.length} entries`);
    expect(status).toBe(1); // still fails: the arm64 build carries its own output
  });

  it('exits 2, never 0, on something that is not an asar', () => {
    const notAnAsar = path.join(workDir, 'not-an-asar.bin');
    writeFileSync(notAnAsar, Buffer.alloc(64));
    const { status, stderr } = runGuard([notAnAsar]);
    expect(status).toBe(2);
    expect(stderr).toContain('not an asar archive');
  });

  it('exits 2 when given no paths', () => {
    const { status, stderr } = runGuard([]);
    expect(status).toBe(2);
    expect(stderr).toContain('no package paths given');
  });
});

describe('check-package-sanity: the published v2.37.0 Intel build', () => {
  it('fails, and says the package swallowed the build output', () => {
    const asar = materialise('x64', x64.files, x64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('build-output file(s)');
    expect(stderr).toContain('/dist/.tempuy287mh4Keepr-2.37.0-arm64.dmg');
  });

  it('fails on the 2 GiB boundary, naming package.json', () => {
    const asar = materialise('x64', x64.files, x64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('2 GiB offset boundary');
    // 2,373,311,913 is the offset the archive records for /package.json; + dataStart
    // 4,648,812 = 2,377,962,570, the absolute position Electron read corrupted bytes from.
    expect(stderr).toContain('/package.json is one of them (ends at 2377962570)');
    expect(stderr).toContain('this build cannot launch at all');
  });
});

describe('check-package-sanity: the published v2.37.0 arm64 build', () => {
  it('fails too — it launches, but it carries a second copy of the Electron runtime', () => {
    const asar = materialise('arm64', arm64.files, arm64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('build-output file(s)');
    expect(stderr).toContain('Electron Framework');
    // It is under the boundary — that is the ONLY reason Apple Silicon users can start it.
    expect(stderr).not.toContain('2 GiB offset boundary');
  });

  it('is caught by signature even though --output-dir names a directory it never mentions', () => {
    // ANTI-VACUITY. The offending paths are under `/dist/`, and the flag says `release`.
    // A guard that only matched the output directory name would pass this and would have
    // let the next release through. It must fail on the signatures instead.
    const asar = materialise('arm64', arm64.files, arm64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('nested application bundle');
    expect(stderr).not.toContain("inside the packager's own output directory");
  });
});

describe('check-package-sanity: what the fix produces', () => {
  it('passes once the packager output is gone', () => {
    const asar = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    const { status, stdout, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('check-package-sanity passed for 1 package(s)');
  });

  it('still passes with the ceiling CI uses', () => {
    // Real numbers: the published arm64 archive holds 462.3 MB of packed content; with
    // /dist/mac-arm64 removed that is 182.4 MB. 400 fails the first and passes the second.
    const asar = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    expect(runGuard(['--output-dir', 'release', '--max-content-mb', '400', asar]).status).toBe(0);
  });
});

describe('check-package-sanity: each rule fires on its own', () => {
  it('flags the 2 GiB boundary with no build output present', () => {
    // Real entries from the Intel archive, outside /dist — none of them trips the
    // build-output rule, and /package.json still sits past the boundary.
    const asar = materialise('x64-outside-dist', x64OutsideDist, x64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('2 GiB offset boundary');
    expect(stderr).not.toContain('build-output file(s)');
  });

  it('flags the content ceiling with nothing else wrong', () => {
    const asar = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', '--max-content-mb', '10', asar]);
    expect(status).toBe(1);
    expect(stderr).toContain('over the 10 MB ceiling');
    expect(stderr).not.toContain('build-output file(s)');
    expect(stderr).not.toContain('2 GiB offset boundary');
  });

  it('flags a cross-architecture size gap', () => {
    const a = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    const b = materialise('x64', x64.files, x64.source.dataStart);
    const { status, stderr } = runGuard(['--max-content-mb', '100000', '--max-ratio', '1.5', a, b]);
    expect(status).toBe(1);
    expect(stderr).toContain('differs by');
    expect(stderr).toContain('over the 1.5x limit');
  });

  it('does not flag two packages of comparable size', () => {
    const a = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    const { status } = runGuard(['--output-dir', 'release', '--max-ratio', '1.5', a, a]);
    expect(status).toBe(0);
  });

  it('does not apply the ratio rule to a single package', () => {
    const a = materialise('arm64-fixed', arm64Fixed, arm64.source.dataStart);
    const { status, stderr } = runGuard(['--output-dir', 'release', '--max-ratio', '1.5', a]);
    expect(stderr).not.toContain('differs by');
    expect(status).toBe(0);
  });
});

describe('check-package-sanity: the signatures do not fire on real app content', () => {
  it('leaves jest snapshots alone', () => {
    // `.snap` was in the first draft of the artifact-extension list, as Linux's snap
    // package format. Measured against the published manifests it fired on
    // electron/services/db/__snapshots__/transactionSearchDbService.test.ts.snap and one
    // other — both files the app legitimately ships. It is out of the list; this holds
    // it out.
    const asar = materialise(
      'snapshots',
      [
        { path: '/electron/services/db/__snapshots__/transactionSearchDbService.test.ts.snap', size: 1024, offset: '0' },
        { path: '/package.json', size: 1845, offset: '1024' },
      ],
      1024,
    );
    const { status, stderr } = runGuard(['--output-dir', 'release', asar]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });
});

describe('check-package-sanity --config: the invariant package.json cannot comment', () => {
  function writeConfig(name: string, build: unknown): string {
    const file = path.join(workDir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ name: 'keepr', build }, null, 2));
    return file;
  }

  it('passes the repo config as this branch leaves it', () => {
    const { status, stdout, stderr } = runGuard(['--config', path.resolve(__dirname, '../../package.json')]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('keeps the packager\'s output ("release/") out of build.files');
  });

  it('fails the config as it shipped in v2.37.0 — no output dir, files listing dist/**', () => {
    // Transcribed from package.json at the commit this branch forked from: `files` was
    // ["dist/**/*", "dist-electron/**/*", "electron/**/*"] and `directories` carried only
    // buildResources, so electron-builder's output defaulted to dist/.
    const cfg = writeConfig('shipped-2.37.0', {
      files: ['dist/**/*', 'dist-electron/**/*', 'electron/**/*'],
      directories: { buildResources: 'build' },
    });
    const { status, stderr } = runGuard(['--config', cfg]);
    expect(status).toBe(1);
    expect(stderr).toContain('build.directories.output is not set');
  });

  it('fails a config that moves the output back on top of a files pattern', () => {
    const cfg = writeConfig('output-collides', {
      files: ['dist/**/*', 'dist-electron/**/*', 'electron/**/*'],
      directories: { buildResources: 'build', output: 'dist' },
    });
    const { status, stderr } = runGuard(['--config', cfg]);
    expect(status).toBe(1);
    expect(stderr).toContain('reaches the packager\'s own output directory "dist/"');
  });

  it('fails a catch-all files pattern, which reaches any output directory', () => {
    const cfg = writeConfig('catch-all', {
      files: ['**/*'],
      directories: { buildResources: 'build', output: 'release' },
    });
    const { status, stderr } = runGuard(['--config', cfg]);
    expect(status).toBe(1);
    expect(stderr).toContain('reaches the packager\'s own output directory');
  });

  it('is not fooled by a negation that merely mentions the output directory', () => {
    const cfg = writeConfig('negation-only', {
      files: ['dist/**/*', '!release/**/*', 'electron/**/*'],
      directories: { buildResources: 'build', output: 'release' },
    });
    expect(runGuard(['--config', cfg]).status).toBe(0);
  });
});

describe('check-package-sanity: the fixtures are what they claim to be', () => {
  it('records the published archives aggregates', () => {
    expect(x64.source.archiveBytes).toBe(2280219194);
    expect(x64.totals).toEqual({ files: 17517, contentBytes: 2467110148, filesAtOrPast2Gib: 1396 });
    expect(arm64.source.archiveBytes).toBe(466812761);
    expect(arm64.totals).toEqual({ files: 17025, contentBytes: 525364993, filesAtOrPast2Gib: 0 });
  });

  it('carries the entries the diagnosis named', () => {
    const byPath = new Map(x64.files.map((f) => [f.path, f]));
    expect(byPath.get('/dist/.tempuy287mh4Keepr-2.37.0-arm64.dmg')?.size).toBe(1128112128);
    expect(byPath.get('/dist/mac-arm64/Keepr.app/Contents/Resources/app.asar')?.size).toBe(466812761);
    expect(byPath.get('/package.json')?.offset).toBe('2373311913');
  });
});
