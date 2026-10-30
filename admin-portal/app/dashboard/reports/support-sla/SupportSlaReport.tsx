'use client';

/**
 * Support SLA report — composition shell (BACKLOG-3721)
 *
 * Built from the @keepr/ui report kit: period picker in a filter bar, a
 * caption naming the period, stat cards, the truncation notice and a
 * sortable agent table. Every number comes from `buildSupportSlaReport`
 * (lib/reports/support-sla.ts); this file only lays it out.
 *
 * `report === null` means the ticket read failed: every value renders "-",
 * never "0".
 */

import { useMemo } from 'react';
import { CheckCircle2, Clock, Inbox, PlusCircle, Timer } from 'lucide-react';
import {
  FilterBar,
  FilterCaption,
  PeriodPicker,
  SortableTh,
  StatCard,
  TruncationNotice,
  useSortState,
  type SortDirection,
} from '@keepr/ui';
import { PERIOD_OPTIONS, type PeriodKey, type PeriodRange } from '@/lib/reports/period';
import { buildPeriodUrl } from '@/lib/reports/report-url';
import { formatDuration, type SupportSlaAgentRow, type SupportSlaReport as SupportSlaReportModel } from '@/lib/reports/support-sla';
import { SupportSlaHowToUse } from './SupportSlaHowToUse';

export type SupportSlaSortKey =
  | 'name'
  | 'openNow'
  | 'resolvedInPeriod'
  | 'avgFirstResponseMinutes'
  | 'avgResolutionMinutes';

export function defaultSupportSlaDirection(key: SupportSlaSortKey): SortDirection {
  return key === 'name' ? 'asc' : 'desc';
}

/** Missing averages sort last in either direction. */
export function sortAgentRows(
  rows: SupportSlaAgentRow[],
  key: SupportSlaSortKey,
  direction: SortDirection
): SupportSlaAgentRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * a.name.localeCompare(b.name);
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    return sign * (av - bv) || a.name.localeCompare(b.name);
  });
}

export interface SupportSlaReportProps {
  report: SupportSlaReportModel | null;
  period: PeriodRange;
  truncated?: boolean;
  rowCap: number;
  onNavigate?: (url: string) => void;
}

const COLUMNS: [SupportSlaSortKey, string][] = [
  ['name', 'Agent'],
  ['openNow', 'Open now'],
  ['resolvedInPeriod', 'Resolved'],
  ['avgFirstResponseMinutes', 'Avg first response'],
  ['avgResolutionMinutes', 'Avg resolution'],
];

export function SupportSlaReport({
  report,
  period,
  truncated = false,
  rowCap,
  onNavigate,
}: SupportSlaReportProps) {
  const { sortKey, sortDirection, onSort } = useSortState<SupportSlaSortKey>({
    initialKey: 'resolvedInPeriod',
    defaultDirectionFor: defaultSupportSlaDirection,
  });
  const agents = useMemo(
    () => (report ? sortAgentRows(report.agents, sortKey, sortDirection) : []),
    [report, sortKey, sortDirection]
  );

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildPeriodUrl(search, nextPeriod, from, to));
  }

  const s = report?.summary ?? null;
  const num = (v: number | undefined) => (s ? (v ?? 0) : '-');
  const dur = (v: number | null | undefined) => (s ? formatDuration(v ?? null) : '-');

  return (
    <div className="space-y-6">
      <FilterBar hasFilters={false} onClear={() => undefined}>
        <PeriodPicker<PeriodKey>
          options={PERIOD_OPTIONS}
          value={period.key}
          customKey="custom"
          from={period.customFrom ?? undefined}
          to={period.customTo ?? undefined}
          onChange={navigateToPeriod}
        />
      </FilterBar>

      <SupportSlaHowToUse />

      {truncated ? (
        <TruncationNotice
          noun="tickets"
          capPhrase={`at most ${rowCap.toLocaleString('en-US')} tickets`}
          periodLabel={period.label}
          scope="every number except Open now"
        />
      ) : null}

      <div>
        <FilterCaption
          className="mb-2 text-xs"
          lead="Cards and agent rows follow the period (Open now does not)"
          periodLabel={period.label}
          filterNames={[]}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            data-tile="open-now"
            label="Open now"
            value={num(s?.openNow)}
            subtitle="Any created date"
            icon={<Inbox className="h-5 w-5" />}
            hue="blue"
            valueProps={{ 'data-tile-value': 'open-now' }}
          />
          <StatCard
            data-tile="created"
            label="Created"
            value={num(s?.createdInPeriod)}
            icon={<PlusCircle className="h-5 w-5" />}
            hue="gray"
            valueProps={{ 'data-tile-value': 'created' }}
          />
          <StatCard
            data-tile="resolved"
            label="Resolved"
            value={num(s?.resolvedInPeriod)}
            icon={<CheckCircle2 className="h-5 w-5" />}
            hue="green"
            valueProps={{ 'data-tile-value': 'resolved' }}
          />
          <StatCard
            data-tile="avg-first-response"
            label="Avg first response"
            value={dur(s?.avgFirstResponseMinutes)}
            icon={<Clock className="h-5 w-5" />}
            hue="yellow"
            valueProps={{ 'data-tile-value': 'avg-first-response' }}
          />
          <StatCard
            data-tile="avg-resolution"
            label="Avg resolution"
            value={dur(s?.avgResolutionMinutes)}
            icon={<Timer className="h-5 w-5" />}
            hue="purple"
            valueProps={{ 'data-tile-value': 'avg-resolution' }}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Agent performance</h2>
        </div>
        {agents.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-gray-500">
              {report ? 'No assigned tickets in this period.' : 'No agent data: the tickets could not be read.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {COLUMNS.map(([key, label]) => (
                    <SortableTh<SupportSlaSortKey>
                      key={key}
                      sortKey={key}
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={onSort}
                      align={key === 'name' ? 'left' : 'right'}
                    >
                      {label}
                    </SortableTh>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {agents.map((agent) => (
                  <tr key={agent.agentId} data-agent-row={agent.agentId} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900">
                      <div>{agent.name}</div>
                      {agent.email && agent.email !== agent.name ? (
                        <div className="text-xs text-gray-500">{agent.email}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900">{agent.openNow}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900">{agent.resolvedInPeriod}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                      {formatDuration(agent.avgFirstResponseMinutes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900">
                      {formatDuration(agent.avgResolutionMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
