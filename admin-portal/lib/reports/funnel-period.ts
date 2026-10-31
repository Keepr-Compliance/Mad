/**
 * Paywall Funnel — period resolution and URL (BACKLOG-3722)
 *
 * The funnel keeps its OWN period set, not the shared report periods
 * (founder decision on BACKLOG-3722): 24h, 7d, 30d, 90d, All time, plus a
 * custom range. The URL values are the ones the funnel has always used —
 * `1`, `7`, `30`, `90`, `all` — so old bookmarks, including those that arrive
 * through the /dashboard/funnel redirect, keep working. The default is `30`
 * and is dropped from the URL.
 *
 * Presets are ROLLING: `now - N x 24h` up to `now`. All time has NO lower
 * bound. Every period has the upper bound `now` (exclusive), except custom,
 * whose `to=YYYY-MM-DD` means "include that whole day" and so resolves to the
 * following midnight UTC — the same half-open rule as lib/reports/period.ts.
 */

import { formatDayLabel, isValidDateInput } from './period';

export type FunnelPeriodKey = '1' | '7' | '30' | '90' | 'all' | 'custom';

export interface FunnelPeriod {
  key: FunnelPeriodKey;
  /** Inclusive lower bound, ISO-8601 UTC; null = no lower bound (All time). */
  fromIso: string | null;
  /** EXCLUSIVE upper bound, ISO-8601 UTC. */
  toIso: string;
  /** What the caption says this period is. */
  label: string;
  /** Echoed back for the custom range pill; null for every preset. */
  customFrom: string | null;
  customTo: string | null;
}

export const DEFAULT_FUNNEL_PERIOD: FunnelPeriodKey = '30';

export const FUNNEL_PERIOD_OPTIONS: { value: FunnelPeriodKey; label: string }[] = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

const PRESET_DAYS: Record<'1' | '7' | '30' | '90', number> = { '1': 1, '7': 7, '30': 30, '90': 90 };

const PRESET_LABELS: Record<'1' | '7' | '30' | '90', string> = {
  '1': 'Last 24 hours',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
};

const VALID_KEYS = new Set<string>(FUNNEL_PERIOD_OPTIONS.map((o) => o.value));

const MS_PER_DAY = 86_400_000;

function preset(key: '1' | '7' | '30' | '90', now: Date): FunnelPeriod {
  return {
    key,
    fromIso: new Date(now.getTime() - PRESET_DAYS[key] * MS_PER_DAY).toISOString(),
    toIso: now.toISOString(),
    label: PRESET_LABELS[key],
    customFrom: null,
    customTo: null,
  };
}

/**
 * Resolve the period a request asks for. An unknown key, a malformed custom
 * date or a reversed custom range all fall back to the default (30d).
 */
export function resolveFunnelPeriod(
  params: { period?: string; from?: string; to?: string },
  now: Date
): FunnelPeriod {
  const requested =
    params.period && VALID_KEYS.has(params.period) ? (params.period as FunnelPeriodKey) : DEFAULT_FUNNEL_PERIOD;

  if (requested === 'custom') {
    const { from, to } = params;
    if (isValidDateInput(from) && isValidDateInput(to)) {
      const fromMs = Date.parse(`${from}T00:00:00.000Z`);
      const toMs = Date.parse(`${to}T00:00:00.000Z`) + MS_PER_DAY;
      if (toMs > fromMs) {
        return {
          key: 'custom',
          fromIso: new Date(fromMs).toISOString(),
          toIso: new Date(toMs).toISOString(),
          label: `${formatDayLabel(from)} to ${formatDayLabel(to)}`,
          customFrom: from,
          customTo: to,
        };
      }
    }
    return preset(DEFAULT_FUNNEL_PERIOD as '30', now);
  }

  if (requested === 'all') {
    return { key: 'all', fromIso: null, toIso: now.toISOString(), label: 'All time', customFrom: null, customTo: null };
  }

  return preset(requested, now);
}

/**
 * The URL a period change navigates to. It COPIES the current params and
 * drops `period` at the funnel default (`30`), not the shared report default.
 */
export function buildFunnelPeriodUrl(
  current: URLSearchParams | string,
  period: string,
  from?: string,
  to?: string
): string {
  const params = new URLSearchParams(typeof current === 'string' ? current : current.toString());

  if (period === DEFAULT_FUNNEL_PERIOD) params.delete('period');
  else params.set('period', period);

  if (period === 'custom') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  } else {
    params.delete('from');
    params.delete('to');
  }

  const query = params.toString();
  return query.length > 0 ? `?${query}` : '?';
}
