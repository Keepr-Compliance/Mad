'use client';

/**
 * TokenMetricsBreakdown — Shows per-agent-type token usage for a task or sprint.
 *
 * Displays a summary bar + expandable table of individual agent runs.
 * Used in TaskSidebar (task-level) and Sprint detail page (sprint-level).
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Cpu, Loader2 } from 'lucide-react';
import {
  getTaskMetrics,
  getSprintMetrics,
  summarizeByAgentType,
} from '@/lib/pm-queries';
import type { TokenMetricRow, TokenMetricsSummary } from '@/lib/pm-types';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** `total_tokens` includes cached re-reads; `billable_tokens` is what was actually charged for. */
const BILLABLE_TOOLTIP = 'Total includes cached re-reads; billable reflects cost';

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

const AGENT_TYPE_COLORS: Record<string, string> = {
  engineer: 'bg-blue-100 text-blue-700',
  'sr-engineer': 'bg-purple-100 text-purple-700',
  pm: 'bg-amber-100 text-amber-700',
  qa: 'bg-green-100 text-green-700',
  fix: 'bg-red-100 text-red-700',
  explore: 'bg-gray-100 text-gray-700',
  unknown: 'bg-gray-100 text-gray-500',
};

// Solid bar colors for the stacked effort bar
const AGENT_TYPE_BAR_COLORS: Record<string, string> = {
  engineer: 'bg-blue-500',
  'sr-engineer': 'bg-purple-500',
  pm: 'bg-amber-500',
  qa: 'bg-green-500',
  fix: 'bg-red-500',
  explore: 'bg-gray-400',
  unknown: 'bg-gray-300',
};

function AgentTypeBadge({ type }: { type: string }) {
  const colors = AGENT_TYPE_COLORS[type] ?? AGENT_TYPE_COLORS.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors}`}>
      {type}
    </span>
  );
}

// --- Stacked Effort Bar ---
function EffortBar({ summary }: { summary: TokenMetricsSummary[] }) {
  const total = summary.reduce((s, r) => s + r.total_tokens, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-gray-100" title="Token distribution by agent type">
      {summary.map((s) => {
        const pct = (s.total_tokens / total) * 100;
        if (pct < 0.5) return null;
        const barColor = AGENT_TYPE_BAR_COLORS[s.agent_type] ?? AGENT_TYPE_BAR_COLORS.unknown;
        return (
          <div
            key={s.agent_type}
            className={`${barColor} transition-all`}
            style={{ width: `${pct}%` }}
            title={`${s.agent_type}: ${formatTokens(s.total_tokens)} (${pct.toFixed(0)}%)`}
          />
        );
      })}
    </div>
  );
}

// --- Summary Row ---
function SummaryRow({ summary }: { summary: TokenMetricsSummary }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2">
        <AgentTypeBadge type={summary.agent_type} />
        <span className="text-xs text-gray-500">{summary.runs} run{summary.runs !== 1 ? 's' : ''}</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium text-gray-900">{formatTokens(summary.total_tokens)}</span>
        <span className="text-xs text-gray-400" title={BILLABLE_TOOLTIP}>
          {formatTokens(summary.billable_tokens)} billable
        </span>
        <span className="text-xs text-gray-400">{formatDuration(summary.duration_ms)}</span>
      </div>
    </div>
  );
}

// --- Detail Table ---
function DetailTable({ rows }: { rows: TokenMetricRow[] }) {
  return (
    <div className="mt-2 border-t border-gray-100 pt-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 uppercase tracking-wider">
            <th className="text-left py-1 font-medium">Agent</th>
            <th className="text-right py-1 font-medium">Total</th>
            <th className="text-right py-1 font-medium" title={BILLABLE_TOOLTIP}>Billable</th>
            <th className="text-right py-1 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-gray-50">
              <td className="py-1.5">
                <div className="flex items-center gap-1.5">
                  <AgentTypeBadge type={row.agent_type ?? 'unknown'} />
                  {row.description && (
                    <span className="text-gray-500 truncate max-w-[120px]" title={row.description}>
                      {row.description}
                    </span>
                  )}
                </div>
              </td>
              <td className="text-right text-gray-700 font-medium">{formatTokens(row.total_tokens)}</td>
              <td className="text-right text-gray-500">{formatTokens(row.billable_tokens)}</td>
              <td className="text-right text-gray-500">{formatDuration(row.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 font-medium">
            <td className="py-1.5 text-gray-700">Total</td>
            <td className="text-right text-gray-900">{formatTokens(rows.reduce((s, r) => s + r.total_tokens, 0))}</td>
            <td className="text-right text-gray-700">{formatTokens(rows.reduce((s, r) => s + r.billable_tokens, 0))}</td>
            <td className="text-right text-gray-700">{formatDuration(rows.reduce((s, r) => s + r.duration_ms, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// --- Main Component ---
interface TokenMetricsBreakdownProps {
  /** Legacy task ID like 'TASK-2316' — fetches task-level metrics */
  taskId?: string;
  /** Sprint UUID — fetches sprint-level metrics */
  sprintId?: string;
  /** Start expanded */
  defaultExpanded?: boolean;
  /**
   * Optional wrapper classes (e.g. card styling). Only applied when the
   * component has content to render — so when there are no metrics the
   * whole wrapper is omitted instead of leaving an empty card behind.
   */
  wrapperClassName?: string;
}

export default function TokenMetricsBreakdown({
  taskId,
  sprintId,
  defaultExpanded = false,
  wrapperClassName,
}: TokenMetricsBreakdownProps) {
  const [rows, setRows] = useState<TokenMetricRow[]>([]);
  const [summary, setSummary] = useState<TokenMetricsSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const fetchMetrics = useCallback(async () => {
    try {
      setLoading(true);
      let data: TokenMetricRow[];
      if (taskId) {
        data = await getTaskMetrics(taskId);
      } else if (sprintId) {
        data = await getSprintMetrics(sprintId);
      } else {
        data = [];
      }
      setRows(data);
      setSummary(summarizeByAgentType(data));
    } catch {
      setRows([]);
      setSummary([]);
    } finally {
      setLoading(false);
    }
  }, [taskId, sprintId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading metrics...
      </div>
    );
  }

  if (rows.length === 0) return null;

  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  const totalBillableTokens = rows.reduce((s, r) => s + r.billable_tokens, 0);

  const inner = (
    <div className="px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full group"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          <Cpu className="h-4 w-4 text-gray-400" />
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Token Breakdown
          </span>
        </div>
        <span className="text-sm font-medium text-gray-700">
          {formatTokens(totalTokens)}{' '}
          <span className="text-xs font-normal text-gray-400" title={BILLABLE_TOOLTIP}>
            ({formatTokens(totalBillableTokens)} billable)
          </span>{' '}
          / {rows.length} run{rows.length !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Everything below the header is gated by expanded — including the
          stacked effort bar added in develop. */}
      {expanded && (
        <>
          {/* Stacked effort bar */}
          <div className="mt-2 ml-6">
            <EffortBar summary={summary} />
          </div>

          {/* Per-agent-type summary rows */}
          <div className="mt-2 ml-6">
            {summary.map((s) => (
              <SummaryRow key={s.agent_type} summary={s} />
            ))}
          </div>

          {/* Detail table */}
          <div className="ml-6">
            <DetailTable rows={rows} />
          </div>
        </>
      )}
    </div>
  );

  return wrapperClassName ? (
    <div className={wrapperClassName}>{inner}</div>
  ) : (
    inner
  );
}
