import { resolve } from 'path';
import { readFileSync } from 'fs';
import { parseScenario, expandPath, loadScenario } from '../manifest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCENARIO = resolve(REPO_ROOT, 'docs/qa/scenarios/tx1-birchwood.json');

describe('parseScenario', () => {
  it('validates the committed tx1-birchwood scenario', () => {
    const json = readFileSync(SCENARIO, 'utf-8');
    const scenario = parseScenario(json, SCENARIO);
    expect(scenario.id).toBe('tx1-birchwood');
    expect(scenario.source).toBe('outlook');
    expect(scenario.contacts).toHaveLength(9);
    expect(scenario.setIdentity).toBe('subject+shifted-date');
    expect(scenario.expectedCounts.filterOff).toBe(69);
  });

  it('rejects a wrong setIdentity (guards the load-bearing rule)', () => {
    const bad = JSON.stringify({
      id: 'x',
      version: 'v1',
      description: '',
      source: 'outlook',
      transaction: { label: 'l', address: 'a', normalizedTokens: ['t'] },
      auditWindow: { start: '2026-02-05', end: '2026-04-14' },
      contacts: ['a@b.com'],
      ownAddressExcluded: 'me@x.com',
      dateShiftMonths: 12,
      expectedCounts: {
        corpus: 1,
        filterOff: 1,
        filterOn: 0,
        missing: 0,
        extra: 0,
        ghosts: 0,
      },
      expectedManifestRef: './x.md',
      setIdentity: 'message-id',
    });
    expect(() => parseScenario(bad, 'inline')).toThrow(/setIdentity/);
  });

  it('rejects malformed JSON with a readable error', () => {
    expect(() => parseScenario('{ not json', 'inline')).toThrow(/not valid JSON/);
  });

  it('rejects a non-ISO audit window date', () => {
    const bad = JSON.stringify({
      id: 'x',
      version: 'v1',
      description: '',
      source: 'gmail',
      transaction: { label: 'l', address: 'a', normalizedTokens: ['t'] },
      auditWindow: { start: '02/05/2026', end: '2026-04-14' },
      contacts: ['a@b.com'],
      ownAddressExcluded: 'me@x.com',
      dateShiftMonths: 12,
      expectedCounts: {
        corpus: 1,
        filterOff: 1,
        filterOn: 0,
        missing: 0,
        extra: 0,
        ghosts: 0,
      },
      expectedManifestRef: './x.md',
      setIdentity: 'subject+shifted-date',
    });
    expect(() => parseScenario(bad, 'inline')).toThrow(/auditWindow/);
  });
});

describe('expandPath', () => {
  it('expands a leading ~ to the home dir', () => {
    const out = expandPath('~/foo');
    expect(out.startsWith('~')).toBe(false);
    expect(out.endsWith('/foo')).toBe(true);
  });

  it('expands env references', () => {
    process.env.QA_HARNESS_TEST_VAR = '/tmp/qa';
    expect(expandPath('${QA_HARNESS_TEST_VAR}/x')).toBe('/tmp/qa/x');
    delete process.env.QA_HARNESS_TEST_VAR;
  });

  it('leaves plain relative paths untouched', () => {
    expect(expandPath('docs/qa/x.md')).toBe('docs/qa/x.md');
  });
});

describe('loadScenario', () => {
  it('resolves the canonical checklist path relative to the manifest', () => {
    const { canonicalListPath } = loadScenario(SCENARIO);
    expect(canonicalListPath.endsWith('docs/qa/tx1-canonical-list-v2.20.0.md')).toBe(
      true,
    );
  });
});
