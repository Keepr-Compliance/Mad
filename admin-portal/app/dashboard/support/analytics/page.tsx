'use client';

/**
 * Support Analytics Page (BACKLOG-3651)
 *
 * Numbers are computed in app code from support_tickets (lib/reports/support-sla.ts):
 * - Summary cards: Open now, Created / Resolved in period, Avg first response, Avg resolution
 * - Period selector: Last 7 / 30 / 90 days (applies to every number except "Open now")
 * - Agent performance table: sortable columns
 */

import { useState, useEffect, useCallback } from 'react';
import { Inbox, CheckCircle2, Clock, Timer, PlusCircle, ArrowUpDown } from 'lucide-react';
import { PageHeader, StatCard } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import {
  buildSupportSlaReport,
  formatDuration,
  READ_FAILED_MESSAGE,
  lastDays,
  type SupportSlaAgentRow,
  type SupportSlaReport,
} from '@/lib/reports/support-sla';
import { getAgentUsers, getOpenTicketCount, getSupportTickets } from '@/lib/reports/support-sla-queries';

type SortField = 'name' | 'openNow' | 'resolvedInPeriod' | 'avgFirstResponseMinutes' | 'avgResolutionMinutes';
type SortDir = 'asc' | 'desc';

const PERIOD_OPTIONS = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
];

export default function SupportAnalyticsPage() {
  const [data, setData] = useState<SupportSlaReport | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState(30);
  const [sortField, setSortField] = useState<SortField>('resolvedInPeriod');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const period = lastDays(periodDays, new Date());
      const [tickets, openCount] = await Promise.all([
        getSupportTickets(supabase, period),
        getOpenTicketCount(supabase),
      ]);
      if (tickets.failed) {
        setData(null);
        setTruncated(false);
        setError(READ_FAILED_MESSAGE);
        return;
      }
      const users = await getAgentUsers(supabase, tickets.rows);
      setData(buildSupportSlaReport(tickets.rows, users, period, openCount));
      setTruncated(tickets.truncated);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [periodDays]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  const sortedAgents: SupportSlaAgentRow[] = data?.agents
    ? [...data.agents].sort((a, b) => {
        const aVal = a[sortField] ?? 0;
        const bVal = b[sortField] ?? 0;
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
      })
    : [];

  const blank = !data;
  const summaryCards = [
    {
      label: 'Open now',
      value: data?.summary.openNow ?? null,
      format: 'number' as const,
      icon: Inbox,
      hue: 'blue' as const,
    },
    {
      label: `Created (${periodDays}d)`,
      value: data?.summary.createdInPeriod ?? null,
      format: 'number' as const,
      icon: PlusCircle,
      hue: null,
      color: 'text-gray-600 bg-gray-100',
    },
    {
      label: `Resolved (${periodDays}d)`,
      value: data?.summary.resolvedInPeriod ?? null,
      format: 'number' as const,
      icon: CheckCircle2,
      hue: 'green' as const,
    },
    {
      label: `Avg first response (${periodDays}d)`,
      value: data?.summary.avgFirstResponseMinutes ?? null,
      format: 'duration' as const,
      icon: Clock,
      hue: 'yellow' as const,
    },
    {
      label: `Avg resolution (${periodDays}d)`,
      value: data?.summary.avgResolutionMinutes ?? null,
      format: 'duration' as const,
      icon: Timer,
      hue: null,
      color: 'text-purple-600 bg-purple-50',
    },
  ];

  return (
    <div>
      {/* Header */}
      <PageHeader
        title="Support Analytics"
        subtitle="Open now counts new, assigned, in progress and pending tickets. Deleted tickets are never counted."
        actions={
          <select
            value={periodDays}
            onChange={(e) => setPeriodDays(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-md px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        }
      />

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {truncated && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
          More tickets match this period than could be read. Every number except Open now may be too low.
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          const display = loading || blank
            ? '-'
            : card.format === 'duration'
              ? formatDuration(card.value as number | null)
              : (card.value ?? 0);
          if (card.hue) {
            return (
              <StatCard
                key={card.label}
                label={card.label}
                value={display}
                icon={<Icon className="h-5 w-5" />}
                hue={card.hue}
              />
            );
          }
          return (
            <div
              key={card.label}
              className="bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4"
            >
              <div className={`rounded-lg p-3 ${card.color}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">{card.label}</p>
                <p className="text-2xl font-semibold text-gray-900">{display}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Agent Performance Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-900">Agent Performance</h2>
        </div>

        {loading ? (
          <div className="animate-pulse">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 border-b border-gray-100 px-6 py-4">
                <div className="h-4 bg-gray-200 rounded w-3/4" />
              </div>
            ))}
          </div>
        ) : sortedAgents.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-gray-500">No agent data available for this period.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {([
                    ['name', 'Agent'],
                    ['openNow', 'Open now'],
                    ['resolvedInPeriod', `Resolved (${periodDays}d)`],
                    ['avgFirstResponseMinutes', 'Avg First Response'],
                    ['avgResolutionMinutes', 'Avg Resolution'],
                  ] as [SortField, string][]).map(([field, label]) => (
                    <th
                      key={field}
                      onClick={() => handleSort(field)}
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        <ArrowUpDown className={`h-3 w-3 ${sortField === field ? 'text-gray-900' : 'text-gray-400'}`} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {sortedAgents.map((agent) => (
                  <tr key={agent.agentId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                      <div>{agent.name}</div>
                      {agent.email && agent.email !== agent.name && (
                        <div className="text-xs text-gray-500">{agent.email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{agent.openNow}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{agent.resolvedInPeriod}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {formatDuration(agent.avgFirstResponseMinutes)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">
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
