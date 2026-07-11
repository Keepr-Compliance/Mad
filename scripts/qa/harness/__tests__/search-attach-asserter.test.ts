/**
 * QA-H6 asserter (BACKLOG-1853): pure evaluators, robust JSON channel, and the
 * skip-clean contract (no key / not live → skipped FAST, never spawns/hangs).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CanonicalEmail, EmailSetMember } from '../types';
import type { ParsedCanonicalList } from '../canonicalList';
import {
  SENTINEL,
  readMeasurement,
  launchFailure,
  evaluateMembers,
  evaluateQueryCell,
  evaluateThreadsCell,
  evaluateLinkedCell,
  evaluateGhostsCell,
  intersectMembers,
  runSearchAttachAssert,
  type MeasuredQuery,
  type Measurement,
  type SearchExpectationBundle,
} from '../search-attach-asserter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(partial: Partial<CanonicalEmail> & { subject: string; shiftedDate: string }): CanonicalEmail {
  return {
    index: partial.index ?? 0,
    emlFile: partial.emlFile ?? `f${partial.index ?? 0}.eml`,
    subject: partial.subject,
    shiftedDate: partial.shiftedDate,
    matchedContacts: partial.matchedContacts ?? '',
    onSubset: partial.onSubset ?? false,
  };
}
function makeParsed(rows: CanonicalEmail[]): ParsedCanonicalList {
  return { emails: rows, filterOff: rows, filterOn: rows.filter((r) => r.onSubset), collisions: [] };
}
function m(subject: string, shiftedDate: string): EmailSetMember {
  return { subject, shiftedDate };
}
function bundleOf(parsed: ParsedCanonicalList): SearchExpectationBundle {
  return { parsed, scenario: {} };
}

// ---------------------------------------------------------------------------
// evaluateMembers
// ---------------------------------------------------------------------------

describe('evaluateMembers', () => {
  test('identical multisets → no deviations', () => {
    const a = [m('X', '2026-01-01'), m('Y', '2026-01-02')];
    expect(evaluateMembers('c', a, [...a])).toHaveLength(0);
  });
  test('mismatch → one deviation with missing + extra', () => {
    const expected = [m('X', '2026-01-01'), m('Y', '2026-01-02')];
    const actual = [m('X', '2026-01-01'), m('Z', '2026-01-03')];
    const dev = evaluateMembers('c', expected, actual);
    expect(dev).toHaveLength(1);
    expect(dev[0].missingMembers).toEqual([m('Y', '2026-01-02')]);
    expect(dev[0].extraMembers).toEqual([m('Z', '2026-01-03')]);
  });
});

describe('intersectMembers', () => {
  test('returns members present in both (whitespace-insensitive key)', () => {
    const a = [m('X ', '2026-01-01'), m('Y', '2026-01-02')];
    const b = [m('X', '2026-01-01')];
    expect(intersectMembers(a, b)).toEqual([m('X ', '2026-01-01')]);
  });
});

// ---------------------------------------------------------------------------
// evaluateQueryCell
// ---------------------------------------------------------------------------

const contactRows = makeParsed([
  row({ index: 1, subject: 'Offer', shiftedDate: '2026-02-08', matchedContacts: 'Cc:amanda,jennifer', onSubset: true }),
  row({ index: 2, subject: 'Re: Offer', shiftedDate: '2026-02-09', matchedContacts: 'From:amanda', onSubset: true }),
  row({ index: 3, subject: 'Unrelated', shiftedDate: '2026-03-01', matchedContacts: 'To:mark.sullivan', onSubset: false }),
]);
const amandaMembers = [m('Offer', '2026-02-08'), m('Re: Offer', '2026-02-09')];

describe('evaluateQueryCell — contact', () => {
  const base: MeasuredQuery = { id: 'contact-amanda', kind: 'contact', query: 'amanda@x.com', role: null, normalized: amandaMembers };

  test('exact match → pass', () => {
    const cell = evaluateQueryCell(base, bundleOf(contactRows));
    expect(cell.status).toBe('pass');
  });
  test('missing a row → fail with deviation', () => {
    const cell = evaluateQueryCell({ ...base, normalized: [amandaMembers[0]] }, bundleOf(contactRows));
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.[0].missingMembers).toEqual([m('Re: Offer', '2026-02-09')]);
  });
  test('whitespace-robustness: normalizedWhitespace must equal normalized', () => {
    const good = evaluateQueryCell({ ...base, normalizedWhitespace: amandaMembers }, bundleOf(contactRows));
    expect(good.status).toBe('pass');
    const bad = evaluateQueryCell({ ...base, normalizedWhitespace: [amandaMembers[0]] }, bundleOf(contactRows));
    expect(bad.status).toBe('fail');
    expect(bad.deviations?.some((d) => String(d.cell).includes('whitespace-robust'))).toBe(true);
  });
});

describe('evaluateQueryCell — subject + freetext', () => {
  test('subject exact', () => {
    const cell = evaluateQueryCell(
      { id: 'subj', kind: 'subject', query: 'Offer', role: null, normalized: amandaMembers },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('pass'); // both subjects contain "offer"
  });
  test('freetext passes when it CONTAINS the subject lower-bound (superset ok)', () => {
    const cell = evaluateQueryCell(
      { id: 'ft', kind: 'freetext', query: 'offer', role: null, normalized: [...amandaMembers, m('Body-only hit', '2026-02-10')] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('pass');
  });
  test('freetext FAILS when a subject-confined row is missing (below lower bound)', () => {
    const cell = evaluateQueryCell(
      { id: 'ft', kind: 'freetext', query: 'offer', role: null, normalized: [amandaMembers[0]] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.[0].cell).toMatch(/subject-lower-bound/);
  });
});

describe('evaluateQueryCell — bcc non-leak invariant', () => {
  const bccMember = m('Wire Instructions', '2026-02-10');
  test('bcc-only email NOT leaked to free-text → pass', () => {
    const cell = evaluateQueryCell(
      { id: 'bcc', kind: 'bcc', query: 'amanda@x.com', role: null, normalized: [bccMember], nonBccRoles: [], freetext: [] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('pass');
  });
  test('bcc-only email leaking into free-text → fail', () => {
    const cell = evaluateQueryCell(
      { id: 'bcc', kind: 'bcc', query: 'amanda@x.com', role: null, normalized: [bccMember], nonBccRoles: [], freetext: [bccMember] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.[0].cell).toMatch(/bcc-non-leak/);
  });
  test('an email reachable as From too is NOT bcc-only (not a leak)', () => {
    const cell = evaluateQueryCell(
      { id: 'bcc', kind: 'bcc', query: 'amanda@x.com', role: null, normalized: [bccMember], nonBccRoles: [bccMember], freetext: [bccMember] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('pass');
  });
  test('no bcc participant → info (vacuous)', () => {
    const cell = evaluateQueryCell(
      { id: 'bcc', kind: 'bcc', query: 'amanda@x.com', role: null, normalized: [] },
      bundleOf(contactRows),
    );
    expect(cell.status).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// thread / linked / ghost cells
// ---------------------------------------------------------------------------

const chainRows = makeParsed([
  row({ index: 1, subject: 'Appraisal Update', shiftedDate: '2026-03-11' }),
  row({ index: 2, subject: 'Re: Appraisal Update', shiftedDate: '2026-03-12' }),
]);

describe('evaluateThreadsCell', () => {
  const memberA = m('Appraisal Update', '2026-03-11');
  const memberB = m('Re: Appraisal Update', '2026-03-12');
  test('a reply chain in ONE thread → pass', () => {
    const meas: Measurement = { threads: { threadCount: 1, groups: { T: [memberA, memberB] } } };
    expect(evaluateThreadsCell(meas, bundleOf(chainRows)).status).toBe('pass');
  });
  test('a reply chain split across two threads → fail', () => {
    const meas: Measurement = { threads: { threadCount: 2, groups: { T1: [memberA], T2: [memberB] } } };
    const cell = evaluateThreadsCell(meas, bundleOf(chainRows));
    expect(cell.status).toBe('fail');
  });
});

describe('evaluateLinkedCell', () => {
  test('no dangling whole-thread links → pass', () => {
    const meas: Measurement = {
      linked: { transactionId: 'tx', directCount: 69, threadRowCount: 1, effectiveCount: 72, threadExpansions: [{ threadId: 'T', members: [m('a', '2026-01-01')] }] },
    };
    expect(evaluateLinkedCell(meas).status).toBe('pass');
  });
  test('a whole-thread link expanding to 0 members → fail', () => {
    const meas: Measurement = {
      linked: { transactionId: 'tx', directCount: 0, threadRowCount: 1, effectiveCount: 0, threadExpansions: [{ threadId: 'T', members: [] }] },
    };
    expect(evaluateLinkedCell(meas).status).toBe('fail');
  });
  test('no transaction resolved → info', () => {
    expect(evaluateLinkedCell({ linked: { transactionId: null } }).status).toBe('info');
  });
});

describe('evaluateGhostsCell (BACKLOG-1764)', () => {
  test('0 resurrections → pass', () => {
    expect(evaluateGhostsCell({ ghosts: { tombstoneCount: 3, resurrections: [] } }).status).toBe('pass');
  });
  test('a resurrection → fail with the ghost member', () => {
    const cell = evaluateGhostsCell({ ghosts: { tombstoneCount: 1, resurrections: [m('ghost', '2026-01-01')] } });
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.[0].extraMembers).toEqual([m('ghost', '2026-01-01')]);
  });
});

// ---------------------------------------------------------------------------
// Robust JSON channel + launch failure (mirrors H3)
// ---------------------------------------------------------------------------

describe('readMeasurement', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qa-sa-chan-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const measurement = { stage: 'search-attach-measure', corpus: 190, queries: [] };

  test('reads from the --out file (primary channel)', () => {
    const out = join(dir, 'm.json');
    writeFileSync(out, JSON.stringify(measurement));
    expect(readMeasurement(out, 'noise')).toMatchObject({ stage: 'search-attach-measure', corpus: 190 });
  });
  test('falls back to the sentinel stdout line', () => {
    const stdout = ['electron noise', SENTINEL + JSON.stringify(measurement), 'trailing'].join('\n');
    expect(readMeasurement(join(dir, 'missing.json'), stdout)).toMatchObject({ corpus: 190 });
  });
  test('null when neither present', () => {
    expect(readMeasurement(join(dir, 'nope.json'), 'no json')).toBeNull();
  });
});

describe('launchFailure', () => {
  const OUT = '/tmp/x.json';
  test('ETIMEDOUT → actionable', () => {
    const r = launchFailure({ error: { code: 'ETIMEDOUT', message: '…' } }, OUT, null, 25_000);
    expect(r!.status).toBe('fail');
    expect(r!.detail).toMatch(/timed out/i);
  });
  test('no measurement → ABI hint', () => {
    expect(launchFailure({ status: 1 }, OUT, null, 100)!.detail).toMatch(/npm rebuild better-sqlite3-multiple-ciphers/);
  });
  test('child {error} surfaced', () => {
    const r = launchFailure({ status: 2 }, OUT, { stage: 'search-attach-measure', error: 'Failed to decrypt database' }, 100);
    expect(r!.detail).toMatch(/Failed to decrypt/);
  });
  test('valid measurement → null (proceed)', () => {
    expect(launchFailure({ status: 0 }, OUT, { stage: 'search-attach-measure', corpus: 190 }, 100)).toBeNull();
  });
});

describe('runSearchAttachAssert — skip-clean contract (never spawns/hangs)', () => {
  const ctxBase = { scenarioPath: '/nonexistent/s.json', repoRoot: '/nonexistent' };
  const bundle = bundleOf(makeParsed([row({ subject: 'x', shiftedDate: '2026-01-01' })]));

  test('not live → skipped (no spawn)', () => {
    const r = runSearchAttachAssert({ ...ctxBase, live: false }, bundle);
    expect(r.status).toBe('skipped');
  });
  test('live but no KEEPR_QA_DB_KEY → skipped FAST (<2s), actionable hint, no spawn', () => {
    const saved = process.env.KEEPR_QA_DB_KEY;
    delete process.env.KEEPR_QA_DB_KEY;
    try {
      const t0 = Date.now();
      const r = runSearchAttachAssert({ ...ctxBase, live: true }, bundle);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.status).toBe('skipped');
      expect(r.detail).toMatch(/qa:db-key|No DB key/i);
    } finally {
      if (saved !== undefined) process.env.KEEPR_QA_DB_KEY = saved;
    }
  });
});
