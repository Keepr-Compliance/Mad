'use client';

/**
 * The kit `SavedViews` props for a report that has only a time range
 * (BACKLOG-4084 PR F: Paywall Funnel, Analytics, Support SLA).
 *
 * Save stores the SERVER-resolved period the page was rendered with. Apply
 * navigates ONCE, and only when the view's period differs from the page's; a
 * view with no readable period changes nothing. The default view is resolved
 * by the server page on a bare URL, never here: nothing in this hook navigates
 * when the views load or the period changes.
 */

import { useMemo } from 'react';
import type { PeriodOnlyViewsApi } from './period-only-views-api';
import {
  PERIOD_ONLY_SAVE_HINT,
  PERIOD_ONLY_VIEW_METRIC,
  type PeriodOnlySavedView,
  type PeriodOnlyViews,
} from './period-only-views';
import { useReportSavedViews } from './use-report-saved-views';
import type { ResolvedPeriodLike } from './view-period';

export interface PeriodOnlySavedViewsProps {
  views: PeriodOnlySavedView[] | null;
  loading: boolean;
  activeViewId: string | null;
  writeError: string | null;
  onApply(view: PeriodOnlySavedView): void;
  onDelete(view: PeriodOnlySavedView): void;
  onSave(name: string): void;
  saveHint: string;
  defaultViewId: string | null;
  onSetDefault(view: PeriodOnlySavedView | null): void;
}

export function usePeriodOnlySavedViews(
  api: PeriodOnlyViewsApi | undefined,
  views: PeriodOnlyViews,
  period: ResolvedPeriodLike,
  navigateToPeriod: (key: string, from?: string, to?: string) => void
): PeriodOnlySavedViewsProps {
  const saved = useReportSavedViews(api, views.reportKey);

  const activeViewId = useMemo(
    () => (saved.views ?? []).find((v) => views.isActive(v, period))?.id ?? null,
    [saved.views, views, period]
  );

  function onApply(view: PeriodOnlySavedView) {
    if (view.period && !views.isActive(view, period)) {
      navigateToPeriod(view.period.key, view.period.from, view.period.to);
    }
  }

  function onSave(name: string) {
    saved.save({
      name,
      filters: views.serialize(period),
      metric: PERIOD_ONLY_VIEW_METRIC,
      pinned: false,
    });
  }

  return {
    views: saved.views,
    loading: saved.loading,
    activeViewId,
    writeError: saved.writeError,
    onApply,
    onDelete: saved.remove,
    onSave,
    saveHint: PERIOD_ONLY_SAVE_HINT,
    defaultViewId: saved.defaultViewId,
    onSetDefault: saved.setDefault,
  };
}
