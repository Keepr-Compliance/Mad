'use strict';
/**
 * Unit tests for the QA-H3 DB set-diff CORE logic (BACKLOG-1850).
 *
 * Pure logic only — no Electron, no native module, no keychain. Runs under the
 * local (non-CI) jest glob (`**\/__tests__/**`). NOTE: the repo's CI jest glob
 * only selects src/** and electron/**, so these do not run in CI; H1's harness
 * scaffolding should widen the CI test glob to scripts/qa (flagged in the PR).
 */
const fs = require('fs');
const path = require('path');
const core = require('../db-set-diff-core');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const REAL_MANIFEST = path.join(REPO_ROOT, 'docs', 'qa', 'tx1-canonical-list.md');

describe('shiftedDateOf', () => {
  test('extracts YYYY-MM-DD from ISO-T and space forms', () => {
    expect(core.shiftedDateOf('2026-02-07T18:30:00.000Z')).toBe('2026-02-07');
    expect(core.shiftedDateOf('2026-02-07 18:30:00')).toBe('2026-02-07');
  });
  test('handles the +1-day UTC row by trusting the stored value', () => {
    // A corpus Date of 2026-02-07 16:xx -0800 lands 2026-02-08 in UTC.
    expect(core.shiftedDateOf('2026-02-08T00:30:00.000Z')).toBe('2026-02-08');
  });
  test('null/short inputs', () => {
    expect(core.shiftedDateOf(null)).toBe('');
    expect(core.shiftedDateOf(undefined)).toBe('');
    expect(core.shiftedDateOf('2026')).toBe('2026');
  });
});

describe('memberKey', () => {
  test('trims subject and is distinct across subject/date', () => {
    expect(core.memberKey('  Hi  ', '2026-01-01')).toBe(core.memberKey('Hi', '2026-01-01'));
    expect(core.memberKey('Hi', '2026-01-01')).not.toBe(core.memberKey('Hi', '2026-01-02'));
    expect(core.memberKey('Hi', '2026-01-01')).not.toBe(core.memberKey('Ho', '2026-01-01'));
  });
  test('subjects containing a pipe do not collide', () => {
    const a = core.memberKey('Escrow | File: CT-28451', '2026-02-10');
    const b = core.memberKey('Escrow ', '| File: CT-28451 2026-02-10');
    expect(a).not.toBe(b);
  });
});

describe('parseCanonicalManifest', () => {
  const md = [
    '## Checklist',
    '',
    '| # | .eml file | Subject | Shifted date | Matched contact(s) & role | ON-subset | DB |',
    '|---|-----------|---------|--------------|---------------------------|-----------|----|',
    '| 1 | a.eml | Plain subject | 2026-01-05 | To:mark | no | FOUND |',
    '| 2 | b.eml | 742 Birchwood Lane NE offer | 2026-02-08 | From:jennifer | YES | FOUND |',
    '| 3 | c.eml | Escrow Opened \\| File: CT-28451 | 2026-02-10 | From:rachel | YES | FOUND |',
    '',
    'trailing prose, not a row',
  ].join('\n');

  test('parses rows, unescapes pipes, extracts ON-subset', () => {
    const parsed = core.parseCanonicalManifest(md);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.filterOff).toHaveLength(3);
    expect(parsed.filterOn).toHaveLength(2);
    // escaped pipe restored to a literal pipe
    expect(parsed.rows[2].subject).toBe('Escrow Opened | File: CT-28451');
    expect(parsed.rows[2].shiftedDate).toBe('2026-02-10');
    expect(parsed.rows[0].onSubset).toBe(false);
    expect(parsed.rows[1].onSubset).toBe(true);
  });

  test('ignores the header and separator rows', () => {
    const parsed = core.parseCanonicalManifest(md);
    expect(parsed.rows.every((r) => Number.isFinite(r.index))).toBe(true);
    expect(parsed.rows.map((r) => r.index)).toEqual([1, 2, 3]);
  });
});

