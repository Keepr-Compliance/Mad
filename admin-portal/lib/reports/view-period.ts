/**
 * The time range a saved view stores (BACKLOG-4084)
 *
 * PURE. Kept inside the view's existing `filters` blob as
 * `period: { key, from?, to? }`; no column of its own.
 *
 * A preset is stored as its KEY, never as resolved bounds: "This week" saved
 * on a Monday must still mean this week next month. Only a custom range stores
 * dates, as the `YYYY-MM-DD` strings the URL already carries.
 *
 * Capture it from the SERVER-resolved period the page was rendered with
 * (`period.key`, `period.customFrom`, `period.customTo`), not from the picker:
 * a custom range that is half picked has fired nothing yet.
 *
 * Each report has its own key set. Reading a stored period back checks it
 * against that set; anything else reads as "no period", and applying the view
 * then keeps the page's period.
 */

import { ANALYTICS_PERIOD_OPTIONS } from './analytics-period';
import { FUNNEL_PERIOD_OPTIONS } from './funnel-period';
import { isValidDateInput, PERIOD_OPTIONS } from './period';

export interface StoredViewPeriod {
  key: string;
  /** Custom range only, `YYYY-MM-DD`. */
  from?: string;
  /** Custom range only, `YYYY-MM-DD`, inclusive. */
  to?: string;
}

/** Which period keys a report accepts, and whether it has a custom range. */
export interface ViewPeriodSpec {
  keys: readonly string[];
  custom: boolean;
}

/** The shared reports: iPhone sync, Exports, User activity, Submissions, Google Messages sync, Support SLA. */
export const SHARED_VIEW_PERIODS: ViewPeriodSpec = {
  keys: PERIOD_OPTIONS.map((o) => o.value).filter((k) => k !== 'custom'),
  custom: true,
};

/** Paywall Funnel. */
export const FUNNEL_VIEW_PERIODS: ViewPeriodSpec = {
  keys: FUNNEL_PERIOD_OPTIONS.map((o) => o.value).filter((k) => k !== 'custom'),
  custom: true,
};

/** Analytics: presets and All time, no custom range. */
export const ANALYTICS_VIEW_PERIODS: ViewPeriodSpec = {
  keys: ANALYTICS_PERIOD_OPTIONS.map((o) => o.value),
  custom: false,
};

/** The subset of a resolved period a view stores. Every report's period type has these three fields. */
export interface ResolvedPeriodLike {
  key: string;
  customFrom?: string | null;
  customTo?: string | null;
}

/** What goes into `filters.period`. */
export function serializeViewPeriod(period: ResolvedPeriodLike): StoredViewPeriod {
  if (period.key === 'custom' && period.customFrom && period.customTo) {
    return { key: 'custom', from: period.customFrom, to: period.customTo };
  }
  return { key: period.key };
}

/**
 * Read `filters.period` back. Null when there is none, or when it is not one
 * of this report's periods: an unknown key, a custom range on a report without
 * one, a malformed or reversed custom date.
 */
export function parseViewPeriod(raw: unknown, spec: ViewPeriodSpec): StoredViewPeriod | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const blob = raw as Record<string, unknown>;
  const key = blob.key;
  if (typeof key !== 'string') return null;

  if (key === 'custom') {
    if (!spec.custom) return null;
    const { from, to } = blob;
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    if (!isValidDateInput(from) || !isValidDateInput(to)) return null;
    if (from > to) return null;
    return { key, from, to };
  }

  return spec.keys.includes(key) ? { key } : null;
}

/** The URL params a stored period stands for, as each report's resolver reads them. */
export function viewPeriodParams(period: StoredViewPeriod): { period: string; from?: string; to?: string } {
  return period.key === 'custom' ? { period: 'custom', from: period.from, to: period.to } : { period: period.key };
}

/** Is the page showing this stored period? A view with no period matches any. */
export function viewPeriodMatches(stored: StoredViewPeriod | null, current: ResolvedPeriodLike): boolean {
  if (stored === null) return true;
  if (stored.key !== current.key) return false;
  if (stored.key !== 'custom') return true;
  return stored.from === current.customFrom && stored.to === current.customTo;
}
