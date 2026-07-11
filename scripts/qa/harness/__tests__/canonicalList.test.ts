import { resolve } from 'path';
import {
  parseCanonicalList,
  loadCanonicalList,
  toExpectedSets,
} from '../canonicalList';
import { loadScenario } from '../manifest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CANONICAL_MD = resolve(REPO_ROOT, 'docs/qa/tx1-canonical-list-v2.20.0.md');
const SCENARIO = resolve(REPO_ROOT, 'docs/qa/scenarios/tx1-birchwood.json');

describe('parseCanonicalList — committed TX1 checklist', () => {
  const parsed = loadCanonicalList(CANONICAL_MD);

  it('derives EXACTLY 69 filter-OFF rows', () => {
    expect(parsed.filterOff).toHaveLength(69);
    expect(parsed.emails).toHaveLength(69);
  });

  it('derives EXACTLY 37 filter-ON rows', () => {
    expect(parsed.filterOn).toHaveLength(37);
    expect(parsed.filterOn.every((e) => e.onSubset)).toBe(true);
  });

  it('unescapes markdown-escaped pipes in subjects', () => {
    const withPipe = parsed.emails.filter((e) => e.subject.includes('|'));
    expect(withPipe.length).toBeGreaterThan(0);
    // No subject should retain a literal backslash-escape.
    expect(parsed.emails.every((e) => !e.subject.includes('\\|'))).toBe(true);
    // The known CT-28451 escrow row keeps its pipe segment.
    expect(
      parsed.emails.some((e) => e.subject.includes('| File: CT-28451')),
    ).toBe(true);
  });

  it('parses ISO shifted dates for every row', () => {
    expect(
      parsed.emails.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.shiftedDate)),
    ).toBe(true);
  });

  it('preserves legitimate (subject, shifted-date) collisions as a multiset', () => {
    // Rows 20/21 are DISTINCT emails that share subject + shifted-date
    // (2026-02-14). They must both survive, or the exact count under-counts.
    expect(parsed.collisions.length).toBeGreaterThanOrEqual(1);
    const pair = parsed.collisions.find((bucket) =>
      bucket.every(
        (e) =>
          e.shiftedDate === '2026-02-14' &&
          e.subject.includes('Inspection Results'),
      ),
    );
    expect(pair).toBeDefined();
    expect(pair).toHaveLength(2);
    expect(pair!.map((e) => e.emlFile).sort()).toEqual([
      'TX1_27_2025-02-14_sarah_inspection-response-strategy.eml',
      'TX1_28_2025-02-14_david_go-ahead.eml',
    ]);
    // Both rows still counted -> total stays 69.
    expect(parsed.emails).toHaveLength(69);
  });
});

describe('parseCanonicalList — malformed input guards', () => {
  it('throws on a non-ISO date', () => {
    const md = '| 1 | a.eml | Subject | 02-07-2026 | To:x | no | FOUND |';
    expect(() => parseCanonicalList(md)).toThrow(/non-ISO/);
  });

  it('throws on an unrecognized ON-subset value', () => {
    const md = '| 1 | a.eml | Subject | 2026-02-07 | To:x | maybe | FOUND |';
    expect(() => parseCanonicalList(md)).toThrow(/ON-subset/);
  });

  it('allows legitimate duplicate (subject, shifted-date) as a multiset', () => {
    const md = [
      '| 1 | a.eml | Same | 2026-02-07 | To:x | no | FOUND |',
      '| 2 | b.eml | Same | 2026-02-07 | To:y | no | FOUND |',
    ].join('\n');
    const parsed = parseCanonicalList(md);
    expect(parsed.emails).toHaveLength(2);
    expect(parsed.collisions).toHaveLength(1);
    expect(parsed.collisions[0]).toHaveLength(2);
  });

  it('throws when no data rows are present', () => {
    expect(() => parseCanonicalList('# Heading\n\nno table here')).toThrow(
      /no data rows/,
    );
  });
});

describe('toExpectedSets — scenario/checklist drift guard', () => {
  it('agrees with the committed tx1-birchwood scenario counts', () => {
    const { scenario, canonicalListPath } = loadScenario(SCENARIO);
    const parsed = loadCanonicalList(canonicalListPath);
    const expected = toExpectedSets(parsed, scenario.expectedCounts);
    expect(expected.counts).toEqual({
      corpus: 190,
      filterOff: 69,
      filterOn: 37,
      missing: 0,
      extra: 0,
      ghosts: 0,
    });
    expect(expected.filterOff).toHaveLength(69);
    expect(expected.filterOn).toHaveLength(37);
  });

  it('throws when checklist rows disagree with manifest counts', () => {
    const parsed = parseCanonicalList(
      '| 1 | a.eml | Only | 2026-02-07 | To:x | yes | FOUND |',
    );
    expect(() =>
      toExpectedSets(parsed, {
        corpus: 190,
        filterOff: 69,
        filterOn: 37,
        missing: 0,
        extra: 0,
        ghosts: 0,
      }),
    ).toThrow(/drifted/);
  });
});
