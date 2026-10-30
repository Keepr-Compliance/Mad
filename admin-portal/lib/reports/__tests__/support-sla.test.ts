/**
 * Support analytics builder tests (BACKLOG-3651)
 *
 * Fixture rows are transcribed from production (see support-sla.fixture.ts).
 * Sets are asserted by id, not only by count.
 */

import { describe, expect, it } from 'vitest';
import {
  agentName,
  buildSupportSlaReport,
  formatDuration,
  isOpen,
  lastDays,
  resolvedAt,
  type SupportTicketRow,
} from '../support-sla';
import { AGENT_A, AGENT_B, NOW, TICKETS, USERS, ticketId } from './support-sla.fixture';

const D30 = lastDays(30, NOW);
const D90 = lastDays(90, NOW);

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
  const s = buildSupportSlaReport(TICKETS, USERS, D30).summary;

  it('created in period excludes deleted and pre-period tickets', () => {
    // t03, t16, t22, t23, t24; t09 is deleted, t01 was created the day before.
    expect(s.createdInPeriod).toBe(5);
  });

  it('resolved in period: closed t03 (by resolved_at) and resolved t22; reopened t23 is not resolved', () => {
    expect(s.resolvedInPeriod).toBe(2);
  });

  it('averages are minutes computed from timestamps', () => {
    expect(s.avgFirstResponseMinutes).toBeCloseTo((53.05862786666667 + 4446) / 2, 4);
    expect(s.avgResolutionMinutes).toBeCloseTo((194.95044336666666 + 1578.9982327833334) / 2, 4);
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
    const s = buildSupportSlaReport(TICKETS, USERS, D90).summary;
    expect(s.resolvedInPeriod).toBe(3); // t03, t05, t22
    expect(s.avgResolutionMinutes).toBeCloseTo(
      (194.95044336666666 + 86297.22173003334 + 1578.9982327833334) / 3,
      3
    );
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
  const report = buildSupportSlaReport(TICKETS, USERS, D30);
  const byId = new Map(report.agents.map((a) => [a.agentId, a]));

  it('one row per assignee; unassigned tickets get no row', () => {
    expect(report.agents.map((a) => a.agentId).sort()).toEqual([AGENT_A, AGENT_B]);
  });

  it('agent A: name from users, counts and averages', () => {
    const a = byId.get(AGENT_A)!;
    expect(a.name).toBe('Agent A');
    expect(a.openNow).toBe(4 + 1); // t01, t11, t19, t20, t23
    expect(a.resolvedInPeriod).toBe(2);
    expect(a.avgFirstResponseMinutes).toBeCloseTo(53.05862786666667, 4);
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
  it('a first response 74h06m after creation renders "3d 2h"', () => {
    const r = buildSupportSlaReport(TICKETS, USERS, D30);
    const b = r.agents.find((a) => a.agentId === AGENT_B)!;
    expect(b.avgFirstResponseMinutes).toBe(4446);
    expect(formatDuration(b.avgFirstResponseMinutes)).toBe('3d 2h');
  });

  it('formats under an hour and under a day', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(53.05)).toBe('53m');
    expect(formatDuration(194.95)).toBe('3h 15m');
  });
});
