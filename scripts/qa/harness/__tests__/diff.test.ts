import { diffMembers, evaluateSetDiff, memberKey } from '../diff';
import type { CanonicalEmail, EmailSetMember, ExpectedSets } from '../types';

function member(subject: string, shiftedDate: string): EmailSetMember {
  return { subject, shiftedDate };
}

function canonical(
  subject: string,
  shiftedDate: string,
  onSubset = false,
): CanonicalEmail {
  return { index: 0, emlFile: 'x.eml', matchedContacts: '', subject, shiftedDate, onSubset };
}

describe('memberKey', () => {
  it('collapses cosmetic whitespace but keeps date', () => {
    expect(memberKey(member('  Hello   world ', '2026-02-07'))).toBe(
      'Hello world 2026-02-07',
    );
  });

  it('treats same subject on different dates as distinct', () => {
    expect(memberKey(member('Re: Offer', '2026-02-08'))).not.toBe(
      memberKey(member('Re: Offer', '2026-02-09')),
    );
  });
});

describe('diffMembers', () => {
  it('finds missing and extra by (subject, shifted-date)', () => {
    const expected = [member('A', '2026-01-01'), member('B', '2026-01-02')];
    const actual = [member('B', '2026-01-02'), member('C', '2026-01-03')];
    const { missing, extra } = diffMembers(expected, actual);
    expect(missing.map((m) => m.subject)).toEqual(['A']);
    expect(extra.map((m) => m.subject)).toEqual(['C']);
  });

  it('reports no diff for identical sets in any order', () => {
    const expected = [member('A', '2026-01-01'), member('B', '2026-01-02')];
    const actual = [member('B', '2026-01-02'), member('A', '2026-01-01')];
    const { missing, extra } = diffMembers(expected, actual);
    expect(missing).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });

  it('uses MULTISET semantics for colliding (subject, shifted-date) keys', () => {
    // Two distinct emails share one key. Both expected; only one present.
    const expected = [member('Dup', '2026-02-14'), member('Dup', '2026-02-14')];
    const actual = [member('Dup', '2026-02-14')];
    const { missing, extra } = diffMembers(expected, actual);
    expect(missing).toHaveLength(1); // one copy still missing
    expect(extra).toHaveLength(0);
  });

  it('matches a fully-present colliding pair with no diff', () => {
    const expected = [member('Dup', '2026-02-14'), member('Dup', '2026-02-14')];
    const actual = [member('Dup', '2026-02-14'), member('Dup', '2026-02-14')];
    const { missing, extra } = diffMembers(expected, actual);
    expect(missing).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });
});

describe('evaluateSetDiff', () => {
  const expected: ExpectedSets = {
    counts: { corpus: 3, filterOff: 2, filterOn: 1, missing: 0, extra: 0, ghosts: 0 },
    filterOff: [canonical('A', '2026-01-01', true), canonical('B', '2026-01-02')],
    filterOn: [canonical('A', '2026-01-01', true)],
  };

  it('returns zero deviations when every gate holds', () => {
    const deviations = evaluateSetDiff(expected, {
      corpus: 3,
      filterOff: [member('A', '2026-01-01'), member('B', '2026-01-02')],
      filterOn: [member('A', '2026-01-01')],
      ghosts: [],
    });
    expect(deviations).toEqual([]);
  });

  it('flags a filter-OFF count + membership deviation', () => {
    const deviations = evaluateSetDiff(expected, {
      corpus: 3,
      filterOff: [member('A', '2026-01-01'), member('Z', '2026-01-09')],
      filterOn: [member('A', '2026-01-01')],
      ghosts: [],
    });
    // filterOff count matches (2) but membership differs -> missing B, extra Z
    // -> surfaces via the `missing`/`extra` cells.
    const cells = deviations.map((d) => d.cell);
    expect(cells).toEqual(expect.arrayContaining(['missing', 'extra']));
    const missing = deviations.find((d) => d.cell === 'missing');
    expect(missing?.missingMembers?.map((m) => m.subject)).toEqual(['B']);
  });

  it('flags a corpus total deviation', () => {
    const deviations = evaluateSetDiff(expected, {
      corpus: 190,
      filterOff: [canonical('A', '2026-01-01'), canonical('B', '2026-01-02')],
      filterOn: [canonical('A', '2026-01-01')],
      ghosts: [],
    });
    const corpus = deviations.find((d) => d.cell === 'corpus');
    expect(corpus).toMatchObject({ expected: 3, got: 190 });
  });

  it('flags ghosts', () => {
    const deviations = evaluateSetDiff(expected, {
      corpus: 3,
      filterOff: [member('A', '2026-01-01'), member('B', '2026-01-02')],
      filterOn: [member('A', '2026-01-01')],
      ghosts: [member('GHOST', '2026-01-05')],
    });
    const ghosts = deviations.find((d) => d.cell === 'ghosts');
    expect(ghosts).toMatchObject({ expected: 0, got: 1 });
  });
});
