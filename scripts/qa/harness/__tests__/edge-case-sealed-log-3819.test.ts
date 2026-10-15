/**
 * BACKLOG-3819 — the QA harness never scans an encrypted desktop log as if it
 * were text (0 leaks / 0 markers from ciphertext is a meaningless green). It
 * skips a sealed file and uses the next configured path (e.g. a saved
 * diagnostic log) or the fixture.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLogText, isSealedLogBuffer, type EdgeExpectationBundle } from '../edge-case-asserter';

describe('BACKLOG-3819 harness and sealed logs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepr-harness-3819-'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const bundle = (logPaths: string[]): EdgeExpectationBundle => ({
    scenarioPath: path.join(dir, 'scenario.json'),
    scenario: { edgeCases: { logScan: { logPaths } } },
  });

  it('skips a sealed main.log and reads the saved diagnostic log listed after it', () => {
    const sealed = path.join(dir, 'main.log');
    fs.writeFileSync(sealed, Buffer.concat([Buffer.from('KEPRLOG'), Buffer.alloc(41), Buffer.from('ciphertext')]));
    const saved = path.join(dir, 'keepr-diagnostic-log.txt');
    fs.writeFileSync(saved, '[2026-10-08 10:00:00.000] [info] readable\n');
    const r = resolveLogText(bundle([sealed, saved]), 'real-log');
    expect(r.source).toBe('real-log');
    expect(r.path).toBe(saved);
    expect(r.text).toContain('readable');
  });

  it('a sealed file alone resolves to no log (gated), never to its bytes', () => {
    const sealed = path.join(dir, 'main.log');
    fs.writeFileSync(sealed, Buffer.concat([Buffer.from('KEPRLOG'), Buffer.alloc(41)]));
    expect(isSealedLogBuffer(fs.readFileSync(sealed))).toBe(true);
    expect(resolveLogText(bundle([sealed]), 'real-log').source).toBe('none');
  });
});
