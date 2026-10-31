/**
 * Business-hours clock tests (BACKLOG-4086)
 *
 * Vectors A1-A11 and A18-A20 are the plan's worked examples (plan §3/§7);
 * X1-X7 are the SR plan review's extras. A18-A20 use the TRANSCRIBED
 * production timestamps from support-sla.fixture.ts. Run this suite under
 * TZ=UTC, TZ=America/Los_Angeles and TZ=Asia/Kolkata: the result must not
 * depend on the process time zone.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  businessMinutes,
  createDayCalendar,
  isValidTimeZone,
  zonedToUtc,
  type BusinessWindow,
} from '../business-hours';
import { TICKETS, ticketId } from './support-sla.fixture';

const PACIFIC: BusinessWindow = { startMinute: 540, endMinute: 1020, days: [1, 2, 3, 4, 5], timeZone: 'America/Los_Angeles' };
const cal = () => createDayCalendar(PACIFIC);
const bm = (a: string, b: string, w: BusinessWindow = PACIFIC) => businessMinutes(a, b, createDayCalendar(w));
const t = (n: number) => TICKETS.find((r) => r.id === ticketId(n))!;

describe('pausing clock — the founder example and its boundaries', () => {
  it.each([
    ['A1 Fri 16:59 PDT -> Mon 09:00', '2026-10-23T16:59:00-07:00', '2026-10-26T09:00:00-07:00', 1],
    ['A2 Fri 16:59 -> Mon 16:59 (due)', '2026-10-23T16:59:00-07:00', '2026-10-26T16:59:00-07:00', 480],
    ['A3 Fri 16:59 -> Mon 17:00', '2026-10-23T16:59:00-07:00', '2026-10-26T17:00:00-07:00', 481],
    ['A4 Fri 17:59 (after close) -> Mon 08:01 (before open)', '2026-10-23T17:59:00-07:00', '2026-10-26T08:01:00-07:00', 0],
    ['A5 Fri 17:59 -> Mon 09:01', '2026-10-23T17:59:00-07:00', '2026-10-26T09:01:00-07:00', 1],
    ['A6 Sat 12:00 -> Mon 14:00', '2026-10-24T12:00:00-07:00', '2026-10-26T14:00:00-07:00', 300],
    ['A7 DST spring: Fri 03-06 16:59 PST -> Mon 03-09 10:00 PDT', '2026-03-06T16:59:00-08:00', '2026-03-09T10:00:00-07:00', 61],
    ['A8 DST fall: Fri 10-30 16:59 PDT -> Mon 11-02 10:00 PST', '2026-10-30T16:59:00-07:00', '2026-11-02T10:00:00-08:00', 61],
    ['A9 Fri 10-30 16:00 PDT -> Wed 11-04 16:00 PST (3 business days)', '2026-10-30T16:00:00-07:00', '2026-11-04T16:00:00-08:00', 1440],
    ['A10 Mon 15:00 -> Tue 10:00', '2026-10-26T15:00:00-07:00', '2026-10-27T10:00:00-07:00', 180],
    ['X1 Mon 20:35 -> Sun 08:45', '2026-09-28T20:35:00-07:00', '2026-10-04T08:45:00-07:00', 1920],
    ['X4 spring-forward Sunday 01:00 PST -> Mon 09:30', '2026-03-08T01:00:00-08:00', '2026-03-09T09:30:00-07:00', 30],
    ['X5 fall-back Sunday 00:30 PDT -> Mon 09:30 PST', '2026-11-01T00:30:00-07:00', '2026-11-02T09:30:00-08:00', 30],
    ['X6 exactly one window', '2026-10-26T09:00:00-07:00', '2026-10-26T17:00:00-07:00', 480],
  ] as const)('%s (%s -> %s) = %d', (_label, a, b, expected) => {
    expect(bm(a, b)).toBe(expected);
  });

  it('X2 a 59-calendar-day span is 42 business days = 20160', () => {
    expect(bm('2026-07-30T21:56:00-07:00', '2026-09-28T20:13:00-07:00')).toBe(20160);
  });

  it('X7 end before start, and equal ends, are 0', () => {
    expect(bm('2026-10-26T12:00:00-07:00', '2026-10-26T10:00:00-07:00')).toBe(0);
    expect(bm('2026-10-26T12:00:00-07:00', '2026-10-26T12:00:00-07:00')).toBe(0);
  });

  it('A11 window from settings (9-18): Fri 2026-01-09 17:30 PST -> Mon 09:00 = 30', () => {
    const w = { ...PACIFIC, endMinute: 1080 };
    expect(bm('2026-01-09T17:30:00-08:00', '2026-01-12T09:00:00-08:00', w)).toBe(30);
  });

  it('weekdays come from settings: a Saturday-only window counts Saturday and nothing else', () => {
    const w = { ...PACIFIC, days: [6] };
    expect(bm('2026-10-23T09:00:00-07:00', '2026-10-26T17:00:00-07:00', w)).toBe(480);
  });

  it('the zone comes from settings: the same instants in New York hours', () => {
    const w = { ...PACIFIC, timeZone: 'America/New_York' };
    // Mon 09:00 PDT = 12:00 EDT -> 17:00 EDT = 300.
    expect(bm('2026-10-26T09:00:00-07:00', '2026-10-26T23:00:00-07:00', w)).toBe(300);
  });
});

describe('transcribed production timestamps (A18-A20)', () => {
  it('A18 first response Thu 15:48 -> Fri 10:24 = 155.9 business min', () => {
    expect(bm(t(19).created_at, t(19).first_response_at!)).toBeCloseTo(155.9, 1);
  });

  it('A19 resolution Sat 18:38 -> Wed 09:25 = 985.99 business min', () => {
    expect(bm(t(21).created_at, t(21).resolved_at!)).toBeCloseTo(985.99, 1);
  });

  it('A20 first response Thu 18:45 -> Tue 09:03 = 963.93 business min', () => {
    expect(bm(t(14).created_at, t(14).first_response_at!)).toBeCloseTo(963.93, 1);
  });
});

describe('zone handling', () => {
  it('zonedToUtc follows DST: 09:00 Pacific is 17:00Z in winter and 16:00Z in summer', () => {
    expect(new Date(zonedToUtc(2026, 1, 12, 540, 'America/Los_Angeles')).toISOString()).toBe('2026-01-12T17:00:00.000Z');
    expect(new Date(zonedToUtc(2026, 7, 13, 540, 'America/Los_Angeles')).toISOString()).toBe('2026-07-13T16:00:00.000Z');
  });

  it('an unknown zone is rejected; a known one is accepted', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});

describe('performance (shared day calendar)', () => {
  // BACKLOG-4086: this used to assert a 500 ms wall-clock budget, which flaked
  // under load. It now asserts the property that makes the clock cheap: each
  // local day's bounds are computed once and reused, so the work is bounded by
  // the number of distinct days touched, not by tickets x days.
  it('1000 tickets each spanning 365 days compute each calendar day once', () => {
    const c = cal();
    const start = Date.parse('2025-10-01T10:00:00-07:00');
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    let sum = 0;
    try {
      for (let i = 0; i < 1000; i += 1) {
        const a = start + i * 60000;
        sum += businessMinutes(a, a + 365 * 86400000, c);
      }
      expect(sum).toBeGreaterThan(0);
      // Distinct days touched: ~366 (365-day span, shifted by under 17 hours).
      expect(c.days.size).toBeGreaterThanOrEqual(365);
      expect(c.days.size).toBeLessThanOrEqual(370);
      // Per-day cost is 4 formatToParts calls (open + close, 2 correction
      // passes each); plus 1 per businessMinutes call for the start date.
      // Uncached it would be 1000 x ~366 x 4 = ~1.46M calls.
      const bound = c.days.size * 4 + 1000;
      expect(spy.mock.calls.length).toBeLessThanOrEqual(bound);
    } finally {
      spy.mockRestore();
    }
  });
});
