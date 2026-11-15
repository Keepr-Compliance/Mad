/** @jest-environment node */
import { formatCaptureDate } from '@/lib/domain/captureCopy';

describe('formatCaptureDate', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it('shows the UTC date for an instant just after midnight UTC, in any process time zone', () => {
    const iso = '2026-11-25T00:00:30.000Z';
    const out: string[] = [];
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      out.push(formatCaptureDate(iso));
    }
    expect(out).toEqual(['Nov 25, 2026', 'Nov 25, 2026', 'Nov 25, 2026']);
  });

  it('shows the UTC date for an instant just before midnight UTC, in any process time zone', () => {
    const iso = '2026-11-24T23:59:30.000Z';
    const out: string[] = [];
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      out.push(formatCaptureDate(iso));
    }
    expect(out).toEqual(['Nov 24, 2026', 'Nov 24, 2026', 'Nov 24, 2026']);
  });

  it('returns the input when it is not a date', () => {
    expect(formatCaptureDate('not a date')).toBe('not a date');
  });
});
