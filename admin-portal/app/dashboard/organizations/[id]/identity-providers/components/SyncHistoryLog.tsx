'use client';

/**
 * SyncHistoryLog - Display recent SCIM sync events.
 *
 * Shows a paginated table of scim_sync_log entries for the organization,
 * with operation type, resource details, status, and timestamp.
 */

import { useState, useCallback } from 'react';
import {
  History,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { Button, Card } from '@keepr/design-system';
import { formatTimestamp } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types (inline -- NOT from @keepr/shared per Vercel deploy limitation)
// ---------------------------------------------------------------------------

export interface SyncLogEntry {
  id: string;
  operation: string;
  resource_type: string;
  resource_id: string | null;
  external_id: string | null;
  response_status: number | null;
  error_message: string | null;
  created_at: string;
}

interface SyncHistoryLogProps {
  initialEntries: SyncLogEntry[];
  totalCount: number;
  onLoadMore: (offset: number) => Promise<SyncLogEntry[]>;
  onRefresh: () => Promise<{ entries: SyncLogEntry[]; total: number }>;
}

function StatusBadge({ status }: { status: number | null }) {
  if (status === null) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
        Unknown
      </span>
    );
  }

  const isSuccess = status >= 200 && status < 300;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        isSuccess
          ? 'bg-green-100 text-green-800'
          : 'bg-red-100 text-red-800'
      }`}
    >
      {isSuccess ? (
        <CheckCircle className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      {status}
    </span>
  );
}

function OperationBadge({ operation }: { operation: string }) {
  const colorMap: Record<string, string> = {
    CREATE: 'bg-blue-100 text-blue-800',
    UPDATE: 'bg-amber-100 text-amber-800',
    DELETE: 'bg-red-100 text-red-800',
    PATCH: 'bg-purple-100 text-purple-800',
    GET: 'bg-gray-100 text-gray-800',
    LIST: 'bg-gray-100 text-gray-800',
    REPLACE: 'bg-orange-100 text-orange-800',
  };
  const color = colorMap[operation.toUpperCase()] || 'bg-gray-100 text-gray-800';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${color}`}>
      {operation.toUpperCase()}
    </span>
  );
}

export function SyncHistoryLog({
  initialEntries,
  totalCount,
  onLoadMore,
  onRefresh,
}: SyncHistoryLogProps) {
  const [entries, setEntries] = useState<SyncLogEntry[]>(initialEntries);
  const [total, setTotal] = useState(totalCount);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const hasMore = entries.length < total;

  const handleLoadMore = useCallback(async () => {
    setLoading(true);
    try {
      const more = await onLoadMore(entries.length);
      setEntries((prev) => [...prev, ...more]);
    } finally {
      setLoading(false);
    }
  }, [entries.length, onLoadMore]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await onRefresh();
      setEntries(result.entries);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [onRefresh]);

  const toggleErrorExpand = useCallback((id: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <Card padding="none">
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-gray-200">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3"
        >
          <div className="h-10 w-10 rounded-lg bg-gray-100 text-gray-700 flex items-center justify-center">
            <History className="h-5 w-5" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-900">Sync History</h3>
            <p className="text-xs text-gray-500">
              {total} {total === 1 ? 'event' : 'events'} recorded
            </p>
          </div>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-400 ml-2" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400 ml-2" />
          )}
        </button>
        <Button
          variant="secondary"
          size="xs"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Table */}
      {expanded && (
        <div className="overflow-x-auto">
          {entries.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500">
              No sync events recorded yet.
            </div>
          ) : (
            <>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Time
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Operation
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Resource
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {formatTimestamp(entry.created_at)}
                      </td>
                      <td className="px-4 py-2">
                        <OperationBadge operation={entry.operation} />
                      </td>
                      <td className="px-4 py-2">
                        <span className="text-xs text-gray-900">{entry.resource_type}</span>
                        {entry.external_id && (
                          <span className="block text-xs text-gray-400 truncate max-w-[200px]" title={entry.external_id}>
                            ext: {entry.external_id}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={entry.response_status} />
                      </td>
                      <td className="px-4 py-2">
                        {entry.error_message ? (
                          <button
                            type="button"
                            onClick={() => toggleErrorExpand(entry.id)}
                            className="text-xs text-red-600 hover:text-red-800 underline"
                          >
                            {expandedErrors.has(entry.id) ? 'Hide error' : 'View error'}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Expanded error messages */}
              {entries
                .filter((e) => e.error_message && expandedErrors.has(e.id))
                .map((entry) => (
                  <div
                    key={`error-${entry.id}`}
                    className="mx-4 mb-2 rounded-md bg-red-50 border border-red-200 px-4 py-2"
                  >
                    <p className="text-xs font-medium text-red-800 mb-1">
                      Error for {entry.operation} {entry.resource_type}:
                    </p>
                    <p className="text-xs text-red-700 font-mono whitespace-pre-wrap">
                      {entry.error_message}
                    </p>
                  </div>
                ))}

              {/* Load more */}
              {hasMore && (
                <div className="px-4 py-3 border-t border-gray-200 text-center">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loading}
                    className="text-xs font-medium text-primary-600 hover:text-primary-700 disabled:opacity-50"
                  >
                    {loading ? 'Loading...' : `Load more (${total - entries.length} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
