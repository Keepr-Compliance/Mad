/**
 * Analytics report — period resolution and URL (BACKLOG-3723)
 *
 * Founder decisions (BACKLOG-3723, 2026-10-31):
 *   - the period drives the Active Users and Active Devices tiles and the
 *     app-version section, nothing else;
 *   - presets 24h / 7d / 30d / 90d plus All time, and NO custom range. The
 *     database keeps only when each device was LAST seen, so "active between
 *     two dates" cannot be answered honestly. A `period=custom` URL — even with
 *     valid `from`/`to` — resolves to the default, 30 days.
 *
 * The URL values are the ones the page has always used (`1`, `7`, `30`, `90`),
 * plus `all`, so old links (including those through the /dashboard/analytics
 * redirect) keep working. The default `30` is dropped from the URL.
 *
 * Presets are ROLLING: `now - N x 24h`. Like the old query, the window has a
 * lower bound only (`last_seen_at >= from`); All time has none.
 *
 * Deliberately NOT built on `resolveFunnelPeriod`: that resolver returns a
 * real custom range, which here would window `last_seen_at` by dates.
 */

import { buildFunnelPeriodUrl } from './funnel-period';

export type AnalyticsPeriodKey = '1' | '7' | '30' | '90' | 'all';

export interface AnalyticsPeriod {
  key: AnalyticsPeriodKey;
  /** Inclusive lower bound on `last_seen_at`, ISO-8601 UTC; null = All time. */
  fromIso: string | null;
  /** What the caption says this period is. */
  label: string;
}

export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriodKey = '30';

export const ANALYTICS_PERIOD_OPTIONS: { value: AnalyticsPeriodKey; label: string }[] = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: 'all', label: 'All time' },
];

const PRESET_DAYS: Record<Exclude<AnalyticsPeriodKey, 'all'>, number> = { '1': 1, '7': 7, '30': 30, '90': 90 };

const PRESET_LABELS: Record<Exclude<AnalyticsPeriodKey, 'all'>, string> = {
  '1': 'Last 24 hours',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
};

const VALID_KEYS = new Set<string>(ANALYTICS_PERIOD_OPTIONS.map((o) => o.value));

const MS_PER_DAY = 86_400_000;

/** Resolve the period a request asks for; anything unknown (incl. `custom`) is 30d. */
export function resolveAnalyticsPeriod(params: { period?: string }, now: Date): AnalyticsPeriod {
  const key =
    params.period && VALID_KEYS.has(params.period) ? (params.period as AnalyticsPeriodKey) : DEFAULT_ANALYTICS_PERIOD;
  if (key === 'all') return { key, fromIso: null, label: 'All time' };
  return {
    key,
    fromIso: new Date(now.getTime() - PRESET_DAYS[key] * MS_PER_DAY).toISOString(),
    label: PRESET_LABELS[key],
  };
}

/** The URL a period change navigates to: keeps other params, drops `30`, never sets from/to. */
export function buildAnalyticsPeriodUrl(current: URLSearchParams | string, period: AnalyticsPeriodKey): string {
  return buildFunnelPeriodUrl(current, period);
}
