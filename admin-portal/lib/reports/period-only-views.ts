/**
 * Saved views on the reports that have only a time range (BACKLOG-4084 PR F)
 *
 * PURE. No browser client here, so the server pages and the tests can import it.
 * Paywall Funnel, Analytics and Support SLA have no filters besides the period,
 * so a view stores the time range alone: `filters: { period }` (view-period.ts).
 * The same `report_saved_views` table and RPCs as the other reports, each under
 * its own report key (the report's registry slug).
 *
 * Each report checks a stored period against ITS OWN key set: a Funnel view
 * holding `week` (a shared-report key) or an Analytics view holding `custom`
 * (Analytics has no custom range) reads as "no period". A view with no
 * readable period is never shown as the active view and applying it changes
 * nothing; `viewPeriodMatches(null, …)` is true by design for reports whose
 * filters disambiguate, which these reports do not have.
 *
 * No pinned cards here, so every view saves a fixed count metric (the RPC
 * requires one) and `pinned: false`.
 */

import { hasExplicitState, resolveInitialView, type SearchParamsLike } from './default-view';
import {
  ANALYTICS_VIEW_PERIODS,
  FUNNEL_VIEW_PERIODS,
  parseViewPeriod,
  serializeViewPeriod,
  SHARED_VIEW_PERIODS,
  viewPeriodMatches,
  viewPeriodParams,
  type ResolvedPeriodLike,
  type StoredViewPeriod,
  type ViewPeriodSpec,
} from './view-period';

/** Report keys = the reports' registry slugs (lib/reports/registry.ts). */
export const FUNNEL_REPORT_KEY = 'funnel';
export const ANALYTICS_REPORT_KEY = 'analytics';
export const SUPPORT_SLA_REPORT_KEY = 'support-sla';

export const PERIOD_ONLY_SAVE_HINT = 'Saves the time range.';

export interface PeriodOnlyViewMetric {
  col: 'rows';
  fn: 'count';
}

/** No cards on these reports; the RPC still requires a metric. */
export const PERIOD_ONLY_VIEW_METRIC: PeriodOnlyViewMetric = {
  col: 'rows',
  fn: 'count',
};

/** What goes into `report_saved_views.filters`. */
export interface StoredPeriodOnlyFilters {
  period: StoredViewPeriod;
}

export interface PeriodOnlySavedView {
  id: string;
  name: string;
  /** Null when the row has no period this report accepts. */
  period: StoredViewPeriod | null;
  isDefault: boolean;
}

/** The period params a page resolves from. */
export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

export interface PeriodOnlyViews {
  reportKey: string;
  spec: ViewPeriodSpec;
  serialize(period: ResolvedPeriodLike): StoredPeriodOnlyFilters;
  parseRows(raw: unknown): PeriodOnlySavedView[];
  /** Is the page showing this view? Never true for a view with no readable period. */
  isActive(view: PeriodOnlySavedView, period: ResolvedPeriodLike): boolean;
  /**
   * What the server page opens with. `listViews` is the raw RPC read; it is NOT
   * called when the URL is explicit, and a failure means "no default".
   */
  resolveInitial(
    params: SearchParamsLike,
    listViews: () => Promise<unknown>
  ): Promise<{
    initialView: PeriodOnlySavedView | null;
    periodInput: PeriodInput;
  }>;
}

function paramString(params: SearchParamsLike, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

export function createPeriodOnlyViews(reportKey: string, spec: ViewPeriodSpec): PeriodOnlyViews {
  function parseRow(raw: unknown): PeriodOnlySavedView | null {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0) return null;
    const blob =
      row.filters != null && typeof row.filters === 'object' && !Array.isArray(row.filters)
        ? (row.filters as Record<string, unknown>)
        : null;
    return {
      id: row.id,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
      period: parseViewPeriod(blob?.period, spec),
      isDefault: row.is_default === true,
    };
  }

  function parseRows(raw: unknown): PeriodOnlySavedView[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(parseRow).filter((v): v is PeriodOnlySavedView => v !== null);
  }

  return {
    reportKey,
    spec,
    serialize: (period) => ({ period: serializeViewPeriod(period) }),
    parseRows,
    isActive: (view, period) => view.period !== null && viewPeriodMatches(view.period, period),
    async resolveInitial(params, listViews) {
      const fromUrl: PeriodInput = {
        period: paramString(params, 'period'),
        from: paramString(params, 'from'),
        to: paramString(params, 'to'),
      };
      if (hasExplicitState(params)) return { initialView: null, periodInput: fromUrl };

      let views: PeriodOnlySavedView[] | null;
      try {
        views = parseRows(await listViews());
      } catch {
        views = null;
      }
      const initialView = resolveInitialView({ params, views });
      if (!initialView || !initialView.period) return { initialView: null, periodInput: fromUrl };
      return { initialView, periodInput: viewPeriodParams(initialView.period) };
    },
  };
}

export const funnelViews = createPeriodOnlyViews(FUNNEL_REPORT_KEY, FUNNEL_VIEW_PERIODS);
export const analyticsViews = createPeriodOnlyViews(ANALYTICS_REPORT_KEY, ANALYTICS_VIEW_PERIODS);
export const supportSlaViews = createPeriodOnlyViews(SUPPORT_SLA_REPORT_KEY, SHARED_VIEW_PERIODS);
