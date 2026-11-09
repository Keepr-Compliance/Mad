/**
 * BACKLOG-4186 PR B — the client validator against the SQL validator (control A7) and threshold
 * input (control A14, library half).
 *
 * Corpus: supabase/tests/backlog-4175/corpus.json, 282 cases; `sql` is the SQL validator's answer
 * recorded by the 4175 keepr-test harness. corpus-sql-reasons.json is the SQL validator's REASON
 * for every case, captured 2026-11-09 by supabase/tests/backlog-4186/capture-corpus-reasons.py
 * (kt-sql on keepr-test, public._sender_rule_set_invalid over the same corpus).
 */
import fs from 'fs';
import path from 'path';

import {
  invalidReason,
  isAddress,
  isHost,
  isLocalPart,
  isPrecedence,
  parseThresholdInput,
  setThreshold,
} from '@/lib/sender-rules/validate';

import { bundled, clone, loadCorpus } from './helpers';

const corpus = loadCorpus();
const sqlReasons = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'corpus-sql-reasons.json'), 'utf8'),
) as { name: string; reason: string | null }[];

describe('A7: invalidReason agrees with the SQL validator on the 4175 corpus', () => {
  it('reads the whole corpus (282 cases, 4 where Zod and SQL disagree)', () => {
    expect(corpus).toHaveLength(282);
    expect(corpus.filter((c) => c.zod !== c.sql)).toHaveLength(4);
    expect(sqlReasons).toHaveLength(282);
    expect(sqlReasons.map((r) => r.name)).toEqual(corpus.map((c) => c.name));
  });

  it.each(corpus.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(invalidReason(c.content) === null).toBe(c.sql);
  });

  it('gives the SQL reason, word for word, for every case', () => {
    const differ = corpus
      .map((c, i) => ({ name: c.name, got: invalidReason(c.content), want: sqlReasons[i].reason }))
      .filter((x) => x.got !== x.want);
    expect(differ).toEqual([]);
  });
});

describe('predicates', () => {
  it('isHost', () => {
    expect(isHost('example.com')).toBe(true);
    expect(isHost('a-b.example.co')).toBe(true);
    expect(isHost('example')).toBe(false);
    expect(isHost('Example.com')).toBe(false);
    expect(isHost('example.com.')).toBe(false);
    expect(isHost('x'.repeat(250) + '.co')).toBe(true); // 253 characters: the cap
    expect(isHost('x'.repeat(251) + '.co')).toBe(false); // 254
  });

  it('isAddress / isLocalPart / isPrecedence refuse non-ASCII, spaces and capitals', () => {
    expect(isAddress('news@example.com')).toBe(true);
    expect(isAddress('néws@example.com')).toBe(false);
    expect(isAddress('News@example.com')).toBe(false);
    expect(isAddress('news@example')).toBe(false);
    expect(isLocalPart('noreply')).toBe(true);
    expect(isLocalPart('no reply')).toBe(false);
    expect(isLocalPart('a@b')).toBe(false);
    expect(isLocalPart('')).toBe(false);
    expect(isPrecedence('bulk')).toBe(true);
    expect(isPrecedence('bulk list')).toBe(false);
    expect(isPrecedence('Bulk')).toBe(false);
  });
});

describe('A14: thresholds are numbers', () => {
  it('the validator refuses a threshold sent as a string (as the server does)', () => {
    const c = clone(bundled()) as unknown as { thresholds: Record<string, unknown> };
    c.thresholds.minCensusLinkedEmails = '20';
    expect(invalidReason(c)).toBe('thresholds.minCensusLinkedEmails: not an integer >= 0');
  });

  it('setThreshold stores the parsed number, never the input string', () => {
    const r = setThreshold(bundled(), 'minCensusLinkedEmails', ' 25 ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.thresholds.minCensusLinkedEmails).toBe(25);
    expect(typeof r.content.thresholds.minCensusLinkedEmails).toBe('number');
    expect(invalidReason(r.content)).toBeNull();
  });

  it.each([
    ['minCensusLinkedEmails', '1.5'],
    ['minCensusLinkedEmails', '-1'],
    ['minCensusLinkedEmails', ''],
    ['minCensusLinkedEmails', '1e3'],
    ['reportSendIntervalHours', '0'],
    ['reportMaxRows', '501'],
    ['reportMaxRows', '0'],
  ] as const)('refuses %s = %j', (key, input) => {
    expect(parseThresholdInput(key, input).ok).toBe(false);
    expect(setThreshold(bundled(), key, input).ok).toBe(false);
  });

  it.each([
    ['minCensusLinkedEmails', '0', 0],
    ['reportSendIntervalHours', '1', 1],
    ['reportMaxRows', '500', 500],
  ] as const)('accepts %s = %j at the boundary', (key, input, want) => {
    expect(parseThresholdInput(key, input)).toEqual({ ok: true, value: want });
  });
});
