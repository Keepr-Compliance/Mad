/**
 * Exports report — days are UTC even on a Pacific machine (BACKLOG-4004)
 *
 * CI runs in UTC, where a local-time bucket is identical to a UTC one. This
 * file forces Pacific time so a bucket built with local dates goes red here.
 */

process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { bucketExportsByDay, buildExportsReport } from '../exports';
import { EXPORT_ROWS, LOOKUPS, PERIOD } from './exports.fixture';

describe('per-day buckets under America/Los_Angeles', () => {
  it('the timezone really is Pacific in this file (harness control)', () => {
    expect(new Date('2026-10-17T03:30:00.000Z').getDate()).toBe(16);
  });

  it('buckets by the UTC day, not the local one', () => {
    const { events } = buildExportsReport(EXPORT_ROWS, LOOKUPS);
    const byDay = new Map(bucketExportsByDay(events, PERIOD).map((b) => [b.dayIso, b.exports]));
    expect(byDay.get('2026-10-12')).toBe(1);
    expect(byDay.get('2026-10-16')).toBe(2);
    expect(byDay.get('2026-10-17')).toBe(2);
    expect([...byDay.values()].reduce((a, b) => a + b, 0)).toBe(events.length);
  });
});
