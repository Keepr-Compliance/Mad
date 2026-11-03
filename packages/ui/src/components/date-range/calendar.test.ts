import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  endOfWeek,
  formatDayLong,
  formatRange,
  localToday,
  monthGrid,
  parseIso,
  startOfWeek,
  toIso,
  weekday,
  WEEK_STARTS_ON,
} from './calendar';

/** Every calendar day 2026-01-01 .. 2028-12-31 (a leap year included), built independently from Date.UTC. */
function everyDay(): string[] {
  const out: string[] = [];
  for (let ms = Date.UTC(2026, 0, 1); ms <= Date.UTC(2028, 11, 31); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

describe('calendar (C8 sweep)', () => {
  const days = everyDay();

  it('covers 1096 days (2028 is a leap year)', () => {
    expect(days).toHaveLength(365 + 365 + 366);
  });

  it('addDays(+1) / (-1) walk every day 2026-2028 exactly as Date.UTC does', () => {
    for (let i = 0; i < days.length - 1; i++) {
      expect(addDays(days[i], 1)).toBe(days[i + 1]);
      expect(addDays(days[i + 1], -1)).toBe(days[i]);
    }
  });

  it('parseIso / toIso round-trip every day, and weekday matches getUTCDay', () => {
    for (const day of days) {
      expect(toIso(parseIso(day)!)).toBe(day);
      expect(weekday(day)).toBe(new Date(`${day}T00:00:00Z`).getUTCDay());
    }
  });

  it('every month grid has 7 columns, starts on the week start, and holds each day once', () => {
    expect(WEEK_STARTS_ON).toBe(1);
    for (let y = 2026; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        for (const ws of [0, 1] as const) {
          const grid = monthGrid(toIso({ y, m, d: 1 }), ws);
          for (const week of grid) expect(week).toHaveLength(7);
          const cells = grid.flat().filter((c): c is string => c !== null);
          expect(cells).toHaveLength(daysInMonth(y, m));
          for (const week of grid) {
            const first = week.find((c) => c !== null)!;
            const index = week.indexOf(first);
            expect((weekday(first) - ws + 7) % 7).toBe(index);
          }
        }
      }
    }
  });

  it('startOfWeek / endOfWeek: Monday-first by default; Sunday-first when asked', () => {
    // 2026-10-01 is a Thursday.
    expect(startOfWeek('2026-10-01')).toBe('2026-09-28');
    expect(endOfWeek('2026-10-01')).toBe('2026-10-04');
    expect(startOfWeek('2026-10-01', 0)).toBe('2026-09-27');
    expect(endOfWeek('2026-10-01', 0)).toBe('2026-10-03');
    for (const day of days) {
      expect(weekday(startOfWeek(day))).toBe(1);
      expect(weekday(endOfWeek(day))).toBe(0);
    }
  });

  it('addMonths clamps to the month end; addYears clamps Feb 29', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2027-01-15', -1)).toBe('2026-12-15');
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
    expect(addYears('2028-02-29', -1)).toBe('2027-02-28');
    expect(addYears('2028-02-29', 4)).toBe('2032-02-29');
  });

  it('parseIso rejects impossible and malformed days', () => {
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-4-1', '', 'x']) {
      expect(parseIso(bad)).toBeNull();
    }
    expect(parseIso('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 });
  });

  it('formats a cell name, a range, a cross-year range and a one-day range', () => {
    expect(formatDayLong('2026-10-01')).toBe('Thursday, October 1, 2026');
    expect(formatRange('2026-10-01', '2026-10-20')).toBe('Oct 1 – Oct 20, 2026');
    expect(formatRange('2025-12-20', '2026-01-05')).toBe('Dec 20, 2025 – Jan 5, 2026');
    expect(formatRange('2026-10-01', '2026-10-01')).toBe('Oct 1, 2026');
  });

  it('localToday reads the local calendar day', () => {
    expect(localToday(new Date(2026, 9, 1, 23, 30))).toBe('2026-10-01');
    expect(localToday(new Date(2026, 9, 1, 0, 5))).toBe('2026-10-01');
  });
});
