/**
 * Calendar-day arithmetic for DateRangePicker (BACKLOG-4032 slice 3).
 *
 * Every value is a `YYYY-MM-DD` calendar-day label. The reports read these as
 * UTC days (admin-portal lib/reports/period.ts), so all arithmetic here runs on
 * year / month / day through `Date.UTC` and `getUTC*`. Nothing builds a
 * local-midnight Date and calls `toISOString()` on it: east of UTC that turns
 * Oct 1 into "09-30".
 *
 * The one local read is `localToday()`: "today" is the user's calendar day.
 */

export type IsoDay = string;

export interface Ymd {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
}

/** 0 = Sunday ... 6 = Saturday, as `getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The reports' weeks start Monday (period.ts, PM ruling on BACKLOG-3450 Q6); the grid matches. */
export const WEEK_STARTS_ON: Weekday = 1;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toIso({ y, m, d }: Ymd): IsoDay {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Parse a real calendar day; null for anything else (incl. Feb 30). */
export function parseIso(value: string | undefined | null): Ymd | null {
  if (!value) return null;
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function isIsoDay(value: string | undefined | null): value is IsoDay {
  return parseIso(value) !== null;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fromUtcMs(ms: number): IsoDay {
  const date = new Date(ms);
  return toIso({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
}

function utcMs(iso: IsoDay): number {
  const p = parseIso(iso);
  if (!p) throw new Error(`not a calendar day: ${iso}`);
  return Date.UTC(p.y, p.m - 1, p.d);
}

export function addDays(iso: IsoDay, n: number): IsoDay {
  return fromUtcMs(utcMs(iso) + n * MS_PER_DAY);
}

/** Same day n months later, clamped to the month's last day (Jan 31 + 1 = Feb 28/29). */
export function addMonths(iso: IsoDay, n: number): IsoDay {
  const p = parseIso(iso)!;
  const index = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return toIso({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}

export function addYears(iso: IsoDay, n: number): IsoDay {
  return addMonths(iso, n * 12);
}

export function weekday(iso: IsoDay): Weekday {
  return new Date(utcMs(iso)).getUTCDay() as Weekday;
}

export function startOfWeek(iso: IsoDay, weekStartsOn: Weekday = WEEK_STARTS_ON): IsoDay {
  return addDays(iso, -((weekday(iso) - weekStartsOn + 7) % 7));
}

export function endOfWeek(iso: IsoDay, weekStartsOn: Weekday = WEEK_STARTS_ON): IsoDay {
  return addDays(startOfWeek(iso, weekStartsOn), 6);
}

/** First day of the month `iso` is in. */
export function monthOf(iso: IsoDay): IsoDay {
  return `${iso.slice(0, 7)}-01`;
}

/** `YYYY-MM` key of a month. */
export function monthKey(iso: IsoDay): string {
  return iso.slice(0, 7);
}

/**
 * The month's weeks, each 7 cells, starting on `weekStartsOn`. Cells outside
 * the month are null (rendered blank).
 */
export function monthGrid(monthStart: IsoDay, weekStartsOn: Weekday = WEEK_STARTS_ON): (IsoDay | null)[][] {
  const p = parseIso(monthStart)!;
  const total = daysInMonth(p.y, p.m);
  const lead = (weekday(toIso({ y: p.y, m: p.m, d: 1 })) - weekStartsOn + 7) % 7;
  const cells: (IsoDay | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= total; d++) cells.push(toIso({ y: p.y, m: p.m, d }));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (IsoDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The user's calendar day (local clock). */
export function localToday(now: Date = new Date()): IsoDay {
  return toIso({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Oct 1, 2026" */
export function formatDay(iso: IsoDay): string {
  const p = parseIso(iso)!;
  return `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "Thursday, October 1, 2026" — a day cell's accessible name. */
export function formatDayLong(iso: IsoDay): string {
  const p = parseIso(iso)!;
  return `${WEEKDAYS_LONG[weekday(iso)]}, ${MONTHS_LONG[p.m - 1]} ${p.d}, ${p.y}`;
}

/** "October 2026" */
export function formatMonth(iso: IsoDay): string {
  const p = parseIso(iso)!;
  return `${MONTHS_LONG[p.m - 1]} ${p.y}`;
}

/** "Oct 1 – Oct 20, 2026"; "Dec 20, 2025 – Jan 5, 2026"; one day: "Oct 1, 2026". */
export function formatRange(from: IsoDay, to: IsoDay): string {
  if (from === to) return formatDay(from);
  const a = parseIso(from)!;
  const b = parseIso(to)!;
  const left = a.y === b.y ? `${MONTHS_SHORT[a.m - 1]} ${a.d}` : formatDay(from);
  return `${left} – ${formatDay(to)}`;
}
