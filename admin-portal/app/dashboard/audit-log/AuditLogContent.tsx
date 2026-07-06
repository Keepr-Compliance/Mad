'use client';

/**
 * Audit Log Content - Admin Portal
 *
 * Displays admin_audit_logs with filtering by action, date range, and actor.
 * Uses admin_get_audit_logs RPC for paginated, permission-gated access.
 * Extracted as a standalone component so it can be embedded in Settings tabs.
 *
 * BACKLOG-921: Column picker with presets (Default, Troubleshooting).
 * Export respects currently selected columns.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, ChevronLeft, ChevronRight, Filter, Clock, User, Search, Download, Columns, Monitor, Globe } from 'lucide-react';
import { Card, Button } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import { formatTimestamp } from '@/lib/format';
import { useClickOutside } from '@/hooks/useClickOutside';

interface AuditLogEntry {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  target_email: string | null;
  target_name: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  actor_id: string;
  actor_email: string | null;
  actor_name: string | null;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  'user.suspend': { label: 'User Suspended', color: 'bg-red-100 text-red-700' },
  'user.unsuspend': { label: 'User Unsuspended', color: 'bg-green-100 text-green-700' },
  'license.update': { label: 'License Updated', color: 'bg-blue-100 text-blue-700' },
  'internal_user.add': { label: 'Internal User Added', color: 'bg-emerald-100 text-emerald-700' },
  'internal_user.remove': { label: 'Internal User Removed', color: 'bg-orange-100 text-orange-700' },
  'internal_user.role_change': { label: 'Role Changed', color: 'bg-purple-100 text-purple-700' },
  'role.create': { label: 'Role Created', color: 'bg-indigo-100 text-indigo-700' },
  'role.update': { label: 'Role Updated', color: 'bg-indigo-100 text-indigo-700' },
  'role.update_permissions': { label: 'Permissions Updated', color: 'bg-indigo-100 text-indigo-700' },
  'role.delete': { label: 'Role Deleted', color: 'bg-red-100 text-red-700' },
  'impersonation.start': { label: 'Impersonation Started', color: 'bg-purple-100 text-purple-700' },
  'impersonation.end': { label: 'Impersonation Ended', color: 'bg-purple-100 text-purple-700' },
};

// Column definitions
type ColumnKey = 'action' | 'target' | 'metadata' | 'ip_address' | 'user_agent' | 'actor' | 'timestamp';

const ALL_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'action', label: 'Action' },
  { key: 'target', label: 'Target' },
  { key: 'metadata', label: 'Details' },
  { key: 'ip_address', label: 'IP Address' },
  { key: 'user_agent', label: 'User Agent' },
  { key: 'actor', label: 'Actor' },
  { key: 'timestamp', label: 'Timestamp' },
];

const PRESETS: Record<string, { label: string; columns: ColumnKey[] }> = {
  default: {
    label: 'Default',
    columns: ['action', 'target', 'metadata', 'actor', 'timestamp'],
  },
  troubleshooting: {
    label: 'Troubleshooting',
    columns: ['action', 'target', 'metadata', 'ip_address', 'user_agent', 'actor', 'timestamp'],
  },
  minimal: {
    label: 'Minimal',
    columns: ['action', 'target', 'actor', 'timestamp'],
  },
};

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export function AuditLogContent({ embedded = false }: { embedded?: boolean } = {}) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [actionFilter, setActionFilter] = useState<string>('');
  const [searchTarget, setSearchTarget] = useState('');
  const [debouncedSearchTarget, setDebouncedSearchTarget] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Column picker
  const [selectedColumns, setSelectedColumns] = useState<ColumnKey[]>(PRESETS.default.columns);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const columnPickerRef = useRef<HTMLDivElement>(null);

  // Determine which preset (if any) matches the current selectedColumns
  const activePreset = useMemo(() => {
    const selected = new Set(selectedColumns);
    for (const [key, preset] of Object.entries(PRESETS)) {
      if (preset.columns.length === selected.size && preset.columns.every((c) => selected.has(c))) {
        return key;
      }
    }
    return null;
  }, [selectedColumns]);

  // Close column picker on click outside
  const closeColumnPicker = useCallback(() => setShowColumnPicker(false), []);
  useClickOutside(columnPickerRef, closeColumnPicker, showColumnPicker);

  // Debounce searchTarget by 300ms before using it in fetchLogs
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTarget(searchTarget);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTarget]);

  const supabase = useMemo(() => createClient(), []);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params: Record<string, unknown> = {
        p_limit: pageSize,
        p_offset: page * pageSize,
      };
      if (actionFilter) params.p_action = actionFilter;
      if (debouncedSearchTarget.trim()) params.p_target_id = debouncedSearchTarget.trim();
      if (dateFrom) params.p_date_from = new Date(dateFrom).toISOString();
      if (dateTo) params.p_date_to = new Date(dateTo + 'T23:59:59').toISOString();

      const { data, error: rpcError } = await supabase.rpc('admin_get_audit_logs', params);

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      const result = data as { logs: AuditLogEntry[]; total: number };
      setLogs(result.logs || []);
      setTotal(result.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch audit logs');
    } finally {
      setLoading(false);
    }
  }, [supabase, page, pageSize, actionFilter, debouncedSearchTarget, dateFrom, dateTo]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize);
  const uniqueActions = useMemo(() => {
    return Object.keys(ACTION_LABELS);
  }, []);

  function toggleColumn(key: ColumnKey) {
    setSelectedColumns((prev) => {
      if (prev.includes(key)) {
        // Prevent deselecting all columns — keep at least 2
        if (prev.length <= 2) return prev;
        return prev.filter((k) => k !== key);
      }
      return [...prev, key];
    });
  }

  function applyPreset(presetKey: string) {
    setSelectedColumns(PRESETS[presetKey].columns);
    setShowColumnPicker(false);
  }

  function handleExport(format: 'csv' | 'json') {
    const params = new URLSearchParams();
    params.set('format', format);
    params.set('columns', selectedColumns.join(','));
    params.set('preset', activePreset || 'custom');
    if (actionFilter) params.set('action', actionFilter);
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    window.open(`/api/audit-log/export?${params.toString()}`, '_blank');
  }

  function renderActionBadge(action: string) {
    const config = ACTION_LABELS[action] || { label: action, color: 'bg-gray-100 text-gray-700' };
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
        {config.label}
      </span>
    );
  }

  function renderTarget(entry: AuditLogEntry) {
    // User targets: show "on [name/email]" since the action badge doesn't convey who
    if (entry.target_type === 'user') {
      const name = entry.target_name || entry.target_email;
      if (name) {
        return (
          <span className="text-sm text-gray-500">
            on <span className="font-medium text-gray-700">{name}</span>
          </span>
        );
      }
    }

    // Non-user targets: skip "on [Type]" prefix — the action badge already says the type.
    // Try to find a descriptive name from metadata.
    const metaName = entry.metadata
      ? (entry.metadata.name as string) || (entry.metadata.slug as string) || (entry.metadata.email as string) || null
      : null;
    const displayName = entry.target_name || entry.target_email || metaName;

    if (displayName) {
      return (
        <span className="text-sm text-gray-500">
          <span className="mx-1">&mdash;</span>
          <span className="font-medium text-gray-700">{displayName}</span>
        </span>
      );
    }

    // Fallback: truncated target ID only
    if (entry.target_id) {
      return (
        <span className="text-sm text-gray-500">
          <span className="mx-1">&mdash;</span>
          <span className="text-xs text-gray-400" title={entry.target_id}>
            ({entry.target_id.slice(0, 8)}&hellip;)
          </span>
        </span>
      );
    }

    return null;
  }

  function renderMetadata(metadata: Record<string, unknown> | null) {
    if (!metadata) return null;
    const exclude = ['ip_address', 'target_user_id'];
    const entries = Object.entries(metadata).filter(([k]) => !exclude.includes(k));
    if (entries.length === 0) return null;

    return (
      <div className="flex flex-wrap gap-1.5 mt-1">
        {entries.map(([key, value]) => (
          <span key={key} className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600">
            <span className="font-medium">{key}:</span>
            <span className="ml-1">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
          </span>
        ))}
      </div>
    );
  }

  function isColumnVisible(key: ColumnKey): boolean {
    return selectedColumns.includes(key);
  }

  return (
    <div className={embedded ? 'space-y-6' : 'max-w-7xl mx-auto space-y-6'}>
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
          <p className="mt-1 text-sm text-gray-500">
            Complete history of admin actions for SOC 2 compliance.
          </p>
        </div>
      )}

      {/* Filters */}
      <Card padding="sm">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">Filters</span>
        </div>
        <div className="flex items-end gap-4 flex-wrap">
          <div className="w-48">
            <label className="block text-xs font-medium text-gray-500 mb-1">Action Type</label>
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 bg-white focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            >
              <option value="">All actions</option>
              {uniqueActions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a]?.label || a}</option>
              ))}
            </select>
          </div>

          <div className="w-48">
            <label className="block text-xs font-medium text-gray-500 mb-1">Target ID / Email</label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                value={searchTarget}
                onChange={(e) => { setSearchTarget(e.target.value); setPage(0); }}
                placeholder="Search..."
                className="w-full rounded-md border border-gray-300 pl-9 pr-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              />
            </div>
          </div>

          <div className="w-40">
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>

          <div className="w-40">
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>

          {(actionFilter || searchTarget || dateFrom || dateTo) && (
            <button
              onClick={() => { setActionFilter(''); setSearchTarget(''); setDateFrom(''); setDateTo(''); setPage(0); }}
              className="text-xs text-primary-600 hover:text-primary-800 underline pb-2"
            >
              Clear all
            </button>
          )}
        </div>
      </Card>

      {/* Results */}
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <Card padding="none">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Activity</h2>
            <p className="text-sm text-gray-500">{total} entr{total === 1 ? 'y' : 'ies'} found</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Column picker */}
            <div className="relative" ref={columnPickerRef}>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setShowColumnPicker(!showColumnPicker)}
              >
                <Columns className="h-3.5 w-3.5" />
                Columns
              </Button>
              {showColumnPicker && (
                <div className="absolute right-0 mt-1 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-20 py-2">
                  <div className="px-3 pb-2 border-b border-gray-100">
                    <span className="text-xs font-medium text-gray-500">Presets</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {Object.entries(PRESETS).map(([key, preset]) => (
                        <button
                          key={key}
                          onClick={() => applyPreset(key)}
                          className={
                            activePreset === key
                              ? 'px-2 py-1 text-xs rounded bg-primary-100 text-primary-700 ring-1 ring-primary-400'
                              : 'px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 text-gray-700'
                          }
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="py-1">
                    {ALL_COLUMNS.map((col) => (
                      <label
                        key={col.key}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedColumns.includes(col.key)}
                          onChange={() => toggleColumn(col.key)}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-xs text-gray-700">{col.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Export */}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xs" onClick={() => handleExport('csv')}>
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
              <Button variant="secondary" size="xs" onClick={() => handleExport('json')}>
                <Download className="h-3.5 w-3.5" />
                Export JSON
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">Show</label>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 bg-white focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span className="text-xs text-gray-500">per page</span>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1.5 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="text-sm text-gray-500">
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1.5 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-sm text-gray-400">Loading audit logs...</div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-gray-300" />
            <p className="mt-4 text-sm text-gray-500">No audit log entries found.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {logs.map((entry) => (
                <div key={entry.id} className="px-6 py-4 hover:bg-gray-50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        {isColumnVisible('action') && renderActionBadge(entry.action)}
                        {isColumnVisible('target') && renderTarget(entry)}
                      </div>
                      {isColumnVisible('metadata') && renderMetadata(entry.metadata)}
                      {(isColumnVisible('ip_address') || isColumnVisible('user_agent')) && (
                        <div className="flex flex-wrap gap-2 mt-1.5">
                          {isColumnVisible('ip_address') && entry.ip_address && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-600">
                              <Globe className="h-2.5 w-2.5" />
                              {entry.ip_address.replace(/\/\d+$/, '')}
                            </span>
                          )}
                          {isColumnVisible('user_agent') && entry.user_agent && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-blue-50 text-blue-600 max-w-md truncate" title={entry.user_agent}>
                              <Monitor className="h-2.5 w-2.5 shrink-0" />
                              {entry.user_agent}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {isColumnVisible('actor') && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                          <User className="h-3 w-3" />
                          <span>{entry.actor_name || entry.actor_email || 'Unknown'}</span>
                        </div>
                      )}
                      {isColumnVisible('timestamp') && (
                        <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-1">
                          <Clock className="h-3 w-3" />
                          <span>{formatTimestamp(entry.created_at)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
