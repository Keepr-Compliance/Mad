'use client';

/**
 * Exports report — composition shell (BACKLOG-4004)
 *
 * THE ONE INVARIANT: the stat cards, the chart, the per-user table and the
 * per-organization table all read `filtered`, and every count in them comes
 * from `countExports`. Pinned view cards read the period's events with their
 * own saved filters instead, the same rule as iPhone Sync.
 */

import { useMemo, useState } from 'react';
import { SavedViews } from '@keepr/ui';
import type { PeriodRange } from '@/lib/reports/period';
import { buildPeriodUrl } from '@/lib/reports/report-url';
import type { ReportViewsApi } from '@/lib/reports/report-views-api';
import { useReportSavedViews } from '@/lib/reports/use-report-saved-views';
import { serializeViewPeriod, viewPeriodMatches } from '@/lib/reports/view-period';
import {
  activeFilterNames,
  applyExportFilters,
  bucketExportsByDay,
  countByFormat,
  countExports,
  countUsers,
  defaultDirection,
  EMPTY_EXPORT_FILTERS,
  formatLabel,
  groupByOrg,
  groupByUser,
  hasActiveFilters,
  INITIAL_VISIBLE_ROWS,
  SHOW_MORE_STEP,
  sortOrgRows,
  sortUserRows,
  type ExportFilters,
  type ExportOrgSortKey,
  type ExportsReportModel,
  type ExportUserSortKey,
  type SortDirection,
} from '@/lib/reports/exports';
import {
  describeExportMetric,
  EXPORT_FALLBACK_METRIC,
  EXPORT_METRIC_COLUMNS,
  EXPORT_METRIC_FUNCTIONS,
  exportCardValue,
  exportFunctionsFor,
  exportViewMatchesPage,
  exportViewMatchesState,
  EXPORTS_REPORT_KEY,
  formatExportMetricValue,
  serializeExportFilters,
  type ExportSavedView,
  type ExportViewMetric,
  type StoredExportFilters,
} from '@/lib/reports/exports-views';
import { MAX_PINNED } from '@/lib/reports/report-views';
import { MetricSaveFields } from '../iphone-sync/MetricSaveFields';
import { PinnedViewCards } from '../iphone-sync/PinnedViewCards';
import { ExportCharts } from './ExportCharts';
import { ExportFilterBar, type FilterOption } from './ExportFilterBar';
import { ExportOrgTable, ExportUserTable } from './ExportTables';
import { ExportsHowToUse } from './ExportsHowToUse';

export type ExportViewsApi = ReportViewsApi<ExportSavedView, StoredExportFilters, ExportViewMetric>;

export const EXPORTS_SAVE_HINT =
  'Saves the Organization, User, Format and search filters and the time range. A pinned card follows whichever period is selected.';

