/**
 * Support analytics builder tests (BACKLOG-3651)
 *
 * Fixture rows are transcribed from production (see support-sla.fixture.ts).
 * Sets are asserted by id, not only by count.
 *
 * BACKLOG-4086: durations are business minutes when settings are passed
 * (OPTS). Every business-minute number below was re-derived with an
 * independent brute-force reference (minute-by-minute walk, Intl local time),
 * not copied from the plan.
 */

import { describe, expect, it } from 'vitest';
import {
  agentName,
  buildSupportSlaReport,
  firstResponseTargetLabel,
  formatBusinessDuration,
  formatDuration,
  isOpen,
  lastDays,
  resolutionTargetLabel,
  resolutionTargetMinutes,
  resolvedAt,
  type SupportSlaSettings,
  type SupportTicketRow,
} from '../support-sla';
import { AGENT_A, AGENT_B, NOW, TICKETS, USERS, ticketId } from './support-sla.fixture';
import {
  A12_NOW,
  A12_ROWS,
  A13_NOW,
  A13_ROWS,
  A21_NOW,
  A21_ROWS,
  A22_NOW,
  A22_ROWS,
  R8_NOW,
  R8_PERIOD,
  R8_ROWS,
  TEST_SETTINGS,
  WEEKS,
  synthetic,
} from './support-sla-attainment.fixture';

const D30 = lastDays(30, NOW);
const D90 = lastDays(90, NOW);
const OPTS = { settings: TEST_SETTINGS, now: NOW };

// Business minutes (brute-force reference, America/Los_Angeles Mon-Fri 9-17).
const T22_FR = 53.05862786666667; // inside hours: equals calendar
const T03_RES = 194.95044336666666; // inside hours: equals calendar
const T22_RES = 618.9982; // calendar 1578.998
const T05_RES = 20160; // calendar 86297.22
const T24_FR = 1440; // calendar 4446

const ids = (rows: SupportTicketRow[]) => rows.map((r) => r.id).sort();
const nums = (...ns: number[]) => ns.map(ticketId).sort();

describe('open now (C1)', () => {
  it('is exactly the non-deleted tickets that are not resolved or closed, pending included', () => {
    expect(ids(TICKETS.filter(isOpen))).toEqual(nums(1, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24));
  });

  it('the summary falls back to the open rows read when no exact count is given', () => {
    expect(buildSupportSlaReport(TICKETS, USERS, D30).summary.openNow).toBe(13);
  });

  it('the exact count wins when given', () => {
    expect(buildSupportSlaReport(TICKETS, USERS, D30, 76).summary.openNow).toBe(76);
  });
});

describe('summary, last 30 days', () => {
  const s = buildSupportSlaReport(TICKETS, USERS, D30, null, OPTS).summary;

  it('created in period excludes deleted and pre-period tickets', () => {
    // t03, t16, t22, t23, t24; t09 is deleted, t01 was created the day before.
    expect(s.createdInPeriod).toBe(5);
  });

  it('resolved in period: closed t03 (by resolved_at) and resolved t22; reopened t23 is not resolved', () => {
    expect(s.resolvedInPeriod).toBe(2);
  });

  it('averages are BUSINESS minutes computed from timestamps', () => {
    expect(s.avgFirstResponseMinutes).toBeCloseTo((T22_FR + T24_FR) / 2, 3);
    expect(s.avgResolutionMinutes).toBeCloseTo((T03_RES + T22_RES) / 2, 3);
  });

  it('median and p90 sit beside the averages, on the same populations', () => {
    expect(s.medianFirstResponseMinutes).toBeCloseTo((T22_FR + T24_FR) / 2, 3);
    expect(s.p90FirstResponseMinutes).toBe(T24_FR);
    expect(s.medianResolutionMinutes).toBeCloseTo((T03_RES + T22_RES) / 2, 3);
    expect(s.p90ResolutionMinutes).toBeCloseTo(T22_RES, 3);
  });
});

