'use client';

/**
 * DirectorySyncPanel - Directory sync toggle, status, and manual trigger.
 *
 * Shows:
 * - Toggle for directory_sync_enabled
 * - Last sync timestamp
 * - Sync error (prominently displayed)
 * - "Sync Now" button with confirmation
 */

import { useState, useCallback } from 'react';
import {
  FolderSync,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  Clock,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { Card } from '@keepr/design-system';
import { ConfirmationDialog } from '@/components/shared/ConfirmationDialog';
import { formatTimestamp } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types (inline -- NOT from @keepr/shared per Vercel deploy limitation)
// ---------------------------------------------------------------------------

export interface DirectorySyncStatus {
  directory_sync_enabled: boolean;
  directory_sync_last_at: string | null;
  directory_sync_error: string | null;
}

interface DirectorySyncPanelProps {
  organizationId: string;
  initialStatus: DirectorySyncStatus;
  onToggleSync: (enabled: boolean) => Promise<boolean>;
  onTriggerSync: () => Promise<{ success: boolean; error?: string }>;
}

export function DirectorySyncPanel({
  organizationId,
  initialStatus,
  onToggleSync,
  onTriggerSync,
}: DirectorySyncPanelProps) {
  const [status, setStatus] = useState<DirectorySyncStatus>(initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [syncResult, setSyncResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Suppress unused variable lint — organizationId kept for future use
  void organizationId;

  const handleToggle = useCallback(async () => {
    setToggling(true);
    setSyncResult(null);
    try {
      const newState = !status.directory_sync_enabled;
      const success = await onToggleSync(newState);
      if (success) {
        setStatus((prev) => ({ ...prev, directory_sync_enabled: newState }));
        setSyncResult({
          type: 'success',
          text: `Directory sync ${newState ? 'enabled' : 'disabled'}.`,
        });
      } else {
        setSyncResult({ type: 'error', text: 'Failed to update sync setting.' });
      }
    } catch (err) {
      setSyncResult({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update sync setting.',
      });
    } finally {
      setToggling(false);
    }
  }, [status.directory_sync_enabled, onToggleSync]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await onTriggerSync();
      if (result.success) {
        setStatus((prev) => ({
          ...prev,
          directory_sync_last_at: new Date().toISOString(),
          directory_sync_error: null,
        }));
        setSyncResult({ type: 'success', text: 'Directory sync completed successfully.' });
      } else {
        const errorMsg = result.error || 'Sync failed.';
        setStatus((prev) => ({ ...prev, directory_sync_error: errorMsg }));
        setSyncResult({ type: 'error', text: errorMsg });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Sync failed.';
      setStatus((prev) => ({ ...prev, directory_sync_error: errorMsg }));
      setSyncResult({ type: 'error', text: errorMsg });
    } finally {
      setSyncing(false);
      setShowSyncConfirm(false);
    }
  }, [onTriggerSync]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
            <FolderSync className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Directory Sync</h3>
            <p className="text-xs text-gray-500">
              Automatically sync users from your identity provider
            </p>
          </div>
        </div>

        {/* Enable/Disable toggle */}
        <button
          type="button"
          onClick={handleToggle}
          disabled={toggling}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
            status.directory_sync_enabled
              ? 'text-amber-700 bg-white border-amber-300 hover:bg-amber-50'
              : 'text-green-700 bg-white border-green-300 hover:bg-green-50'
          }`}
        >
          {status.directory_sync_enabled ? (
            <>
              <ToggleLeft className="h-3 w-3" />
              Disable
            </>
          ) : (
            <>
              <ToggleRight className="h-3 w-3" />
              Enable
            </>
          )}
        </button>
      </div>

      {/* Status message */}
      {syncResult && (
        <div
          className={`mb-4 rounded-md px-4 py-3 text-sm ${
            syncResult.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {syncResult.text}
        </div>
      )}

      {/* Sync error (always prominent) */}
      {status.directory_sync_error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Last Sync Error</p>
            <p className="text-sm text-red-700 mt-0.5">{status.directory_sync_error}</p>
          </div>
        </div>
      )}

      {/* Sync details */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Status</dt>
          <dd className="mt-1 flex items-center gap-1.5">
            {status.directory_sync_enabled ? (
              <>
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium text-green-700">Enabled</span>
              </>
            ) : (
              <>
                <Clock className="h-4 w-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-500">Disabled</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Last Sync
          </dt>
          <dd className="mt-1 text-sm text-gray-900">
            {formatTimestamp(status.directory_sync_last_at, 'Never synced')}
          </dd>
        </div>
      </div>

      {/* Sync Now button */}
      {status.directory_sync_enabled && (
        <div className="pt-3 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setShowSyncConfirm(true)}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      )}

      {/* Sync confirmation dialog */}
      {showSyncConfirm && (
        <ConfirmationDialog
          title="Trigger Directory Sync"
          description="This will pull the latest user data from the identity provider and update organization memberships. New users will be provisioned and removed users will be suspended."
          confirmLabel="Sync Now"
          onConfirm={handleSync}
          onCancel={() => setShowSyncConfirm(false)}
          isLoading={syncing}
        />
      )}
    </Card>
  );
}
