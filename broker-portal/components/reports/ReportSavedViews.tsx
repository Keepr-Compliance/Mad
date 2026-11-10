'use client';

/**
 * The Views panel of a broker report (BACKLOG-3514).
 *
 * Wires the kit `SavedViews` to the caller's PERSONAL views of one report in
 * one organization: save, apply, remove, a default that opens with the
 * report, and pinned cards (at most 5, each with a metric). No sharing: that
 * waits for BACKLOG-3513.
 *
 * Renders nothing for a report whose registry entry has no `savedView` spec.
 *
 * Applying a view hands the page ONLY the filter, sort and metric keys the
 * report still offers (degrade.ts strips the rest before the page queries).
 * When anything was stripped, a notice names it.
 *
 * Not mounted by any page yet: the first report that uses it arrives with
 * BACKLOG-3507.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { SavedViews, type SaveViewOptions } from '@keepr/ui';
import type { ReportDefinition } from '@/lib/reports/registry';
import { createBrokerViewsApi, type BrokerSavedView, type BrokerViewsApi } from '@/lib/reports/saved-views/broker-views-api';
import {
  serializeViewState,
  viewMatchesState,
  type DegradedView,
  type ViewMetric,
  type ViewState,
} from '@/lib/reports/saved-views/degrade';
import { useReportSavedViews } from '@/lib/reports/saved-views/use-report-saved-views';

export const MAX_PINNED = 5;

export const SAVE_HINT = 'Saves the filters and the sort order';

export interface ReportSavedViewsProps {
  /** The organization the page is showing. */
  orgId: string;
  report: ReportDefinition;
  /** The page's current filters and sort. */
  current: ViewState;
  /** Apply a view: its filters, sort and metric, already limited to what the report offers. */
  onApply: (view: DegradedView) => void;
  /** Reset the page to the report's built-in state. */
  onClear?: () => void;
  /** Tests inject a fake; the page leaves it out and gets the RPC adapter. */
  api?: BrokerViewsApi;
}

export function droppedNotice(dropped: string[]): string | null {
  if (dropped.length === 0) return null;
  return `Parts of this view no longer exist in the report and were skipped: ${dropped.join(', ')}.`;
}

export function ReportSavedViews({ orgId, report, current, onApply, onClear, api }: ReportSavedViewsProps) {
  const spec = report.savedView;
  const viewsApi = useMemo<BrokerViewsApi | undefined>(
    () => (spec ? (api ?? createBrokerViewsApi(orgId, spec)) : undefined),
    [api, orgId, spec]
  );
  const saved = useReportSavedViews<BrokerSavedView, ViewState, ViewMetric | null>(viewsApi, report.slug);
  const [notice, setNotice] = useState<string | null>(null);
  const firstColumn = spec?.metricColumns[0];
  const [metricCol, setMetricCol] = useState<string | undefined>(firstColumn);
  const appliedDefault = useRef(false);

  const apply = (view: BrokerSavedView) => {
    setNotice(droppedNotice(view.dropped));
    onApply({ filters: view.filters, sort: view.sort, metric: view.metric, dropped: view.dropped });
  };

  // The default view opens with the report, once.
  useEffect(() => {
    if (appliedDefault.current || !saved.views || !saved.defaultViewId) return;
    const view = saved.views.find((v) => v.id === saved.defaultViewId);
    if (!view) return;
    appliedDefault.current = true;
    apply(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the list first arrives
  }, [saved.views, saved.defaultViewId]);

  if (!spec) return null;

  const pinningAvailable = spec.metricColumns.length > 0;
  const activeViewId = (saved.views ?? []).find((v) => viewMatchesState(v, current))?.id ?? null;
  const metricFor = (view?: BrokerSavedView): ViewMetric | null =>
    view?.metric ?? (metricCol ? { col: metricCol, fn: 'count' } : null);

  const save = (name: string, options?: SaveViewOptions) => {
    const pin = Boolean(options?.pin) && pinningAvailable;
    saved.save({
      name,
      filters: serializeViewState(current, spec),
      metric: pinningAvailable ? metricFor() : null,
      pinned: pin,
    });
  };

  const togglePin = (view: BrokerSavedView) => {
    saved.save({
      id: view.id,
      name: view.name,
      filters: { filters: view.filters, sort: view.sort },
      metric: metricFor(view),
      pinned: !view.pinned,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <SavedViews<BrokerSavedView>
        views={saved.views}
        loading={saved.loading}
        activeViewId={activeViewId}
        writeError={saved.writeError}
        onApply={apply}
        onDelete={saved.remove}
        onSave={save}
        saveHint={SAVE_HINT}
        defaultViewId={saved.defaultViewId}
        onSetDefault={saved.setDefault}
        onClear={onClear}
        pinning={pinningAvailable ? { max: MAX_PINNED, onTogglePin: togglePin } : undefined}
        saveFields={
          pinningAvailable ? (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Card counts
              <select
                aria-label="Card column"
                value={metricCol}
                onChange={(e) => setMetricCol(e.target.value)}
                className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-gray-900"
              >
                {spec.metricColumns.map((col) => (
                  <option key={col} value={col}>
                    {col}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />
      {notice ? (
        <p role="status" data-testid="saved-view-dropped-notice" className="text-xs text-amber-700">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
