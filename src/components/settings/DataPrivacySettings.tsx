import React, { useState, useEffect, useCallback } from "react";
import { useNotification } from "@/hooks/useNotification";
import { useSyncOrchestrator } from '../../hooks/useSyncOrchestrator';
import { formatFileSize, safeErrorMessage } from '../../utils/formatUtils';
import logger from '../../utils/logger';
import { OPERATION_LABELS } from './types';

interface FailureLogEntry {
  id: number;
  timestamp: string;
  operation: string;
  error_message: string;
  metadata: string | null;
  acknowledged: number;
}

interface DataPrivacySettingsProps {
  userId: string;
}

export function DataPrivacySettings({ userId }: DataPrivacySettingsProps) {
  const { notify } = useNotification();
  const { queue, requestSync } = useSyncOrchestrator();

  // Reindex state
  const [reindexing, setReindexing] = useState<boolean>(false);
  const [reindexResult, setReindexResult] = useState<{ success: boolean; message: string } | null>(null);

  // Backup & Restore state
  const [backingUp, setBackingUp] = useState<boolean>(false);
  const [restoring, setRestoring] = useState<boolean>(false);
  const [backupResult, setBackupResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dbInfo, setDbInfo] = useState<{ fileSize: number; lastModified: string } | null>(null);

  // CCPA Export state
  const [exporting, setExporting] = useState<boolean>(false);
  const [exportProgress] = useState<number>(0);
  const [exportCategory] = useState<string>("");
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Failure log state
  const [failureLogEntries, setFailureLogEntries] = useState<FailureLogEntry[]>([]);
  const [failureLogLoading, setFailureLogLoading] = useState<boolean>(false);

  // Load failure log
  const loadFailureLog = useCallback(async () => {
    setFailureLogLoading(true);
    try {
      const result = await window.api.failureLog?.getRecent(50);
      if (result?.success) {
        setFailureLogEntries(result.entries);
      }
    } catch (err) {
      logger.error("Failed to load failure log:", err);
    } finally {
      setFailureLogLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFailureLog();
  }, [loadFailureLog]);

  // Load database info
  useEffect(() => {
    const loadDbInfo = async () => {
      try {
        const result = await window.api.databaseBackup.getInfo();
        if (result.success && result.info) {
          setDbInfo({
            fileSize: result.info.fileSize,
            lastModified: result.info.lastModified,
          });
        }
      } catch (err) {
        logger.error("Failed to load database info:", err);
      }
    };
    loadDbInfo();
  }, []);

  // Orchestrator-derived state
  const reindexItem = queue.find(q => q.type === 'reindex');
  const backupItem = queue.find(q => q.type === 'backup');
  const restoreItem = queue.find(q => q.type === 'restore');
  const ccpaItem = queue.find(q => q.type === 'ccpa-export');

  const reindexRunning = reindexItem?.status === 'running' || reindexItem?.status === 'pending';
  const backupRunning = backupItem?.status === 'running' || backupItem?.status === 'pending';
  const restoreRunning = restoreItem?.status === 'running' || restoreItem?.status === 'pending';
  const exportRunning = ccpaItem?.status === 'running' || ccpaItem?.status === 'pending';

  const orchestratorExportProgress = ccpaItem?.progress ?? 0;
  const orchestratorExportCategory = ccpaItem?.phase ?? '';

  // Watch orchestrator queue for completion/error
  useEffect(() => {
    if (reindexItem?.status === 'complete') {
      setReindexResult({ success: true, message: 'Database optimized successfully' });
      setReindexing(false);
    } else if (reindexItem?.status === 'error') {
      setReindexResult({ success: false, message: safeErrorMessage(reindexItem.error, 'Failed to optimize database') });
      setReindexing(false);
    }
  }, [reindexItem?.status, reindexItem?.error]);

  useEffect(() => {
    if (backupItem?.status === 'complete') {
      setBackingUp(false);
      if (backupItem.warning !== 'cancelled') {
        setBackupResult({ success: true, message: 'Backup created successfully' });
        notify.success('Database backup created successfully');
      }
    } else if (backupItem?.status === 'error') {
      setBackupResult({ success: false, message: safeErrorMessage(backupItem.error, 'Failed to create backup') });
      notify.error(safeErrorMessage(backupItem.error, 'Failed to create backup'));
      setBackingUp(false);
    }
  }, [backupItem?.status, backupItem?.error]);

  useEffect(() => {
    if (restoreItem?.status === 'complete') {
      setRestoring(false);
      if (restoreItem.warning === 'cancelled') return;
      setBackupResult({ success: true, message: 'Database restored successfully' });
      notify.success('Database restored successfully');
      window.api.databaseBackup.getInfo().then((infoResult) => {
        if (infoResult.success && infoResult.info) {
          setDbInfo({
            fileSize: infoResult.info.fileSize,
            lastModified: infoResult.info.lastModified,
          });
        }
      }).catch(() => { /* Non-critical */ });
    } else if (restoreItem?.status === 'error') {
      setBackupResult({ success: false, message: safeErrorMessage(restoreItem.error, 'Failed to restore database') });
      notify.error(safeErrorMessage(restoreItem.error, 'Failed to restore database'));
      setRestoring(false);
    }
  }, [restoreItem?.status, restoreItem?.error]);

  useEffect(() => {
    if (ccpaItem?.status === 'complete') {
      setExporting(false);
      if (ccpaItem.warning !== 'cancelled') {
        setExportResult({ success: true, message: 'Data exported successfully' });
        notify.success('Your data has been exported successfully.');
      }
    } else if (ccpaItem?.status === 'error') {
      setExportResult({ success: false, message: safeErrorMessage(ccpaItem.error, 'Export failed') });
      notify.error('Failed to export data: ' + safeErrorMessage(ccpaItem.error, 'Unknown error'));
      setExporting(false);
    }
  }, [ccpaItem?.status, ccpaItem?.error]);

  // Handlers
  const handleClearFailureLog = async (): Promise<void> => {
    try {
      const result = await window.api.failureLog?.clear();
      if (result?.success) {
        setFailureLogEntries([]);
        notify.success("Diagnostic log cleared.");
      }
    } catch (err) {
      logger.error("Failed to clear failure log:", err);
      notify.error("Failed to clear diagnostic log.");
    }
  };

  const handleExportData = (): void => {
    setExportResult(null);
    requestSync(['ccpa-export'], userId);
  };

  const handleReindexDatabase = (): void => {
    const confirmed = window.confirm(
      "This will optimize the database for better performance.\n\n" +
        "Note: The app may briefly freeze during this process. This is normal and should only take a few seconds.\n\n" +
        "Continue?",
    );
    if (!confirmed) return;
    setReindexResult(null);
    requestSync(['reindex'], userId);
  };

  const handleBackupDatabase = (): void => {
    setBackupResult(null);
    requestSync(['backup'], userId);
  };

  const handleRestoreDatabase = (): void => {
    setBackupResult(null);
    requestSync(['restore'], userId);
  };

  return (
    <div id="settings-data" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Data & Privacy
      </h3>
      <div className="space-y-3">
        {/* Reindex Database */}
        <button
          onClick={handleReindexDatabase}
          disabled={reindexing || reindexRunning}
          className="w-full text-left p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-gray-900">
                Reindex Database
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Optimize database performance if you notice slowness
              </p>
              {reindexResult && (
                <p
                  className={`text-xs mt-2 ${
                    reindexResult.success ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {typeof reindexResult.message === 'string' ? reindexResult.message : String(reindexResult.message)}
                </p>
              )}
            </div>
            {(reindexing || reindexRunning) ? (
              <svg
                className="w-5 h-5 text-blue-500 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg
                className="w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
          </div>
        </button>

        {/* Database Backup & Restore */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h4 className="text-sm font-medium text-gray-900 mb-1">
            Database Backup & Restore
          </h4>
          <p className="text-xs text-gray-600 mb-2">
            Your database is encrypted and stored locally. Backups can be
            used to recover data if something goes wrong.
          </p>
          {dbInfo && (
            <div className="text-xs text-gray-500 mb-3 space-y-0.5">
              <p>Database size: {formatFileSize(dbInfo.fileSize)}</p>
              <p>
                Last modified:{" "}
                {new Date(dbInfo.lastModified).toLocaleString()}
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleBackupDatabase}
              disabled={backingUp || restoring || backupRunning || restoreRunning}
              className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {(backingUp || backupRunning) ? "Backing up..." : "Backup Database"}
            </button>
            <button
              onClick={handleRestoreDatabase}
              disabled={backingUp || restoring || backupRunning || restoreRunning}
              className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 rounded border border-amber-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {(restoring || restoreRunning) ? "Restoring..." : "Restore from Backup"}
            </button>
          </div>
          {backupResult && (
            <p
              className={`text-xs mt-2 ${
                backupResult.success ? "text-green-600" : "text-red-600"
              }`}
            >
              {typeof backupResult.message === 'string' ? backupResult.message : String(backupResult.message)}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">
            Backups are encrypted with your machine&apos;s keychain.
            They can only be restored on this machine.
          </p>
        </div>

        {/* Diagnostic Log */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h4 className="text-sm font-medium text-gray-900">
                Diagnostic Log
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Recent network operation failures (for support diagnostics)
              </p>
            </div>
            {failureLogEntries.length > 0 && (
              <button
                onClick={handleClearFailureLog}
                className="px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded border border-red-200 transition-colors"
              >
                Clear Log
              </button>
            )}
          </div>
          {failureLogLoading ? (
            <p className="text-xs text-gray-500">Loading...</p>
          ) : failureLogEntries.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No failures recorded.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-2 mt-2">
              {failureLogEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="p-2 bg-white rounded border border-gray-100 text-xs"
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-medium text-gray-800">
                      {OPERATION_LABELS[entry.operation] || entry.operation}
                    </span>
                    <span className="text-gray-400 text-[10px]">
                      {new Date(entry.timestamp + "Z").toLocaleString()}
                    </span>
                  </div>
                  <p className="text-gray-600 break-words">
                    {typeof entry.error_message === 'string' ? entry.error_message : String(entry.error_message)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CCPA Data Export */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <h4 className="text-sm font-medium text-gray-900 mb-2">
            Export Your Data (CCPA)
          </h4>
          <p className="text-xs text-gray-600 mb-3">
            You have the right to know what personal data is stored in this
            application. Click below to export all your data as a JSON file.
          </p>
          <p className="text-xs text-gray-500 mb-4">
            Data included: profile, transactions, contacts, messages, emails,
            preferences, and activity logs. OAuth token values are excluded
            for security.
          </p>
          {(exporting || exportRunning) && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                <span>
                  Exporting{(exportCategory || orchestratorExportCategory) ? `: ${exportCategory || orchestratorExportCategory}` : "..."}
                </span>
                <span>{exportProgress || orchestratorExportProgress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${exportProgress || orchestratorExportProgress}%` }}
                />
              </div>
            </div>
          )}
          {exportResult && (
            <p
              className={`text-xs mb-3 ${
                exportResult.success ? "text-green-600" : "text-red-600"
              }`}
            >
              {typeof exportResult.message === 'string' ? exportResult.message : String(exportResult.message)}
            </p>
          )}
          <button
            onClick={handleExportData}
            disabled={exporting || exportRunning}
            className="px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(exporting || exportRunning) ? "Exporting..." : "Export My Data"}
          </button>
        </div>

        {/* Clear All Data / reset / uninstall moved to the dedicated
            Troubleshooting section (BACKLOG-2112). */}
      </div>
    </div>
  );
}
