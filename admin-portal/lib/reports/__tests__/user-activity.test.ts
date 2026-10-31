/**
 * User Activity report — pure builder tests (BACKLOG-3720)
 */

import { describe, expect, it } from 'vitest';
import {
  applyUserActivityFilters,
  buildUserActivityReport,
  computeTotals,
  EMPTY_USER_ACTIVITY_FILTERS,
  sortUserActivity,
  type UserActivityInput,
} from '../user-activity';
import {
  ALICE,
  BOB,
  CAROL,
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  ORGS,
  STAFF,
  STAFF_IDS,
  USERS,
} from './user-activity.fixture';

const INPUT: UserActivityInput = {
  users: USERS,
  devices: DEVICES,
  events: EVENTS,
  memberships: MEMBERSHIPS,
  orgs: ORGS,
  staffIds: STAFF_IDS,
};

const build = (over: Partial<UserActivityInput> = {}) => buildUserActivityReport({ ...INPUT, ...over });
const row = (id: string, over: Partial<UserActivityInput> = {}) => build(over).rows.find((r) => r.userId === id)!;

describe('per-user period counts (C9)', () => {
  it('counts created, submissions and exports for the user', () => {
    const a = row(ALICE);
    expect(a.transactionsCreated).toBe(2);
    expect(a.submissions).toBe(1);
    expect(a.eventCount).toBe(10);
    expect(a.activeInPeriod).toBe(true);
  });

  it('a LOGOUT alone still makes a user active (any recorded event)', () => {
    const b = row(BOB);
    expect(b.activeInPeriod).toBe(true);
    expect(b.transactionsEdited).toBe(1);
    expect(b.transactionsCreated).toBe(0);
  });
});

describe('transactions created are DISTINCT transactions, not rows (F1)', () => {
  it('two TRANSACTION_CREATE rows for one transaction count as 1', () => {
    // pii-allow-uuid: invented, not from any live row
    const tx = '10000000-0000-4000-8000-000000000777';
    const dup = (id: string, at: string) => ({
      id,
      user_id: ALICE,
      action: 'TRANSACTION_CREATE',
      resource_type: 'TRANSACTION',
      resource_id: tx,
      created_at: at,
    });
    const events = [
      // pii-allow-uuid: invented, not from any live row
      dup('00000000-0000-4000-8000-000000000801', '2026-10-20T09:00:00.000Z'),
      // pii-allow-uuid: invented, not from any live row
      dup('00000000-0000-4000-8000-000000000802', '2026-10-20T09:00:05.000Z'),
    ];
    const a = row(ALICE, { events });
    expect(a.eventCount).toBe(2);
    expect(a.transactionsCreated).toBe(1);
  });
});

describe('transactions edited are DISTINCT transactions, not rows (C21)', () => {
  it('three edits of one transaction plus one of another is 2', () => {
    expect(row(ALICE).transactionsEdited).toBe(2);
  });
});

describe('exports count EXPORT resources only (C20)', () => {
  it('a DATA_EXPORT on a USER resource is not an export', () => {
    expect(row(ALICE).exports).toBe(2);
  });
});

describe('every user is listed, active or not (C10)', () => {
  it('a user with no events appears with Active = no', () => {
    const c = row(CAROL);
    expect(c).toBeDefined();
    expect(c.activeInPeriod).toBe(false);
    expect(c.eventCount).toBe(0);
    expect(c.lastSignInUtc).toBe('—');
    expect(c.lastSeenUtc).toBe('—');
  });

  it('labels: display name, else first + last, else email', () => {
    expect(row(ALICE).userLabel).toBe('Alice');
    expect(row(BOB).userLabel).toBe('Bob Broker');
    expect(row(CAROL).userLabel).toBe('carol@example.test');
  });
});

describe('orphans (C11)', () => {
  it('an event from a user not in users is not a row and is counted once', () => {
    const r = build();
    expect(r.rows.map((x) => x.userId).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(r.orphanEventCount).toBe(1);
  });
});

describe('internal staff (C19)', () => {
  it('staff are not a row, and their events reach no total and not the orphan count', () => {
    const r = build();
    expect(r.rows.find((x) => x.userId === STAFF)).toBeUndefined();
    expect(r.orphanEventCount).toBe(1);
    expect(r.staffEventCount).toBe(3);
    expect(computeTotals(r.rows)).toEqual({
      users: 3,
      activeUsers: 2,
      transactionsCreated: 2,
      submissions: 1,
      activeDevices: 3,
    });
  });

  it('with no staff ids the same user IS listed (the exclusion is what removes them)', () => {
    const r = build({ staffIds: new Set() });
    expect(r.rows.find((x) => x.userId === STAFF)).toBeDefined();
    expect(r.staffEventCount).toBe(0);
  });
});

describe('latest-only columns are not period-filtered (C12)', () => {
  it('last seen after the period end is shown, and the user is not dropped', () => {
    expect(Date.parse('2026-10-28T15:30:00.000Z')).toBeGreaterThan(Date.parse(LAST_WEEK.toIso));
    const a = row(ALICE);
    expect(a.lastSeenIso).toBe('2026-10-28T15:30:00.000Z');
    expect(a.lastSeenUtc).toBe('2026-10-28 15:30 UTC');
    expect(a.lastSignInUtc).toBe('2026-10-28 09:00 UTC');
  });
});

describe('last seen is the newest device (C13)', () => {
  it('picks the middle device, which is neither first nor last', () => {
    const alices = DEVICES.filter((d) => d.user_id === ALICE);
    expect(alices[1].last_seen_at).toBe('2026-10-28T15:30:00.000Z');
    expect(row(ALICE).lastSeenIso).toBe(alices[1].last_seen_at);
  });

  it('devices: active / total and platforms', () => {
    const a = row(ALICE);
    expect([a.activeDevices, a.totalDevices]).toEqual([2, 3]);
    expect(a.platforms).toBe('macos, windows');
  });
});

describe('organizations (R6)', () => {
  it('a user in two orgs shows both, never one picked arbitrarily', () => {
    expect(row(BOB).orgNames).toEqual(['Acme Realty', 'Beta Homes']);
    expect(row(BOB).orgLabel).toBe('Acme Realty, Beta Homes');
    expect(row(CAROL).orgLabel).toBe('—');
  });

  it('the org filter matches a multi-org user on either org', () => {
    const r = build();
    const f = { ...EMPTY_USER_ACTIVITY_FILTERS, orgs: ['Beta Homes'] };
    expect(applyUserActivityFilters(r.rows, f).map((x) => x.userId)).toEqual([BOB]);
  });
});

describe('default sort: last seen desc, nulls last', () => {
  it('orders Alice, Bob, then Carol (no device)', () => {
    const sorted = sortUserActivity(build().rows, 'lastSeen', 'desc');
    expect(sorted.map((r) => r.userId)).toEqual([ALICE, BOB, CAROL]);
    const asc = sortUserActivity(build().rows, 'lastSeen', 'asc');
    expect(asc.map((r) => r.userId)).toEqual([BOB, ALICE, CAROL]);
  });
});
