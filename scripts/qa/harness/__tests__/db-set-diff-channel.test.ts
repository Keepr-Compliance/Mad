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
import { readMeasurement, SENTINEL } from '../db-set-diff-asserter';

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