describe('resolved time = coalesce(resolved_at, closed_at), resolved/closed only (SR change 3)', () => {
  it('a closed ticket with no resolved_at resolves at closed_at', () => {
    const t05 = TICKETS.find((r) => r.id === ticketId(5))!;
    expect(resolvedAt(t05)).toBe(t05.closed_at);
  });

  it('a reopened ticket with a stale resolved_at is not resolved', () => {
    const t23 = TICKETS.find((r) => r.id === ticketId(23))!;
    expect(resolvedAt(t23)).toBeNull();
  });

  it('90 days: closed-without-resolved t05 counts, deleted-with-resolved t08 never does', () => {
    const s = buildSupportSlaReport(TICKETS, USERS, D90, null, OPTS).summary;
    expect(s.resolvedInPeriod).toBe(3); // t03, t05, t22
    expect(s.avgResolutionMinutes).toBeCloseTo((T03_RES + T05_RES + T22_RES) / 3, 3);
  });
});

describe('period is half-open [from, to) (C3)', () => {
  const from = Date.parse(D30.fromIso);
  const to = Date.parse(D30.toIso);
  const iso = (t: number) => new Date(t).toISOString();
  const resolvedAtTime = (n: number, t: number): SupportTicketRow => ({
    id: ticketId(n),
    status: 'resolved',
    assignee_id: null,
    created_at: iso(from - 86400000 * 10),
    first_response_at: null,
    resolved_at: iso(t),
    closed_at: null,
  });

  // One row per case, so an off-by-one at one bound cannot cancel one at the other.
  it.each([
    ['from - 1ms', -1, 'from', 0],
    ['from', 0, 'from', 1],
    ['from + 1ms', 1, 'from', 1],
    ['to - 1ms', -1, 'to', 1],
    ['to', 0, 'to', 0],
    ['to + 1ms', 1, 'to', 0],
  ] as const)('resolved at %s counts %#', (_label, offset, bound, expected) => {
    const t = (bound === 'from' ? from : to) + offset;
    const s = buildSupportSlaReport([resolvedAtTime(51, t)], [], D30).summary;
    expect(s.resolvedInPeriod).toBe(expected);
  });

  it('a ticket resolved 31 days ago is outside the 30-day period', () => {
    const rows = [resolvedAtTime(56, to - 31 * 86400000)];
    const s = buildSupportSlaReport(rows, [], D30).summary;
    expect(s.resolvedInPeriod).toBe(0);
    expect(s.avgResolutionMinutes).toBeNull();
  });
});

describe('agent rows (C4, SR change 5)', () => {
  const report = buildSupportSlaReport(TICKETS, USERS, D30, null, OPTS);
  const byId = new Map(report.agents.map((a) => [a.agentId, a]));

  it('one row per assignee; unassigned tickets get no row', () => {
    expect(report.agents.map((a) => a.agentId).sort()).toEqual([AGENT_A, AGENT_B]);
  });

  it('agent A: name from users, counts and averages', () => {
    const a = byId.get(AGENT_A)!;
    expect(a.name).toBe('Agent A');
    expect(a.openNow).toBe(4 + 1); // t01, t11, t19, t20, t23
    expect(a.resolvedInPeriod).toBe(2);
    expect(a.avgFirstResponseMinutes).toBeCloseTo(T22_FR, 4);
    expect(a.avgResolutionMinutes).toBeCloseTo((T03_RES + T22_RES) / 2, 3);
  });

  it('agent B: no display name, so the name falls back to email', () => {
    const b = byId.get(AGENT_B)!;
    expect(b.name).toBe('agent-b@example.com');
    expect(b.openNow).toBe(3);
    expect(b.resolvedInPeriod).toBe(0);
    expect(b.avgResolutionMinutes).toBeNull();
  });

  it('an assignee missing from users is "Unknown agent"', () => {
    const r = buildSupportSlaReport(TICKETS, [], D30);
    expect(r.agents.map((a) => a.name)).toEqual(['Unknown agent', 'Unknown agent']);
  });

  it('name order: display name, then first + last, then email, then "Unknown agent"', () => {
    const base = { id: AGENT_A, email: null, display_name: null, first_name: null, last_name: null };
    expect(agentName({ ...base, first_name: 'Agent', last_name: 'C', email: 'x@example.com' })).toBe('Agent C');
    expect(agentName({ ...base, email: 'x@example.com' })).toBe('x@example.com');
    expect(agentName({ ...base, display_name: '  ' })).toBe('Unknown agent');
  });
});

