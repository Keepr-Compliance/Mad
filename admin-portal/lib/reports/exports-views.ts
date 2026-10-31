/**
 * Exports report — saved views and pinned cards (BACKLOG-4004)
 *
 * PURE. The same `report_saved_views` table and RPCs as iPhone Sync, under
 * its own report key, with its own filters blob and metric columns.
 *
 * The stored blob holds organization ids, user ids, formats and the search
 * text. No names, no emails.
 */

import {
  applyExportFilters,
  countExports,
  countUsers,
  EMPTY_EXPORT_FILTERS,
  SEARCH_MAX,
  type ExportEvent,
  type ExportFilters,
} from './exports';

export const EXPORTS_REPORT_KEY = 'exports';

export type ExportMetricColumn = 'exports' | 'unique' | 'users';

export interface ExportViewMetric {
  col: ExportMetricColumn;
  fn: 'count';
}

export const EXPORT_METRIC_COLUMNS: { value: ExportMetricColumn; label: string }[] = [
  { value: 'exports', label: 'Exports' },
  { value: 'unique', label: 'Unique exports' },
  { value: 'users', label: 'Users who exported' },
];

export const EXPORT_METRIC_FUNCTIONS: { value: 'count'; label: string }[] = [
  { value: 'count', label: 'count' },
];

/** Every column is a count. */
export function exportFunctionsFor(): string[] {
  return ['count'];
}

export const EXPORT_FALLBACK_METRIC: ExportViewMetric = { col: 'exports', fn: 'count' };

export interface StoredExportFilters {
  orgs: string[];
  users: string[];
  formats: string[];
  search: string;
}

export function serializeExportFilters(f: ExportFilters): StoredExportFilters {
  return {
    orgs: [...f.orgs],
    users: [...f.users],
    formats: [...f.formats],
    search: f.search.trim().slice(0, SEARCH_MAX),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

/** Read a stored blob back defensively. Anything unexpected becomes "no filter". */
export function parseExportFilters(raw: unknown): ExportFilters {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_EXPORT_FILTERS };
  const blob = raw as Record<string, unknown>;
  return {
    orgs: stringList(blob.orgs),
    users: stringList(blob.users),
    formats: stringList(blob.formats),
    search: typeof blob.search === 'string' ? blob.search.slice(0, SEARCH_MAX) : '',
  };
}

export function parseExportMetric(raw: unknown): ExportViewMetric {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ...EXPORT_FALLBACK_METRIC };
  const col = EXPORT_METRIC_COLUMNS.find((c) => c.value === (raw as Record<string, unknown>).col)?.value;
  return col ? { col, fn: 'count' } : { ...EXPORT_FALLBACK_METRIC };
}

export interface ExportSavedView {
  id: string;
  name: string;
  filters: ExportFilters;
  metric: ExportViewMetric;
  pinned: boolean;
  /** BACKLOG-4084. False when the row has no `is_default` (migration not applied). */
  isDefault: boolean;
}

export function parseExportSavedView(raw: unknown): ExportSavedView | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
    filters: parseExportFilters(row.filters),
    metric: parseExportMetric(row.metric),
    pinned: row.pinned === true,
    isDefault: row.is_default === true,
  };
}

export function parseExportSavedViews(raw: unknown): ExportSavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseExportSavedView).filter((v): v is ExportSavedView => v !== null);
}

export function computeExportMetric(events: ExportEvent[], metric: ExportViewMetric): number {
  if (metric.col === 'users') return countUsers(events);
  const counts = countExports(events);
  return metric.col === 'unique' ? counts.unique : counts.exports;
}

/**
 * A pinned card's value over THE PERIOD'S EVENTS with the card's OWN filters —
 * never the page's current filters.
 */
export function exportCardValue(events: ExportEvent[], view: ExportSavedView): number {
  return computeExportMetric(applyExportFilters(events, view.filters), view.metric);
}

export function formatExportMetricValue(value: number | null): string {
  return value == null || Number.isNaN(value) ? '—' : Math.round(value).toLocaleString('en-US');
}

export function describeExportMetric(view: ExportSavedView): string {
  const label = EXPORT_METRIC_COLUMNS.find((c) => c.value === view.metric.col)?.label ?? view.metric.col;
  return `count · ${label}`;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

export function exportViewMatchesState(view: ExportSavedView, f: ExportFilters): boolean {
  return (
    sameSet(view.filters.orgs, f.orgs) &&
    sameSet(view.filters.users, f.users) &&
    sameSet(view.filters.formats, f.formats) &&
    view.filters.search.trim() === f.search.trim()
  );
}
