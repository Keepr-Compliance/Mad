/**
 * Exports report — the counting rule, filters, grouping and buckets (BACKLOG-4004)
 */

import { describe, expect, it } from 'vitest';
import {
  applyExportFilters,
  bucketExportsByDay,
  buildExportsReport,
  countByFormat,
  countExports,
  countUsers,
  EMPTY_EXPORT_FILTERS,
  groupByOrg,
  groupByUser,
  NO_ORG,
  NO_ORG_LABEL,
  UNKNOWN_ORG,
  UNKNOWN_ORG_LABEL,
  UNKNOWN_USER_LABEL,
} from '../exports';
import { D1, EXPECTED_ALL, EXPORT_ROWS, LOOKUPS, PERIOD } from './exports.fixture';

const report = buildExportsReport(EXPORT_ROWS, LOOKUPS);
const events = report.events;
const only = (over: Partial<typeof EMPTY_EXPORT_FILTERS>) =>
  applyExportFilters(events, { ...EMPTY_EXPORT_FILTERS, ...over });

describe('the two counters', () => {
  it('Exports counts every export-completed event, Unique counts (user, deal) pairs', () => {
    expect(events).toHaveLength(EXPECTED_ALL.exports);
    expect(countExports(events)).toEqual({ exports: EXPECTED_ALL.exports, unique: EXPECTED_ALL.unique });
    expect(countUsers(events)).toBe(EXPECTED_ALL.users);
  });

  it('ignores a row with another event name', () => {
    expect(events.map((e) => e.id)).not.toContain('evt-12');
  });

  it('a three-export chain 8 s apart is three exports and one unique', () => {
    const chain = events.filter((e) => ['evt-01', 'evt-02', 'evt-03'].includes(e.id));
    expect(countExports(chain)).toEqual({ exports: 3, unique: 1 });
  });

  it('a double-click pair is two exports and one unique', () => {
    expect(countExports(events.filter((e) => ['evt-07', 'evt-08'].includes(e.id)))).toEqual({
      exports: 2,
      unique: 1,
    });
  });

  it('format is NOT part of the pair: PDF and folder of the same deal by one user is one unique', () => {
    const userOneD1 = events.filter((e) => e.userId === 'user-1' && e.dealId === D1);
    expect(countExports(userOneD1)).toEqual({ exports: 4, unique: 1 });
  });

  it('the user IS part of the pair: two users exporting the same deal are two unique', () => {
    expect(countExports(events.filter((e) => e.dealId === D1))).toEqual({ exports: 5, unique: 2 });
  });

  it('counts by format, each with both counters; other formats separately', () => {
    expect(countByFormat(events)).toEqual({
      pdf: { exports: 7, unique: 5 },
      folder: { exports: 3, unique: 2 },
      other: { exports: 1, unique: 1 },
    });
  });
});

describe('filters', () => {
  it('organization narrows to users with ANY selected organization', () => {
    const a = only({ orgs: ['org-a'] });
    expect(new Set(a.map((e) => e.userId))).toEqual(new Set(['user-1', 'user-2', 'user-4']));
    expect(countExports(a)).toEqual({ exports: 9, unique: 5 });
    const b = only({ orgs: ['org-b'] });
    expect(b.map((e) => e.userId)).toEqual(['user-4']);
  });

  it('filters AND together: organization and format', () => {
    expect(countExports(only({ orgs: ['org-a'], formats: ['folder'] }))).toEqual({ exports: 3, unique: 2 });
  });

  it('keeps the user with no organization, reachable as "No organization"', () => {
    expect(events.filter((e) => e.userId === 'user-3')).toHaveLength(2);
    expect(only({ orgs: [NO_ORG] }).map((e) => e.userId)).toEqual(['user-3', 'user-3']);
    expect(report.orgNames[NO_ORG]).toBe(NO_ORG_LABEL);
  });

  it('search matches the name or the email, case-insensitive', () => {
    expect(new Set(only({ search: 'AGENT.THREE' }).map((e) => e.userId))).toEqual(new Set(['user-3']));
    expect(new Set(only({ search: 'agent two' }).map((e) => e.userId))).toEqual(new Set(['user-2']));
  });

  it('a filter result is always a subset of the unfiltered set', () => {
    for (const f of [{ orgs: ['org-a'] }, { users: ['user-2'] }, { formats: ['pdf'] }, { search: 'one' }]) {
      const ids = new Set(events.map((e) => e.id));
      expect(only(f).every((e) => ids.has(e.id))).toBe(true);
      expect(only(f).length).toBeLessThan(events.length);
    }
  });
});

