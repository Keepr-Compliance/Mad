/**
 * Report period resolution (BACKLOG-3450)
 *
 * A pure function of `(searchParams, now)`. `now` is injected so the boundaries
 * can be asserted exactly rather than measured against the wall clock.
 *
 * EVERY BOUNDARY IS UTC. The report renders every timestamp with `formatUtc`
 * and never `toLocaleString`, and mixing a local-time bucket into a UTC-rendered
 * page is how a run lands in the wrong day. Weeks start MONDAY (PM ruling on
 * BACKLOG-3450 Q6).
 *
 * `toIso` is EXCLUSIVE — half-open `[from, to)` — so a run on the boundary is
 * counted in exactly one period. The user-facing custom `to=YYYY-MM-DD` means
 * "include that whole day", so it resolves to the following midnight.
 */

export type PeriodKey = '24h' | '48h' | 'week' | 'last-week' | 'month' | 'last-month' | 'custom';

export interface PeriodRange {
  key: PeriodKey;
  /** Inclusive lower bound, ISO-8601 UTC. */
  fromIso: string;
  /** EXCLUSIVE upper bound, ISO-8601 UTC. */
  toIso: string;
  /** What the caption says this period is. */
  label: string;
  /** Echoed back for the custom date inputs; null for every preset. */
  customFrom: string | null;
  customTo: string | null;
}

export const DEFAULT_PERIOD: PeriodKey = 'week';

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 48 hours' },
  { value: 'week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'custom', label: 'Custom range' },
];

const VALID_KEYS = new Set<string>(PERIOD_OPTIONS.map((o) => o.value));

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * `YYYY-MM-DD` and nothing else. This string reaches a database query, so an
 * unvalidated one is the thing to not write: anything that is not exactly ten
 * characters of the right shape AND a real calendar date falls back to the
 * default period rather than being passed through.
 */
export function isValidDateInput(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  // Rejects 2026-02-31, which `Date.parse` happily rolls forward in some engines.
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** Midnight UTC at the start of the day `date` falls in. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Midnight UTC on the MONDAY of the week `date` falls in. */
function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  // getUTCDay: Sunday 0 … Saturday 6. Monday-start means Sunday is 6 days in.
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * MS_PER_DAY);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** "Sep 14" — the chart's and the caption's day format, fixed UTC. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDayLabel(dayIso: string): string {
  const [, month, day] = dayIso.split('-');
  const monthIndex = Number(month) - 1;
  if (!MONTHS[monthIndex] || !day) return dayIso;
  return `${MONTHS[monthIndex]} ${Number(day)}`;
}

function range(key: PeriodKey, from: Date, to: Date, label: string): PeriodRange {
  return {
    key,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    label,
    customFrom: null,
    customTo: null,
  };
}

/**
 * Resolve the period a request asks for.
 *
 * An unknown key, a malformed custom date or a reversed custom range all fall
 * back to the default rather than throwing — this runs on a page whose whole
 * job is to be readable when something is broken.
 */
export function resolvePeriod(
  params: { period?: string; from?: string; to?: string },
  now: Date
): PeriodRange {
  const requested = params.period && VALID_KEYS.has(params.period) ? (params.period as PeriodKey) : DEFAULT_PERIOD;

  if (requested === 'custom') {
    const { from, to } = params;
    if (isValidDateInput(from) && isValidDateInput(to)) {
      const fromDate = new Date(`${from}T00:00:00.000Z`);
      // The user means "include the whole of `to`", so the exclusive bound is
      // the following midnight.
      const toDate = new Date(Date.parse(`${to}T00:00:00.000Z`) + MS_PER_DAY);
      if (toDate.getTime() > fromDate.getTime()) {
        return {
          key: 'custom',
          fromIso: fromDate.toISOString(),
          toIso: toDate.toISOString(),
          label: `${formatDayLabel(from)} to ${formatDayLabel(to)}`,
          customFrom: from,
          customTo: to,
        };
      }
    }
    return resolvePeriod({ period: DEFAULT_PERIOD }, now);
  }

  switch (requested) {
    case '24h':
      return range('24h', new Date(now.getTime() - 24 * MS_PER_HOUR), now, 'Last 24 hours');
    case '48h':
      return range('48h', new Date(now.getTime() - 48 * MS_PER_HOUR), now, 'Last 48 hours');
    case 'last-week': {
      const thisWeek = startOfUtcWeek(now);
      const lastWeek = new Date(thisWeek.getTime() - 7 * MS_PER_DAY);
      return range('last-week', lastWeek, thisWeek, 'Last week');
    }
    case 'month':
      return range('month', startOfUtcMonth(now), now, 'This month');
    case 'last-month': {
      const thisMonth = startOfUtcMonth(now);
      const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1));
      return range('last-month', lastMonth, thisMonth, 'Last month');
    }
    case 'week':
    default:
      return range('week', startOfUtcWeek(now), now, 'This week');
  }
}

/**
 * Every UTC day the range covers, as `YYYY-MM-DD`, INCLUDING days with no runs.
 *
 * `toIso` is exclusive, so the last day is the one containing `toIso - 1 ms`.
 * A run at exactly `toIso` belongs to the next period and must not add a day.
 */
export function daysInRange(range: PeriodRange): string[] {
  const start = Date.parse(range.fromIso);
  const end = Date.parse(range.toIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return [];
  const firstDay = startOfUtcDay(new Date(start)).getTime();
  const lastDay = startOfUtcDay(new Date(end - 1)).getTime();
  const out: string[] = [];
  for (let t = firstDay; t <= lastDay; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
