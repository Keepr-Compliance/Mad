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
 * Mounted by the Submissions report (BACKLOG-3513 PR-3a,
 * components/reports/submissions/SubmissionsReportFilters.tsx).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, SavedViews, type SaveViewOptions } from '@keepr/ui';
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
  /** The saved-views key. Default: the report's slug. A shared report passes 'd-<id>' (BACKLOG-3513 PR-3b). */
  reportKey?: string;
}

export function droppedNotice(dropped: string[]): string | null {
  if (dropped.length === 0) return null;
  return `Parts of this view no longer exist in the report and were skipped: ${dropped.join(', ')}.`;
}

export function ReportSavedViews({ orgId, report, current, onApply, onClear, api, reportKey }: ReportSavedViewsProps) {
  const spec = report.savedView;
  const viewsApi = useMemo<BrokerViewsApi | undefined>(
    () => (spec ? (api ?? createBrokerViewsApi(orgId, spec)) : undefined),
    [api, orgId, spec]
  );
  const saved = useReportSavedViews<BrokerSavedView, ViewState, ViewMetric | null>(viewsApi, reportKey ?? report.slug);
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
            <div className="w-48">
              {/*
               * The kit Dropdown, not the kit Select (BACKLOG-3513 PR-3c): the Select's list renders in a
               * portal outside this panel, and the panel closes when focus leaves it, so a Select here would
               * close the save form on open. The Dropdown's list stays inside the panel.
               */}
              <Dropdown
                label="Card counts"
                options={spec.metricColumns.map((col) => ({ value: col, label: col }))}
                value={metricCol ?? null}
                onChange={setMetricCol}
                searchable={false}
              />
            </div>
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
