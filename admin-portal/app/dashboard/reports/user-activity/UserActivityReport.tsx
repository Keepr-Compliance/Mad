'use client';

/**
 * User Activity report — composition shell (BACKLOG-3720)
 *
 * Owns the client state (filters, sort, rows shown) and composes the filter
 * bar, the notices, the cards and the table.
 *
 * THE ONE INVARIANT: the cards and the table read the same `filtered` rows,
 * and staff are never in those rows — so staff can never reach a card.
 */

import { useMemo, useState } from 'react';
import { FilterBar, FilterCaption, MultiSelect, PeriodPicker, StatCard, useSortState } from '@keepr/ui';
import { Search } from 'lucide-react';
import { PERIOD_OPTIONS, type PeriodKey, type PeriodRange } from '@/lib/reports/period';
import { buildPeriodUrl } from '@/lib/reports/report-url';
import {
  ACTIVE_DEFINITION,
  ACTIVE_DEVICES_DEFINITION,
  activeUserActivityFilterNames,
  applyUserActivityFilters,
  computeTotals,
  CREATED_DEFINITION,
  defaultUserActivityDirection,
  EMPTY_USER_ACTIVITY_FILTERS,
  hasActiveUserActivityFilters,
  INITIAL_VISIBLE_USERS,
  sortUserActivity,
  SUBMISSIONS_DEFINITION,
  USER_SHOW_MORE_STEP,
  type UserActivityFilters,
  type UserActivityReportModel,
  type UserActivitySortKey,
} from '@/lib/reports/user-activity';
import { UserActivityTable } from './UserActivityTable';

export const EVENTS_FAILED_TEXT =
  'The activity data could not be read. This is a query failure, not an empty table — the period columns below are not a true zero.';
export const LOOKUPS_FAILED_TEXT =
  'Some user, device or organization data could not be read. Rows or columns may be missing — they are not a true zero.';
export const STAFF_INCOMPLETE_TEXT =
  'Internal staff could not be identified for your role — staff may be included in the rows and cards.';

const INPUT_CLASS =
  'text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export interface UserActivityReportProps {
  report: UserActivityReportModel;
  period: PeriodRange;
  eventsFailed?: boolean;
  lookupsFailed?: boolean;
  truncated?: boolean;
  rowCap: number;
  staffExclusionIncomplete?: boolean;
  onNavigate?: (url: string) => void;
}

function Banner({ testId, children }: { testId: string; children: string }) {
  return (
    <div
      data-banner={testId}
      className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
    >
      {children}
    </div>
  );
}

export function UserActivityReport({
  report,
  period,
  eventsFailed = false,
  lookupsFailed = false,
  truncated = false,
  rowCap,
  staffExclusionIncomplete = false,
  onNavigate,
}: UserActivityReportProps) {
  const [filters, setFilters] = useState<UserActivityFilters>(EMPTY_USER_ACTIVITY_FILTERS);
  const { sortKey, sortDirection, onSort } = useSortState<UserActivitySortKey>({
    initialKey: 'lastSeen',
    initialDirection: 'desc',
    defaultDirectionFor: defaultUserActivityDirection,
  });
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_USERS);

  const filtered = useMemo(() => applyUserActivityFilters(report.rows, filters), [report.rows, filters]);
  const totals = useMemo(() => computeTotals(filtered), [filtered]);
  const tableRows = useMemo(
    () => sortUserActivity(filtered, sortKey, sortDirection),
    [filtered, sortKey, sortDirection]
  );

  const orgOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of report.rows) for (const o of r.orgNames) names.add(o);
    return [...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [report.rows]);

  function updateFilters(next: UserActivityFilters) {
    setFilters(next);
    setVisibleCount(INITIAL_VISIBLE_USERS);
  }

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildPeriodUrl(search, nextPeriod, from, to));
  }

  return (
    <div className="space-y-6">
      {eventsFailed ? <Banner testId="events-failed">{EVENTS_FAILED_TEXT}</Banner> : null}
      {lookupsFailed ? <Banner testId="lookups-failed">{LOOKUPS_FAILED_TEXT}</Banner> : null}
      {staffExclusionIncomplete ? <Banner testId="staff-incomplete">{STAFF_INCOMPLETE_TEXT}</Banner> : null}

      <FilterBar
        hasFilters={hasActiveUserActivityFilters(filters)}
        onClear={() => updateFilters(EMPTY_USER_ACTIVITY_FILTERS)}
      >
        <PeriodPicker<PeriodKey>
          options={PERIOD_OPTIONS}
          value={period.key}
          customKey="custom"
          from={period.customFrom ?? undefined}
          to={period.customTo ?? undefined}
          onChange={navigateToPeriod}
        />
        <MultiSelect
          label="Organization"
          options={orgOptions}
          selected={filters.orgs}
          onChange={(orgs) => updateFilters({ ...filters, orgs })}
        />
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={filters.activeOnly}
            onChange={(e) => updateFilters({ ...filters, activeOnly: e.target.checked })}
          />
          Active in period only
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search by name or email"
            placeholder="Name or email"
            value={filters.search}
            onChange={(e) => updateFilters({ ...filters, search: e.target.value })}
            className={`${INPUT_CLASS} pl-8`}
          />
        </div>
      </FilterBar>

      <div>
        <FilterCaption
          className="mb-2 text-xs"
          lead="Cards and rows follow the filters"
          periodLabel={period.label}
          filterNames={activeUserActivityFilterNames(filters)}
        />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            data-tile="active-users"
            label="Users active in period"
            value={totals.activeUsers}
            subtitle={`${ACTIVE_DEFINITION} Of ${totals.users} listed.`}
            valueProps={{ 'data-tile-value': 'active-users' }}
          />
          <StatCard
            data-tile="created"
            label="Transactions created in period"
            value={totals.transactionsCreated}
            subtitle={CREATED_DEFINITION}
            valueProps={{ 'data-tile-value': 'created' }}
          />
          <StatCard
            data-tile="submissions"
            label="Submissions in period"
            value={totals.submissions}
            subtitle={SUBMISSIONS_DEFINITION}
            valueProps={{ 'data-tile-value': 'submissions' }}
          />
          <StatCard
            data-tile="active-devices"
            label="Active devices"
            value={totals.activeDevices}
            subtitle={ACTIVE_DEVICES_DEFINITION}
            valueProps={{ 'data-tile-value': 'active-devices' }}
          />
        </div>
      </div>

      <UserActivityTable
        rows={tableRows}
        visibleCount={visibleCount}
        sortKey={sortKey}
        sortDirection={sortDirection}
        truncated={truncated}
        rowCap={rowCap}
        periodLabel={period.label}
        showMoreStep={USER_SHOW_MORE_STEP}
        orphanEventCount={report.orphanEventCount}
        onSort={onSort}
        onShowMore={() => setVisibleCount(visibleCount + USER_SHOW_MORE_STEP)}
      />
    </div>
  );
}