describe('lookups', () => {
  it('a failed lookup reads Unknown, never "No organization"', () => {
    const failed = buildExportsReport(EXPORT_ROWS, { users: [], memberships: [], orgs: [], failed: true });
    expect(failed.events.every((e) => e.orgKeys.join() === UNKNOWN_ORG)).toBe(true);
    expect(failed.events.every((e) => e.orgLabel === UNKNOWN_ORG_LABEL)).toBe(true);
    expect(failed.events.every((e) => e.userLabel === UNKNOWN_USER_LABEL)).toBe(true);
    expect(Object.values(failed.orgNames)).not.toContain(NO_ORG_LABEL);
    // Counts do not depend on names.
    expect(countExports(failed.events)).toEqual({ exports: EXPECTED_ALL.exports, unique: EXPECTED_ALL.unique });
  });

  it('an invite membership row (no user) matches nobody', () => {
    expect(events.find((e) => e.userId === 'user-3')?.orgKeys).toEqual([NO_ORG]);
  });

  it('a user in two organizations carries both', () => {
    expect(events.find((e) => e.userId === 'user-4')?.orgLabel).toBe('Brokerage A, Brokerage B');
  });
});

describe('per-user and per-organization rows', () => {
  it('per user: both counters, formats, first and last', () => {
    const rows = new Map(groupByUser(events).map((r) => [r.key, r]));
    expect(rows.get('user-1')).toMatchObject({ exports: 5, unique: 2, formats: 'pdf 4 · folder 1' });
    expect(rows.get('user-2')).toMatchObject({ exports: 3, unique: 2 });
    expect(rows.get('user-3')).toMatchObject({ exports: 2, unique: 2, label: 'agent.three@example.test' });
    expect(rows.get('user-1')?.first).toBe('2026-10-13 10:00 UTC');
    expect(rows.get('user-1')?.last).toBe('2026-10-15 09:00 UTC');
  });

  it('per organization: a two-org user counts in each; no-org is its own row', () => {
    const rows = new Map(groupByOrg(events, report.orgNames).map((r) => [r.key, r]));
    expect(rows.get('org-a')).toMatchObject({ label: 'Brokerage A', exports: 9, unique: 5, users: 3 });
    expect(rows.get('org-b')).toMatchObject({ label: 'Brokerage B', exports: 1, unique: 1, users: 1 });
    expect(rows.get(NO_ORG)).toMatchObject({ label: NO_ORG_LABEL, exports: 2, unique: 2, users: 1 });
  });
});

describe('per-day buckets (UTC)', () => {
  const buckets = bucketExportsByDay(events, PERIOD);
  const byDay = new Map(buckets.map((b) => [b.dayIso, b]));

  it('one bucket per day of the period, empty days included', () => {
    expect(buckets.map((b) => b.dayIso)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(byDay.get('2026-10-18')).toMatchObject({ exports: 0, unique: 0 });
  });

  it('an export at exactly the period start is on the first day', () => {
    expect(byDay.get('2026-10-12')).toMatchObject({ exports: 1, unique: 1 });
  });

  it('both exports at 03:30Z and 23:30Z on 17 October land on the 17th', () => {
    expect(byDay.get('2026-10-17')).toMatchObject({ exports: 2, unique: 2 });
    expect(byDay.get('2026-10-16')).toMatchObject({ exports: 2, unique: 1 });
  });

  it('unique counts a pair on its first day only, so days sum to the card', () => {
    // user-2 re-exports D1 on the 14th; user-1 first did on the 13th — different users, new pair.
    expect(byDay.get('2026-10-13')).toMatchObject({ exports: 4, unique: 1 });
    const sum = buckets.reduce((a, b) => ({ exports: a.exports + b.exports, unique: a.unique + b.unique }), {
      exports: 0,
      unique: 0,
    });
    expect(sum).toEqual(countExports(events));
  });

  it('a pair exported again on a later day is not counted unique twice', () => {
    const again = buildExportsReport(
      [
        ...EXPORT_ROWS,
        {
          id: 'evt-13',
          user_id: 'user-1',
          event_name: 'export-completed',
          event_data: { transaction_id: D1, mode: 'full', format: 'pdf' },
          created_at: '2026-10-18T10:00:00.000000+00:00',
        },
      ],
      LOOKUPS
    ).events;
    const b = bucketExportsByDay(again, PERIOD);
    expect(b.find((x) => x.dayIso === '2026-10-18')).toMatchObject({ exports: 1, unique: 0 });
    expect(b.reduce((n, x) => n + x.unique, 0)).toBe(countExports(again).unique);
  });
});
