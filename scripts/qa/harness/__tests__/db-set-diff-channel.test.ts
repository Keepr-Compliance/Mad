/**
 * JSON-channel regression guard (BACKLOG-1850, live-validation DEFECT 2).
 *
 * The founder's run 2 crashed with an unparseable measurement ("]" + a Node
 * crash banner on stderr). Root causes hardened here:
 *   - measurement flows through a `--out` temp file (immune to Electron helper
 *     stdout/stderr pollution), with a sentinel-prefixed stdout line as fallback;
 *   - db-assert traps uncaught errors and writes `{error}` on the same channel.
 * This test locks the ADAPTER's recovery precedence (file first, then sentinel).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readMeasurement, launchFailure, createDbSetDiffAsserter, SENTINEL } from '../db-set-diff-asserter';

describe('readMeasurement — robust JSON channel (defect 2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-chan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const measurement = { stage: 'assert-db-measure', corpus: 190, filterOff: [], filterOn: [], linked: null };

  test('reads the measurement from the --out file (primary channel)', () => {
    const out = join(dir, 'm.json');
    writeFileSync(out, JSON.stringify(measurement));
    // Even with polluted stdout, the file wins.
    const m = readMeasurement(out, 'electron: some GPU warning\nrandom noise');
    expect(m).toMatchObject({ stage: 'assert-db-measure', corpus: 190 });
  });

  test('falls back to the sentinel stdout line when the file is absent', () => {
    const out = join(dir, 'missing.json');
    const stdout = [
      '[12345:0101/000000.000:INFO] some electron noise',
      SENTINEL + JSON.stringify(measurement),
      'trailing helper chatter',
    ].join('\n');
    const m = readMeasurement(out, stdout);
    expect(m).toMatchObject({ stage: 'assert-db-measure', corpus: 190 });
  });

  test('surfaces the {error} shape written on a trapped crash', () => {
    const out = join(dir, 'err.json');
    writeFileSync(out, JSON.stringify({ stage: 'assert-db-measure', error: 'Failed to decrypt database — encryption key may be invalid.' }));
    const m = readMeasurement(out, '');
    expect(m).toBeTruthy();
    expect(m!.error).toMatch(/Failed to decrypt/);
  });

  test('returns null when neither file nor sentinel line is present', () => {
    expect(readMeasurement(join(dir, 'nope.json'), 'just noise\nno json here')).toBeNull();
  });
});

describe('launchFailure — a stuck child fails FAST + actionable, never a hang', () => {
  const OUT = '/tmp/x.json';

  test('spawnSync timeout (ETIMEDOUT) → actionable fail (DB locked/large)', () => {
    const r = launchFailure({ error: { code: 'ETIMEDOUT', message: 'spawnSync … ETIMEDOUT' } }, OUT, null, 25_000);
    expect(r).toBeTruthy();
    expect(r!.status).toBe('fail');
    expect(r!.detail).toMatch(/timed out/i);
    expect(r!.detail).toMatch(/locked|large/i);
  });

  test('killed by SIGKILL with no measurement → actionable fail', () => {
    const r = launchFailure({ signal: 'SIGKILL', status: null }, OUT, null, 25_000);
    expect(r!.status).toBe('fail');
    expect(r!.detail).toMatch(/SIGKILL/);
  });

  test('exit with no measurement → hints the ABI rebuild remedy', () => {
    const r = launchFailure({ status: 1 }, OUT, null, 100);
    expect(r!.detail).toMatch(/npm rebuild better-sqlite3-multiple-ciphers/);
  });

  test('child wrote {error} → surfaced as fail', () => {
    const r = launchFailure({ status: 2 }, OUT, { stage: 'assert-db-measure', error: 'Failed to decrypt database' }, 100);
    expect(r!.status).toBe('fail');
    expect(r!.detail).toMatch(/Failed to decrypt/);
  });

  test('valid measurement → null (proceed, no failure)', () => {
    const r = launchFailure({ status: 0 }, OUT, { stage: 'assert-db-measure', corpus: 190, filterOff: [], filterOn: [] }, 300);
    expect(r).toBeNull();
  });
});

describe('no-key path (round-4 hang fix) — FAST provisioning error, NEVER spawns/hangs', () => {
  test('assert() with no KEEPR_QA_DB_KEY returns a fast qa:db-key hint (no spawn, no ETIMEDOUT)', async () => {
    const saved = process.env.KEEPR_QA_DB_KEY;
    delete process.env.KEEPR_QA_DB_KEY;
    try {
      const asserter = createDbSetDiffAsserter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx: any = {
        scenarioPath: '/nonexistent/scenario.json',
        repoRoot: '/nonexistent',
        options: { live: true, dryRun: false, skipSeed: true, skipDriver: true, skipExport: true, withUpdate: false },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const expected: any = {
        counts: { corpus: 190, filterOff: 69, filterOn: 37, missing: 0, extra: 0, ghosts: 0 },
        filterOff: [],
        filterOn: [],
      };
      const t0 = Date.now();
      const r = await asserter.assert(ctx, expected);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2000); // no spawn, no 120s (or 25s) hang
      expect(r.status).toBe('fail');
      expect(r.detail).toMatch(/qa:db-key/);
      expect(r.detail).toMatch(/No DB key/i);
    } finally {
      if (saved !== undefined) process.env.KEEPR_QA_DB_KEY = saved;
    }
  });
});
