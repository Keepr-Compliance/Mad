/**
 * BACKLOG-4219: the summary table's rows (lib/learn-pilot/summary.ts), built from the transcribed
 * admin-list capture (fixtures.ts) through the page's own buildViewModel. Where the capture cannot
 * tell a right answer from a wrong one (every report shares CAPTURED_REPORT's scores; every date is
 * 2026-11-11), a clone changes the fields named in each test (SR amendments A4-A8).
 */

import { describe, expect, it } from 'vitest';
import { buildViewModel } from '@/lib/learn-pilot/group';
import { parseAdminList } from '@/lib/learn-pilot/parse';
import { compactCellText, markText, matchesQuery, sortSummary, summaryRows, type SummaryKey, type SummaryRow } from '@/lib/learn-pilot/summary';
import type { OrgGroup } from '@/lib/learn-pilot/types';
import { ADMIN_LIST, ORG_X, USER_10, USER_13, USER_6, clone } from './fixtures';

type Row = (typeof ADMIN_LIST)['rows'][number] & Record<string, unknown>;
const EXTRA_USER = '00000000-0000-4219-8000-000000000077'; // pii-allow-uuid: invented fixture id
const DEC_USER = '00000000-0000-4219-8000-000000000078'; // pii-allow-uuid: invented fixture id

function orgsOf(rows: Row[], truncated = false): OrgGroup[] {
  const m = buildViewModel(parseAdminList({ rows, truncated }, null));
  if (!m.ok) throw new Error(m.message);
  return m.orgs;
}
const baseRows = (): Row[] => clone(ADMIN_LIST).rows as Row[];
const rowOf = (rows: Row[], user: string, version: number) => rows.find((r) => r.user_id === user && (r.report as { sender_rules_version?: number }).sender_rules_version === version)!;
const ids = (rows: SummaryRow[]) => rows.map((r) => r.user.userId);
const byUser = (rows: SummaryRow[], id: string) => rows.find((r) => r.user.userId === id)!;

describe('one row per pilot user per org', () => {
  it('three users in the capture, three rows, keyed org index then user id', () => {
    const rows = summaryRows(orgsOf(baseRows()));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    for (const r of rows) expect(r.key).toMatch(new RegExp(`^\\d+:${r.user.userId}$`));
  });

  it('the same user in two orgs is two rows with two keys (A9)', () => {
    const rows = baseRows();
    const copy = clone(rowOf(rows, USER_13, 5));
    copy.org_id = ORG_X;
    copy.org_name = 'P4219 X';
    const out = summaryRows(orgsOf([...rows, copy]));
    const u13 = out.filter((r) => r.user.userId === USER_13);
    expect(u13).toHaveLength(2);
    expect(new Set(u13.map((r) => r.key)).size).toBe(2);
    expect(u13.map((r) => r.orgName).sort()).toEqual(['P4219 X', 'P4219 Z']);
  });
});

describe('which report a row shows: the newest-submitted, not the highest version', () => {
  // USER_10: v1 submitted 18:43, v2 submitted 18:33. Give the two different scores (A4).
  const differing = () => {
    const rows = baseRows();
    const v1 = rowOf(rows, USER_10, 1);
    const v2 = rowOf(rows, USER_10, 2);
    v1.report = { ...v1.report, recall: { k: 2, n: 3 }, recall_with_cleanup_yes: { k: 3, n: 4 }, precision_after_cleanup: { k: 9, n: 11 }, known_wrong: 3 };
    v2.report = { ...v2.report, recall: { k: 1, n: 4 }, recall_with_cleanup_yes: { k: 1, n: 5 }, precision_after_cleanup: { k: 1, n: 2 }, known_wrong: 8 };
    return rows;
  };

  it('USER_10 shows v1 (newest submitted), its date, and v1 scores', () => {
    const r = byUser(summaryRows(orgsOf(differing())), USER_10);
    expect(r.column.version).toBe(1);
    expect(r.column.submittedAt).toBe('2026-11-11T18:43:02.172359+00:00');
    expect(r.recall).toEqual({ kind: 'kn', k: 2, n: 3 });
    expect(r.recallYes).toEqual({ kind: 'kn', k: 3, n: 4 });
    expect(r.precision).toEqual({ kind: 'kn', k: 9, n: 11 });
    expect(r.knownWrong).toEqual({ kind: 'count', value: 3 });
  });

  it('parity: every summary cell equals the detail cell under the column of the SAME version, and not the other', () => {
    const rows = summaryRows(orgsOf(differing()));
    const pairs: [keyof SummaryRow, string][] = [
      ['recall', 'recall'],
      ['recallYes', 'recall_with_cleanup_yes'],
      ['precision', 'precision_after_cleanup'],
      ['knownWrong', 'known_wrong'],
    ];
    for (const r of rows) {
      const col = r.user.columns.findIndex((c) => c.version === r.column.version);
      for (const [field, id] of pairs) expect(r[field]).toEqual(r.user.rows.find((m) => m.id === id)!.cells[col]);
    }
    const u10 = byUser(rows, USER_10);
    const v2 = u10.user.columns.findIndex((c) => c.version === 2);
    for (const [field, id] of pairs) expect(u10[field]).not.toEqual(u10.user.rows.find((m) => m.id === id)!.cells[v2]);
  });

  it('USER_6 shows v999999 (newest), USER_13 its only report', () => {
    const rows = summaryRows(orgsOf(baseRows()));
    expect(byUser(rows, USER_6).column.version).toBe(999999);
    expect(byUser(rows, USER_13).column.version).toBe(5);
  });
});