describe('buildDerivedQuery (replays autoLinkService junction SQL)', () => {
  const contacts = ['A@X.com', 'b@y.com'];

  test('filter-OFF: no LIKE clauses, lowercased contact params', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts });
    expect(sql).toContain('FROM email_participants ep');
    expect(sql).toContain('JOIN emails e ON e.id = ep.email_id');
    expect(sql).toContain('ep.email_address IN (?, ?)');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual(['a@x.com', 'b@y.com']);
  });

  test('filter-ON: one LIKE per token, exact app expression + %token% params', () => {
    const { sql, params } = core.buildDerivedQuery({
      contacts,
      tokens: ['742', 'birchwood', 'lane', 'ne'],
    });
    // Exact mirror of autoLinkService.ts
    expect(sql).toContain("LOWER(e.subject || ' ' || COALESCE(e.body_plain, '')) LIKE ?");
    expect((sql.match(/LIKE \?/g) || [])).toHaveLength(4);
    expect(params).toEqual(['a@x.com', 'b@y.com', '%742%', '%birchwood%', '%lane%', '%ne%']);
  });

  test('userId adds an e.user_id clause in the right param order', () => {
    const { sql, params } = core.buildDerivedQuery({ contacts, userId: 'u-1', tokens: ['x'] });
    expect(sql).toContain('AND e.user_id = ?');
    expect(params).toEqual(['a@x.com', 'b@y.com', 'u-1', '%x%']);
  });

  test('throws when no contacts', () => {
    expect(() => core.buildDerivedQuery({ contacts: [] })).toThrow(/at least one contact/);
  });
});

describe('diffMembers', () => {
  const canonical = [
    { subject: 'A', shiftedDate: '2026-01-01' },
    { subject: 'B', shiftedDate: '2026-02-08' },
    { subject: 'C', shiftedDate: '2026-02-08' }, // +1-day sibling, same subject-distinct
  ];

  test('identical sets → 0 missing, 0 extra', () => {
    const { missing, extra } = core.diffMembers(canonical, canonical);
    expect(missing).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });

  test('reports missing (expected-not-actual) and extra (actual-not-expected)', () => {
    const actual = [
      { subject: 'A', shiftedDate: '2026-01-01' },
      { subject: 'B', shiftedDate: '2026-02-08' },
      { subject: 'Z', shiftedDate: '2026-03-01' }, // extra
    ];
    const { missing, extra } = core.diffMembers(actual, canonical);
    expect(missing).toEqual([{ subject: 'C', shiftedDate: '2026-02-08' }]);
    expect(extra).toEqual([{ subject: 'Z', shiftedDate: '2026-03-01' }]);
  });

  test('matches the +1-day row by exact stored date, not by tolerance', () => {
    // Same subject, date off by one → treated as different members (a finding).
    const actual = [{ subject: 'B', shiftedDate: '2026-02-09' }];
    const expected = [{ subject: 'B', shiftedDate: '2026-02-08' }];
    const { missing, extra } = core.diffMembers(actual, expected);
    expect(missing).toHaveLength(1);
    expect(extra).toHaveLength(1);
  });
});

describe('findGhosts / canonicalDateSpan', () => {
  const linked = [
    { subject: 'in', shiftedDate: '2026-02-08' },
    { subject: 'early ghost', shiftedDate: '2025-12-31' },
    { subject: 'late ghost', shiftedDate: '2026-05-01' },
    { subject: 'no date', shiftedDate: '' },
  ];
  test('flags out-of-window and missing-date rows', () => {
    const ghosts = core.findGhosts(linked, { start: '2026-01-01', end: '2026-04-14' });
    const subjects = ghosts.map((g) => g.subject).sort();
    expect(subjects).toEqual(['early ghost', 'late ghost', 'no date']);
  });
  test('empty when all in-window', () => {
    const ghosts = core.findGhosts(
      [{ subject: 'x', shiftedDate: '2026-02-01' }],
      { start: '2026-01-01', end: '2026-04-14' },
    );
    expect(ghosts).toHaveLength(0);
  });
  test('canonicalDateSpan returns inclusive [min,max]', () => {
    const span = core.canonicalDateSpan([
      { shiftedDate: '2026-02-08' },
      { shiftedDate: '2026-01-05' },
      { shiftedDate: '2026-04-14' },
    ]);
    expect(span).toEqual({ start: '2026-01-05', end: '2026-04-14' });
  });
});

describe('findNonAutoLinks', () => {
  test('flags manual/scan links, passes auto', () => {
    const rows = [
      { subject: 'a', shiftedDate: '2026-02-08', link_source: 'auto' },
      { subject: 'b', shiftedDate: '2026-02-09', link_source: 'manual' },
      { subject: 'c', shiftedDate: '2026-02-10', link_source: 'scan' },
    ];
    const bad = core.findNonAutoLinks(rows);
    expect(bad.map((b) => b.subject).sort()).toEqual(['b', 'c']);
  });
});

