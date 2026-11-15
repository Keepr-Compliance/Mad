/**
 * The stored form of a report's filters and sort — BACKLOG-3513.
 *
 * PURE types. A shared report definition (broker_report_definitions.definition,
 * migration 20261112200000) stores this shape; lib/reports/datasets/submissions-filters.ts
 * reads it back through the same parsers as the URL, so anything malformed falls back.
 *
 * Moved here from lib/reports/saved-views/degrade.ts when the personal saved-views panel
 * left the broker reports UI (BACKLOG-3513 PR-3c, founder ruling A).
 */

/** One filter's value. */
export type FilterValue = string | number | boolean | string[];

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
  key: string;
  direction: SortDirection;
}

/** A report's filters and sort. */
export interface ViewState {
  filters: Record<string, FilterValue>;
  sort: ViewSort | null;
}