describe('duration (C2)', () => {
  it('a first response 74h06m after creation is 1440 BUSINESS minutes and renders "24h"', () => {
    const r = buildSupportSlaReport(TICKETS, USERS, D30, null, OPTS);
    const b = r.agents.find((a) => a.agentId === AGENT_B)!;
    expect(b.avgFirstResponseMinutes).toBe(T24_FR);
    expect(formatBusinessDuration(b.avgFirstResponseMinutes)).toBe('24h');
    // hours passed where minutes are expected would render "24m"
    expect(formatBusinessDuration(24)).toBe('24m');
  });

  it('TRANSITIONAL: options omitted keeps the pre-4086 calendar output (page unchanged until it passes settings)', () => {
    const r = buildSupportSlaReport(TICKETS, USERS, D30);
    const b = r.agents.find((a) => a.agentId === AGENT_B)!;
    expect(b.avgFirstResponseMinutes).toBe(4446);
    expect(formatDuration(b.avgFirstResponseMinutes)).toBe('3d 2h');
    expect(r.summary.avgResolutionMinutes).toBeCloseTo((194.95044336666666 + 1578.9982327833334) / 2, 4);
    expect(r.summary.firstResponseSla).toBeNull();
    expect(r.summary.resolutionSla).toBeNull();
  });

  it('formats under an hour and under a day', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(53.05)).toBe('53m');
    expect(formatDuration(194.95)).toBe('3h 15m');
  });
});

describe('formatBusinessDuration (SR R6: round the total first, never roll into days)', () => {
  it.each([
    [null, '-'],
    [0, '0m'],
    [53.05, '53m'],
    [59.6, '1h'],
    [119.7, '2h'],
    [194.95, '3h 15m'],
    [1440, '24h'],
    [20160, '336h'],
    [328.4, '5h 28m'],
  ] as const)('%s -> %s', (min, text) => {
    expect(formatBusinessDuration(min)).toBe(text);
  });
});

describe('targets from settings', () => {
  it('resolution target = business days x window length (9-17: 1440; 9-18: 1620)', () => {
    expect(resolutionTargetMinutes(TEST_SETTINGS)).toBe(1440);
    expect(resolutionTargetMinutes({ ...TEST_SETTINGS, businessDayEndMinute: 1080 })).toBe(1620);
  });

  it('labels', () => {
    expect(firstResponseTargetLabel(TEST_SETTINGS)).toBe('8 business hours (one working day)');
    expect(firstResponseTargetLabel({ ...TEST_SETTINGS, firstResponseTargetMinutes: 60 })).toBe('1 business hour');
    expect(firstResponseTargetLabel({ ...TEST_SETTINGS, firstResponseTargetMinutes: 90 })).toBe('90 business minutes');
    expect(resolutionTargetLabel(TEST_SETTINGS)).toBe('3 business days');
    expect(resolutionTargetLabel({ ...TEST_SETTINGS, resolutionTargetBusinessDays: 1 })).toBe('1 business day');
  });
});