describe('evaluate', () => {
  const canonical = {
    filterOff: [
      { subject: 'A', shiftedDate: '2026-01-01' },
      { subject: 'B', shiftedDate: '2026-02-08' },
    ],
    filterOn: [{ subject: 'B', shiftedDate: '2026-02-08' }],
  };
  const expectedCounts = { corpus: 190, filterOff: 2, filterOn: 1, missing: 0, extra: 0, ghosts: 0 };

  test('happy path: exact counts → pass with 0/0/0', () => {
    const result = core.evaluate({
      expectedCounts,
      canonical,
      actual: {
        corpus: 190,
        filterOff: canonical.filterOff,
        filterOn: canonical.filterOn,
        linked: canonical.filterOff.map((m) => ({ ...m, link_source: 'auto' })),
        ghosts: [],
      },
    });
    expect(result.passed).toBe(true);
    expect(result.deviations).toHaveLength(0);
    expect(result.summary).toMatchObject({ filterOff: 2, filterOn: 1, missing: 0, extra: 0, ghosts: 0 });
  });

  test('a missing row surfaces missingMembers + fails', () => {
    const result = core.evaluate({
      expectedCounts,
      canonical,
      actual: {
        corpus: 190,
        filterOff: [{ subject: 'A', shiftedDate: '2026-01-01' }], // B missing
        filterOn: canonical.filterOn,
        linked: null,
        ghosts: [],
      },
    });
    expect(result.passed).toBe(false);
    const cells = result.deviations.map((d) => d.cell);
    expect(cells).toContain('filterOff'); // count 1 !== 2
    expect(cells).toContain('missing');
    const miss = result.deviations.find((d) => d.cell === 'missing');
    expect(miss.missingMembers).toEqual([{ subject: 'B', shiftedDate: '2026-02-08' }]);
  });

  test('wrong corpus, non-auto link, and ghost each produce a deviation', () => {
    const result = core.evaluate({
      expectedCounts,
      canonical,
      actual: {
        corpus: 189,
        filterOff: canonical.filterOff,
        filterOn: canonical.filterOn,
        linked: [
          { subject: 'A', shiftedDate: '2026-01-01', link_source: 'auto' },
          { subject: 'B', shiftedDate: '2026-02-08', link_source: 'manual' },
        ],
        ghosts: [{ subject: 'ghost', shiftedDate: '2025-01-01' }],
      },
    });
    const cells = result.deviations.map((d) => d.cell);
    expect(cells).toEqual(expect.arrayContaining(['corpus', 'link_source', 'ghosts']));
    expect(result.passed).toBe(false);
  });

  test('linked=null skips the link_source check (independent of a transaction)', () => {
    const result = core.evaluate({
      expectedCounts,
      canonical,
      actual: { corpus: 190, filterOff: canonical.filterOff, filterOn: canonical.filterOn, linked: null, ghosts: [] },
    });
    expect(result.summary.linkedResolved).toBe(false);
    expect(result.passed).toBe(true);
  });
});

describe('formatReport', () => {
  test('renders PASS verdict and a deviation block', () => {
    const pass = core.formatReport({
      scenarioId: 'tx1', passed: true, deviations: [],
      summary: { corpus: 190, filterOff: 69, filterOn: 37, missing: 0, extra: 0, ghosts: 0, nonAutoLinks: 0, linkedResolved: true },
    });
    expect(pass).toContain('VERDICT: PASS');

    const fail = core.formatReport({
      scenarioId: 'tx1', passed: false,
      deviations: [{ cell: 'missing', expected: 0, got: 1, missingMembers: [{ subject: 'B', shiftedDate: '2026-02-08' }] }],
      summary: { corpus: 190, filterOff: 68, filterOn: 37, missing: 1, extra: 0, ghosts: 0, nonAutoLinks: 0, linkedResolved: false },
    });
    expect(fail).toContain('VERDICT: FAIL');
    expect(fail).toContain('MISSING  2026-02-08  B');
  });
});

// Guards the parser against the REAL committed ground truth. If this drifts,
// either the manifest changed or the parser regressed — both are findings.
(fs.existsSync(REAL_MANIFEST) ? describe : describe.skip)('real canonical manifest', () => {
  test('parses to exactly 69 filter-OFF and 37 filter-ON', () => {
    const parsed = core.parseCanonicalManifest(fs.readFileSync(REAL_MANIFEST, 'utf8'));
    expect(parsed.filterOff).toHaveLength(69);
    expect(parsed.filterOn).toHaveLength(37);
  });
});
