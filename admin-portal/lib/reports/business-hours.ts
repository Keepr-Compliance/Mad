/**
 * Business-hours clock (BACKLOG-4086)
 *
 * A PAUSING clock: `businessMinutes(a, b, calendar)` is the number of minutes
 * of [a, b) that fall inside a business window. A business window is
 * [start, end) local wall-clock time in `window.timeZone`, on a local day
 * whose weekday is in `window.days` (0 = Sunday, as `Date.getDay`). Outside
 * the window the clock stops and resumes at the next window's open.
 *
 * - Local time comes from `Intl.DateTimeFormat` with an explicit `timeZone`,
 *   never from the process's own getters, so the result does not depend on
 *   the server's TZ and follows daylight-saving changes in the target zone.
 * - Days are walked from the LOCAL date of `a` (not its UTC date).
 * - Each local day's open/close instants are computed once per
 *   `DayCalendar`, which the report builder creates once per build and shares
 *   across every ticket.
 * - Holidays are not excluded (no holiday calendar exists).
 */

export interface BusinessWindow {
  /** Minute of the local day the window opens (540 = 09:00). */
  startMinute: number;
  /** Minute of the local day the window closes, exclusive (1020 = 17:00). */
  endMinute: number;
  /** Local weekdays that have a window, 0 = Sunday ... 6 = Saturday. */
  days: readonly number[];
  /** IANA time zone, e.g. 'America/Los_Angeles'. */
  timeZone: string;
}

interface DayBounds {
  open: number;
  close: number;
  business: boolean;
}

export interface DayCalendar {
  window: BusinessWindow;
  /** Local day 'y-m-d' -> that day's window instants (epoch ms). */
  days: Map<string, DayBounds>;
}

const MS_PER_MINUTE = 60000;

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `Intl` knows the zone (an unknown zone throws RangeError). */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localParts(ms: number, timeZone: string): LocalParts {
  const out: LocalParts = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.m = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v === 24 ? 0 : v;
    else if (p.type === 'minute') out.mi = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

/** The UTC instant of local wall time (y-m-d, minuteOfDay) in `timeZone`. */
export function zonedToUtc(y: number, m: number, d: number, minuteOfDay: number, timeZone: string): number {
  const wanted = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let guess = wanted;
  // Two correction passes handle both DST transitions; a wall time in the
  // spring-forward gap resolves forward.
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(guess, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += wanted - asUtc;
  }
  return guess;
}

export function createDayCalendar(window: BusinessWindow): DayCalendar {
  return { window, days: new Map() };
}

function dayBounds(cal: DayCalendar, y: number, m: number, d: number): DayBounds {
  const key = `${y}-${m}-${d}`;
  let b = cal.days.get(key);
  if (!b) {
    const w = cal.window;
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    b = {
      open: zonedToUtc(y, m, d, w.startMinute, w.timeZone),
      close: zonedToUtc(y, m, d, w.endMinute, w.timeZone),
      business: w.days.includes(weekday),
    };
    cal.days.set(key, b);
  }
  return b;
}

/**
 * Business minutes in [a, b). `b <= a` -> 0. Accepts epoch ms or ISO strings.
 * Pass the same `DayCalendar` for many calls to reuse each day's bounds.
 */
export function businessMinutes(a: number | string, b: number | string, cal: DayCalendar): number {
  const start = typeof a === 'string' ? Date.parse(a) : a;
  const end = typeof b === 'string' ? Date.parse(b) : b;
  if (!(end > start)) return 0;
  const first = localParts(start, cal.window.timeZone);
  let y = first.y;
  let m = first.m;
  let d = first.d;
  let totalMs = 0;
  for (;;) {
    const day = dayBounds(cal, y, m, d);
    if (day.open >= end) break;
    if (day.business) {
      const lo = Math.max(start, day.open);
      const hi = Math.min(end, day.close);
      if (hi > lo) totalMs += hi - lo;
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return totalMs / MS_PER_MINUTE;
}