describe('attainment (BACKLOG-4086)', () => {
  const build = (rows: SupportTicketRow[], now: Date, settings: SupportSlaSettings = TEST_SETTINGS, period = WEEKS) =>
    buildSupportSlaReport(rows, [], period, null, { settings, now }).summary;

  it('fixture, last 30 days (strict first response): FR 1 met / 3 missed / 1 awaiting = 25%; RES 2 / 2 / 1 = 50%', () => {
    const s = buildSupportSlaReport(TICKETS, USERS, D30, null, OPTS).summary;
    // FR: t22 met; t03 (closed, no reply), t23, t24 (1440 > 480) missed; t16 (44 business min old) awaiting.
    expect(s.firstResponseSla).toEqual({ met: 1, missed: 3, awaiting: 1, ratePct: 25, targetMinutes: 480 });
    // RES: t03, t22 met; t23 (reopened), t24 missed; t16 awaiting.
    expect(s.resolutionSla).toEqual({ met: 2, missed: 2, awaiting: 1, ratePct: 50, targetMinutes: 1440 });
  });

  it('R9 cohort = tickets CREATED in the period, not tickets resolved in it (resolved-cohort would read 100%)', () => {
    const s = buildSupportSlaReport(TICKETS, USERS, D30, null, OPTS).summary;
    expect(s.resolvedInPeriod).toBe(2);
    expect(s.resolutionSla!.met + s.resolutionSla!.missed + s.resolutionSla!.awaiting).toBe(s.createdInPeriod);
    expect(s.resolutionSla!.ratePct).toBe(50);
    // t05 was resolved in the 90-day period but created before it: not in the cohort.
    const s90 = buildSupportSlaReport(TICKETS, USERS, D90, null, OPTS).summary;
    expect(s90.resolutionSla!.met + s90.resolutionSla!.missed + s90.resolutionSla!.awaiting).toBe(s90.createdInPeriod);
  });

  it('A12 answered on time + unanswered past target = 50% (met 1, missed 1, awaiting 0)', () => {
    expect(build(A12_ROWS, A12_NOW).firstResponseSla).toEqual({
      met: 1,
      missed: 1,
      awaiting: 0,
      ratePct: 50,
      targetMinutes: 480,
    });
  });

  it('A13 unanswered and still inside the target is awaiting, and the rate is null', () => {
    expect(build(A13_ROWS, A13_NOW).firstResponseSla).toEqual({
      met: 0,
      missed: 0,
      awaiting: 1,
      ratePct: null,
      targetMinutes: 480,
    });
  });

  it('A21 (SR R3) awaiting vs missed is decided on BUSINESS time: 600 calendar min old, 60 business min -> awaiting', () => {
    const fr = build(A21_ROWS, A21_NOW).firstResponseSla!;
    expect(fr.awaiting).toBe(1);
    expect(fr.missed).toBe(0);
  });

  it('A22 (SR R4) resolution at 1441 business min is missed; at exactly 1440 it is met', () => {
    expect(build(A22_ROWS, A22_NOW).resolutionSla).toEqual({
      met: 1,
      missed: 1,
      awaiting: 0,
      ratePct: 50,
      targetMinutes: 1440,
    });
  });

  it('A22 with a 9-18 window: target 1620; the same rows give 1621 (missed) and 1620 (met)', () => {
    const r = build(A22_ROWS, A22_NOW, { ...TEST_SETTINGS, businessDayEndMinute: 1080 }).resolutionSla!;
    expect(r).toEqual({ met: 1, missed: 1, awaiting: 0, ratePct: 50, targetMinutes: 1620 });
  });

  it('R8 a reply after the period end, within target, is met (timestamps are not clipped to the period)', () => {
    const s = buildSupportSlaReport(R8_ROWS, [], R8_PERIOD, null, { settings: TEST_SETTINGS, now: R8_NOW }).summary;
    expect(s.createdInPeriod).toBe(1);
    expect(s.firstResponseSla).toMatchObject({ met: 1, missed: 0, awaiting: 0, ratePct: 100 });
  });

  it('the first-response target comes from settings: 100 business min is met at 480, missed at 60', () => {
    const rows = [synthetic(67, 'in_progress', '2026-10-26T10:00:00-07:00', '2026-10-26T11:40:00-07:00')];
    const now = new Date('2026-10-28T12:00:00-07:00');
    expect(build(rows, now).firstResponseSla).toMatchObject({ met: 1, missed: 0, targetMinutes: 480 });
    expect(build(rows, now, { ...TEST_SETTINGS, firstResponseTargetMinutes: 60 }).firstResponseSla).toMatchObject({
      met: 0,
      missed: 1,
      targetMinutes: 60,
    });
  });

  it('deleted tickets are not in the cohort', () => {
    const rows = [synthetic(68, 'deleted', '2026-10-20T10:00:00-07:00', null)];
    expect(build(rows, A12_NOW).firstResponseSla).toMatchObject({ met: 0, missed: 0, awaiting: 0, ratePct: null });
  });
});

describe('settings read failed (settings: null)', () => {
  const r = buildSupportSlaReport(TICKETS, USERS, D30, 76, { settings: null, now: NOW });

  it('every duration and both attainments are null; counts are still computed', () => {
    const s = r.summary;
    expect([
      s.avgFirstResponseMinutes,
      s.avgResolutionMinutes,
      s.medianFirstResponseMinutes,
      s.p90FirstResponseMinutes,
      s.medianResolutionMinutes,
      s.p90ResolutionMinutes,
      s.firstResponseSla,
      s.resolutionSla,
    ]).toEqual([null, null, null, null, null, null, null, null]);
    expect(s.openNow).toBe(76);
    expect(s.createdInPeriod).toBe(5);
    expect(s.resolvedInPeriod).toBe(2);
  });

  it('agent rows keep counts but show no durations', () => {
    const a = r.agents.find((x) => x.agentId === AGENT_A)!;
    expect(a.resolvedInPeriod).toBe(2);
    expect(a.avgFirstResponseMinutes).toBeNull();
    expect(a.avgResolutionMinutes).toBeNull();
  });
});
