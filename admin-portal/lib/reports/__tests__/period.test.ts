/**
 * Period resolution — boundary tests (BACKLOG-3450)
 *
 * `now` is injected on every case, so these assert exact ISO instants rather
 * than "roughly a week ago". The four things that decide whether a run lands in
 * the right period — Monday start, UTC, an EXCLUSIVE upper bound, and
 * `YYYY-MM-DD` validation on the custom inputs — each get their own case.
 */

import { describe, expect, it } from 'vitest';
import {
  daysInRange,
  formatDayLabel,
  isValidDateInput,
  resolvePeriod,
  type PeriodKey,
} from '../period';

/** Saturday 2026-09-19 22:07:00 UTC — the instant the plan was measured at. */
const NOW = new Date('2026-09-19T22:07:00.000Z');

describe('resolvePeriod', () => {
  it('defaults to this week, starting MONDAY, at midnight UTC', () => {
    const range = resolvePeriod({}, NOW);
    expect(range.key).toBe('week');
    // 2026-09-19 is a Saturday; the Monday of that week is 2026-09-14.
    expect(range.fromIso).toBe('2026-09-14T00:00:00.000Z');
    expect(range.toIso).toBe('2026-09-19T22:07:00.000Z');
  });

  it('starts the week on Monday even when now IS a Sunday', () => {
    // 2026-09-20 is the Sunday after NOW. Under a Sunday-start week it would be
    // day one; under Monday-start it is the last day of the week before.
    const sunday = new Date('2026-09-20T06:00:00.000Z');
    expect(resolvePeriod({ period: 'week' }, sunday).fromIso).toBe('2026-09-14T00:00:00.000Z');
  });

  it('starts the week on Monday when now IS a Monday', () => {
    const monday = new Date('2026-09-14T00:30:00.000Z');
    expect(resolvePeriod({ period: 'week' }, monday).fromIso).toBe('2026-09-14T00:00:00.000Z');
  });

  it('makes last week a closed Monday-to-Monday range', () => {
    const range = resolvePeriod({ period: 'last-week' }, NOW);
    expect(range.fromIso).toBe('2026-09-07T00:00:00.000Z');
    expect(range.toIso).toBe('2026-09-14T00:00:00.000Z');
  });

  it('resolves the rolling windows off `now`, not off midnight', () => {
    expect(resolvePeriod({ period: '24h' }, NOW).fromIso).toBe('2026-09-18T22:07:00.000Z');
    expect(resolvePeriod({ period: '48h' }, NOW).fromIso).toBe('2026-09-17T22:07:00.000Z');
  });

  it('resolves this month and last month on UTC calendar boundaries', () => {
    expect(resolvePeriod({ period: 'month' }, NOW).fromIso).toBe('2026-09-01T00:00:00.000Z');
    const last = resolvePeriod({ period: 'last-month' }, NOW);
    expect(last.fromIso).toBe('2026-08-01T00:00:00.000Z');
    expect(last.toIso).toBe('2026-09-01T00:00:00.000Z');
  });

  it('crosses the year boundary rather than landing in month -1', () => {
    const january = new Date('2026-01-09T12:00:00.000Z');
    const last = resolvePeriod({ period: 'last-month' }, january);
    expect(last.fromIso).toBe('2025-12-01T00:00:00.000Z');
    expect(last.toIso).toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats the custom `to` day as INCLUDED, so the bound is the next midnight', () => {
    const range = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-18' }, NOW);
    expect(range.key).toBe('custom');
    expect(range.fromIso).toBe('2026-09-01T00:00:00.000Z');
    expect(range.toIso).toBe('2026-09-19T00:00:00.000Z');
    expect(range.customFrom).toBe('2026-09-01');
    expect(range.customTo).toBe('2026-09-18');
  });

  it('falls back to the default rather than passing a malformed date to the query', () => {
    const malformed = [
      { period: 'custom', from: "2026-09-01' or 1=1--", to: '2026-09-18' },
      { period: 'custom', from: '2026-9-1', to: '2026-09-18' },
      { period: 'custom', from: '2026-02-31', to: '2026-09-18' },
      { period: 'custom', from: '2026-09-01' }, // no `to` at all
      { period: 'custom', from: '2026-09-18', to: '2026-09-01' }, // reversed
    ];
    for (const params of malformed) {
      const range = resolvePeriod(params, NOW);
      expect(range.key).toBe('week');
      expect(range.fromIso).toBe('2026-09-14T00:00:00.000Z');
      expect(range.customFrom).toBeNull();
    }
  });

  it('falls back to the default for an unknown period key', () => {
    expect(resolvePeriod({ period: 'all-time' }, NOW).key).toBe('week');
    expect(resolvePeriod({ period: '' }, NOW).key).toBe('week');
  });

  it('gives every preset a label the caption can name', () => {
    const keys: PeriodKey[] = ['24h', '48h', 'week', 'last-week', 'month', 'last-month'];
    for (const key of keys) {
      expect(resolvePeriod({ period: key }, NOW).label.length).toBeGreaterThan(0);
    }
  });
});

describe('isValidDateInput', () => {
  it('accepts exactly YYYY-MM-DD real calendar dates', () => {
    expect(isValidDateInput('2026-09-18')).toBe(true);
    expect(isValidDateInput('2024-02-29')).toBe(true); // a real leap day
  });

  it('rejects everything else', () => {
    for (const bad of ['2026-02-31', '2023-02-29', '2026-13-01', '2026-9-18', '2026-09-18T00:00:00Z', '', undefined, null]) {
      expect(isValidDateInput(bad as string)).toBe(false);
    }
  });
});

describe('daysInRange', () => {
  it('emits one entry per UTC day, INCLUDING days with no runs', () => {
    const days = daysInRange(resolvePeriod({}, NOW));
    expect(days).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ]);
  });

  it('does not add a day for the EXCLUSIVE upper bound', () => {
    // last-week ends at 2026-09-14T00:00:00Z exactly. A run at that instant
    // belongs to this week, so 09-14 must not appear here.
    const days = daysInRange(resolvePeriod({ period: 'last-week' }, NOW));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-09-07');
    expect(days[6]).toBe('2026-09-13');
    expect(days).not.toContain('2026-09-14');
  });

  it('covers a 30-day custom range end to end', () => {
    const days = daysInRange(
      resolvePeriod({ period: 'custom', from: '2026-08-20', to: '2026-09-18' }, NOW)
    );
    expect(days).toHaveLength(30);
    expect(days[0]).toBe('2026-08-20');
    expect(days[29]).toBe('2026-09-18');
  });
});

describe('formatDayLabel', () => {
  it('renders the mockup s "Sep 14" form with no leading zero', () => {
    expect(formatDayLabel('2026-09-14')).toBe('Sep 14');
    expect(formatDayLabel('2026-01-01')).toBe('Jan 1');
    expect(formatDayLabel('2026-12-31')).toBe('Dec 31');
  });
});