function Tile({ label, value, sub, testId }: { label: string; value: number; sub?: string; testId: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5" data-tile={testId}>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900" data-tile-value={testId}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-xs text-gray-500" data-tile-sub={testId}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

export interface ExportsReportProps {
  report: ExportsReportModel;
  period: PeriodRange;
  truncated?: boolean;
  rowCap: number;
  onNavigate?: (url: string) => void;
  viewsApi?: ExportViewsApi;
  /**
   * The default saved view the server opened the page with (bare URL only),
   * or null. Read ONCE, as the filters' initial state; never synced after.
   */
  initialView?: ExportSavedView | null;
}

function sortedOptions(map: Map<string, string>): FilterOption[] {
  return [...map.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function ExportsReport({
  report,
  period,
  truncated = false,
  rowCap,
  onNavigate,
  viewsApi,
  initialView = null,
}: ExportsReportProps) {
  const [filters, setFilters] = useState<ExportFilters>(() => initialView?.filters ?? EMPTY_EXPORT_FILTERS);
  const [userSortKey, setUserSortKey] = useState<ExportUserSortKey>('exports');
  const [userSortDirection, setUserSortDirection] = useState<SortDirection>('desc');
  const [orgSortKey, setOrgSortKey] = useState<ExportOrgSortKey>('exports');
  const [orgSortDirection, setOrgSortDirection] = useState<SortDirection>('desc');
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS);
  const [openUserKey, setOpenUserKey] = useState<string | null>(null);

  const savedViews = useReportSavedViews<ExportSavedView, StoredExportFilters, ExportViewMetric>(
    viewsApi,
    EXPORTS_REPORT_KEY
  );
  const views = savedViews.views;
  const [metric, setMetric] = useState<ExportViewMetric>(EXPORT_FALLBACK_METRIC);
  const [restoreFilters, setRestoreFilters] = useState<ExportFilters | null>(null);

  // THE shared set.
  const filtered = useMemo(() => applyExportFilters(report.events, filters), [report.events, filters]);
  const counts = useMemo(() => countExports(filtered), [filtered]);
  const users = useMemo(() => countUsers(filtered), [filtered]);
  const formats = useMemo(() => countByFormat(filtered), [filtered]);
  const buckets = useMemo(() => bucketExportsByDay(filtered, period), [filtered, period]);
  const userRows = useMemo(
    () => sortUserRows(groupByUser(filtered), userSortKey, userSortDirection),
    [filtered, userSortKey, userSortDirection]
  );
  const orgRows = useMemo(
    () => sortOrgRows(groupByOrg(filtered, report.orgNames), orgSortKey, orgSortDirection),
    [filtered, report.orgNames, orgSortKey, orgSortDirection]
  );
  const openEvents = useMemo(
    () => (openUserKey ? filtered.filter((e) => e.userKey === openUserKey) : []),
    [filtered, openUserKey]
  );

  // Options come from the period's events, so a format the code can send but
  // this period never saw does not appear, and one it did always does.
  const all = report.events;
  const orgOptions = sortedOptions(
    new Map(all.flatMap((e) => e.orgKeys.map((k) => [k, report.orgNames[k] ?? k] as const)))
  );
  const userOptions = sortedOptions(new Map(all.map((e) => [e.userKey, e.userLabel] as const)));
  const formatOptions = sortedOptions(new Map(all.map((e) => [e.format, formatLabel(e.format)] as const)));

  // ─── Saved views ───────────────────────────────────────────────
  const pinned = useMemo(() => (views ?? []).filter((v) => v.pinned).slice(0, MAX_PINNED), [views]);
  // A card applies its filters only and follows the page's period (SR ruling,
  // BACKLOG-4084); the Views list applies filters and time range.
  const cards = pinned.map((view) => ({
    view,
    value: exportCardValue(report.events, view),
    active: exportViewMatchesState(view, filters),
  }));
  const activeViewId = (views ?? []).find((v) => exportViewMatchesPage(v, filters, period))?.id ?? null;

  function updateFilters(next: ExportFilters) {
    setFilters(next);
    setVisibleCount(INITIAL_VISIBLE_ROWS);
    setOpenUserKey(null);
  }

  function applyViewFilters(view: ExportSavedView) {
    setRestoreFilters(filters);
    updateFilters(view.filters);
  }

  /** From the Views list: filters, and at most ONE navigation when the stored period differs. */
  function applyView(view: ExportSavedView) {
    applyViewFilters(view);
    const stored = view.period ?? null;
    if (stored === null || viewPeriodMatches(stored, period)) return;
    navigateToPeriod(stored.key, stored.from, stored.to);
  }

  /** As a card: its filters only; the period stays the page's. */
  function toggleCard(view: ExportSavedView) {
    if (!exportViewMatchesState(view, filters)) {
      applyViewFilters(view);
      return;
    }
    const back = restoreFilters ?? EMPTY_EXPORT_FILTERS;
    setRestoreFilters(null);
    updateFilters(back);
  }

  // Every save pins, as before; the kit refuses a sixth pin before calling.
  function saveCurrentView(name: string) {
    savedViews.save({
      name,
      filters: serializeExportFilters(filters, serializeViewPeriod(period)),
      metric,
      pinned: true,
    });
  }

  // Re-saves the view as stored, period included: only `pinned` changes.
  function togglePin(view: ExportSavedView) {
    savedViews.save({
      id: view.id,
      name: view.name,
      filters: serializeExportFilters(view.filters, view.period ?? null),
      metric: view.metric,
      pinned: !view.pinned,
    });
  }

  function handleUserSort(key: ExportUserSortKey) {
    if (key === userSortKey) setUserSortDirection(userSortDirection === 'asc' ? 'desc' : 'asc');
    else {
      setUserSortKey(key);
      setUserSortDirection(defaultDirection(key));
    }
  }

  function handleOrgSort(key: ExportOrgSortKey) {
    if (key === orgSortKey) setOrgSortDirection(orgSortDirection === 'asc' ? 'desc' : 'asc');
    else {
      setOrgSortKey(key);
      setOrgSortDirection(defaultDirection(key));
    }
  }

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildPeriodUrl(search, nextPeriod, from, to));
  }

  const filterNames = activeFilterNames(filters);
  const caption = `Cards, chart and tables follow the filters: ${period.label}${
    filterNames.length > 0 ? ` · ${filterNames.join(' · ')}` : ' · no other filters'
  }. Days are UTC.`;

  return (
    <div className="space-y-6">
      <ExportFilterBar
        period={period}
        filters={filters}
        orgOptions={orgOptions}
        userOptions={userOptions}
        formatOptions={formatOptions}
        hasFilters={hasActiveFilters(filters)}
        onPeriodChange={navigateToPeriod}
        onFiltersChange={updateFilters}
        onClear={() => updateFilters(EMPTY_EXPORT_FILTERS)}
        views={
          <SavedViews<ExportSavedView>
            views={views}
            loading={savedViews.loading}
            activeViewId={activeViewId}
            writeError={savedViews.writeError}
            onApply={applyView}
            onDelete={savedViews.remove}
            onSave={saveCurrentView}
            saveHint={EXPORTS_SAVE_HINT}
            defaultViewId={savedViews.defaultViewId}
            onSetDefault={savedViews.setDefault}
            pinning={{ max: MAX_PINNED, onTogglePin: togglePin }}
            saveFields={
              <MetricSaveFields
                value={metric}
                onChange={(next) => setMetric({ col: next.col as ExportViewMetric['col'], fn: 'count' })}
                columns={EXPORT_METRIC_COLUMNS}
                functions={EXPORT_METRIC_FUNCTIONS}
                functionsForColumn={exportFunctionsFor}
              />
            }
          />
        }
      />

      {report.lookupFailed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          User or organization names could not be read. Counts are correct; names show as Unknown.
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs text-gray-500">{caption}</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          <Tile testId="exports" label="Exports" value={counts.exports} sub="Every export, repeats included" />
          <Tile
            testId="unique"
            label="Unique exports"
            value={counts.unique}
            sub="Each user's deal once"
          />
          <Tile testId="users" label="Users who exported" value={users} />
          <Tile testId="pdf" label="PDF exports" value={formats.pdf.exports} sub={`${formats.pdf.unique} unique`} />
          <Tile
            testId="folder"
            label="Folder exports"
            value={formats.folder.exports}
            sub={`${formats.folder.unique} unique`}
          />
          {formats.other.exports > 0 ? (
            <Tile
              testId="other"
              label="Other formats"
              value={formats.other.exports}
              sub={`${formats.other.unique} unique`}
            />
          ) : null}
        </div>
      </div>

      <PinnedViewCards<ExportSavedView>
        cards={cards}
        periodLabel={period.label}
        onToggle={toggleCard}
        formatValue={(value) => formatExportMetricValue(value)}
        describeMetric={describeExportMetric}
      />

      <ExportCharts buckets={buckets} />

      <ExportUserTable
        rows={userRows}
        visibleCount={visibleCount}
        sortKey={userSortKey}
        sortDirection={userSortDirection}
        openUserKey={openUserKey}
        openEvents={openEvents}
        truncated={truncated}
        rowCap={rowCap}
        periodLabel={period.label}
        onSort={handleUserSort}
        onShowMore={() => setVisibleCount(visibleCount + SHOW_MORE_STEP)}
        onToggleUser={(key) => setOpenUserKey(openUserKey === key ? null : key)}
      />

      <ExportOrgTable
        rows={orgRows}
        sortKey={orgSortKey}
        sortDirection={orgSortDirection}
        onSort={handleOrgSort}
      />

      <ExportsHowToUse />
    </div>
  );
}