describe('cell text and the version mark', () => {
  it('compact k/n, no data, missing and counts', () => {
    expect(compactCellText({ kind: 'kn', k: 2, n: 3 })).toBe('66.7% · 2/3');
    expect(compactCellText({ kind: 'kn', k: 0, n: 0 })).toBe('no data · 0/0');
    expect(compactCellText(null)).toBe('—');
    expect(compactCellText({ kind: 'count', value: 4 })).toBe('4');
  });

  it('the mark carries ", bundled" for a released bundled version, as the detail header does (A2)', () => {
    const rows = summaryRows(orgsOf(baseRows()));
    expect(markText(byUser(rows, USER_10).column)).toBe('Released, bundled');
    expect(markText(byUser(rows, USER_6).column)).toBe('Unknown to the server');
    expect(markText(byUser(rows, USER_13).column)).toBe('Test for another org');
  });
});

describe('sorting', () => {
  it('default (last report, newest first): the 18:50 tie breaks by name, no name last (A7)', () => {
    const rows = summaryRows(orgsOf(baseRows()));
    expect(ids(sortSummary(rows, 'lastReport', 'desc'))).toEqual([USER_6, USER_13, USER_10]);
  });

  it('rates sort on the rate, not the text: 100 / 75 / 9.1, n = 0 last both ways (A6)', () => {
    const rows = baseRows();
    rowOf(rows, USER_6, 999999).report = { ...rowOf(rows, USER_6, 999999).report, recall: { k: 1, n: 1 } };
    rowOf(rows, USER_10, 1).report = { ...rowOf(rows, USER_10, 1).report, recall: { k: 3, n: 4 } };
    rowOf(rows, USER_13, 5).report = { ...rowOf(rows, USER_13, 5).report, recall: { k: 1, n: 11 } };
    const extra = clone(rowOf(rows, USER_13, 5));
    extra.user_id = EXTRA_USER;
    extra.user_name = 'Extra';
    extra.report = { ...extra.report, recall: { k: 0, n: 0 } };
    const out = summaryRows(orgsOf([...rows, extra]));
    expect(ids(sortSummary(out, 'recall', 'desc'))).toEqual([USER_6, USER_10, USER_13, EXTRA_USER]);
    expect(ids(sortSummary(out, 'recall', 'asc'))).toEqual([USER_13, USER_10, USER_6, EXTRA_USER]);
  });

  it('last report sorts on time, not the formatted date: a December row is newest (A5)', () => {
    const rows = baseRows();
    const dec = clone(rowOf(rows, USER_13, 5));
    dec.user_id = DEC_USER;
    dec.user_name = 'December';
    dec.submitted_at = '2026-12-01T10:00:00+00:00';
    const out = summaryRows(orgsOf([...rows, dec]));
    expect(ids(sortSummary(out, 'lastReport', 'desc'))[0]).toBe(DEC_USER);
    expect(ids(sortSummary(out, 'lastReport', 'asc')).at(-1)).toBe(DEC_USER);
  });

  it('version sorts numerically: v999999 above v5 above v1', () => {
    const out = summaryRows(orgsOf(baseRows()));
    expect(ids(sortSummary(out, 'version', 'desc'))).toEqual([USER_6, USER_13, USER_10]);
  });

  it('name: no name sorts last in both directions', () => {
    const out = summaryRows(orgsOf(baseRows()));
    expect(ids(sortSummary(out, 'name', 'asc'))).toEqual([USER_6, USER_10, USER_13]);
    expect(ids(sortSummary(out, 'name', 'desc'))).toEqual([USER_10, USER_6, USER_13]);
  });

  it('every key sorts without throwing and keeps every row', () => {
    const out = summaryRows(orgsOf(baseRows()));
    const keys: SummaryKey[] = ['name', 'org', 'version', 'recall', 'recallYes', 'precision', 'knownWrong', 'lastReport'];
    for (const k of keys) for (const d of ['asc', 'desc'] as const) expect(sortSummary(out, k, d)).toHaveLength(3);
  });
});

describe('search (A8)', () => {
  const rows = () => summaryRows(orgsOf(baseRows()));
  const hits = (q: string) => ids(rows().filter((r) => matchesQuery(r, q)));

  it('org name, trimmed and case-insensitive', () => {
    expect(hits('  P4219 Z  ')).toEqual([USER_13]);
    expect(hits('p4219 z')).toEqual([USER_13]);
  });
  it('Keepr user id', () => {
    expect(hits('000013')).toEqual([USER_13]);
  });
  it('name, case-insensitive', () => {
    expect(hits('pat TEN')).toEqual([USER_10]);
  });
  it('blank matches everyone; nothing matches nothing', () => {
    expect(hits('   ')).toHaveLength(3);
    expect(hits('no such user')).toEqual([]);
  });
});
