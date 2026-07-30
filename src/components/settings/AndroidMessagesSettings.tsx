/**
 * AndroidMessagesSettings Component (BACKLOG-1458)
 *
 * Settings section for Android Companion message sync.
 * Shown when the active import source is "android-companion".
 *
 * Features:
 * - Shows sync status from the companion app
 * - Import filters (time range, max messages)
 * - "Open companion app and tap Sync Now" guidance
 * - Force re-import resets sync timestamp
 *
 * @module settings/AndroidMessagesSettings
 */

import React, { useState, useEffect, useCallback } from "react";
import { settingsService } from '../../services';
import logger from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncStatus {
  running: boolean;
  port: number | null;
  address: string | null;
  totalMessagesReceived: number;
  lastSyncTimestamp: number | null;
}

interface AndroidMessagesSettingsProps {
  userId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) {
    const mins = Math.floor(diffMs / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (diffMs < 86_400_000) {
    const hours = Math.floor(diffMs / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diffMs / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Android companion messages settings.
 * Shows sync status, import filters, and re-import controls.
 */
export function AndroidMessagesSettings({ userId }: AndroidMessagesSettingsProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForceWarning, setShowForceWarning] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clearResult, setClearResult] = useState<{ messagesDeleted: number; contactsDeleted: number } | null>(null);

  // Import filter state
  const [lookbackMonths, setLookbackMonths] = useState<number | null>(3);
  const [maxMessages, setMaxMessages] = useState<number | null>(50000);

  // Load sync status and filter preferences
  const refreshStatus = useCallback(async () => {
    try {
      const syncResult = await window.api.localSync.getStatus();
      setSyncStatus(syncResult);
    } catch (err) {
      logger.error("[AndroidMessagesSettings] Failed to get sync status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 10_000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  // Load filter preferences
  useEffect(() => {
    if (!userId) return;
    const loadFilters = async () => {
      try {
        const result = await settingsService.getPreferences(userId);
        if (result?.success && result.data) {
          const prefs = result.data as Record<string, unknown>;
          const messageImport = prefs.messageImport as
            | { filters?: { lookbackMonths?: number | null; maxMessages?: number | null } }
            | undefined;
          if (messageImport?.filters) {
            setLookbackMonths(messageImport.filters.lookbackMonths ?? null);
            setMaxMessages(messageImport.filters.maxMessages ?? null);
          }
        }
      } catch {
        // Use defaults
      }
    };
    loadFilters();
  }, [userId]);

  const handleLookbackChange = async (value: string) => {
    const months = value === "all" ? null : Number(value);
    setLookbackMonths(months);
    try {
      await settingsService.updatePreferences(userId, {
        messageImport: {
          filters: { lookbackMonths: months },
        },
      });
    } catch {
      // Silently handle
    }
  };

  const handleMaxMessagesChange = async (value: string) => {
    const cap = value === "unlimited" ? null : Number(value);
    setMaxMessages(cap);
    try {
      await settingsService.updatePreferences(userId, {
        messageImport: {
          filters: { maxMessages: cap },
        },
      });
    } catch {
      // Silently handle
    }
  };

  const handleForceReimport = async () => {
    setShowForceWarning(false);
    setResetting(true);
    setClearResult(null);
    try {
      // BACKLOG-1468: Clear Android-synced data from local DB before stopping server.
      // This deletes messages (metadata source = 'android_wifi_sync') and
      // contacts (source = 'android_sync') so the companion app re-sends everything.
      const result = await window.api.localSync.clearAndroidData({ userId });
      setClearResult(result);

      // Stop the sync server to reset in-memory counters.
      // The companion app will re-send all messages on next sync.
      await window.api.localSync.stopServer();
      await refreshStatus();
    } catch (err) {
      logger.error("[AndroidMessagesSettings] Force re-import error:", err);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-green-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
          </svg>
          <h4 className="text-sm font-medium text-gray-900">Android Companion</h4>
        </div>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        Sync SMS messages from your Android phone over WiFi using the Keepr Companion app.
      </p>

      {/* Sync status display */}
      {loading ? (
        <div className="mb-3 text-xs text-gray-500">Loading sync status...</div>
      ) : (
        <div className="mb-3 text-xs text-gray-500">
          {syncStatus?.lastSyncTimestamp
            ? `Last synced: ${formatRelativeTime(syncStatus.lastSyncTimestamp)}`
            : "Never synced"}
          {syncStatus && syncStatus.totalMessagesReceived > 0 && (
            <> | {syncStatus.totalMessagesReceived.toLocaleString()} messages received</>
          )}
        </div>
      )}

      {/* Clear result display (BACKLOG-1468) */}
      {clearResult && (
        <div className="mb-3 text-xs text-green-700 bg-green-50 rounded p-2 border border-green-200">
          Cleared {clearResult.messagesDeleted.toLocaleString()} messages and{" "}
          {clearResult.contactsDeleted.toLocaleString()} contacts. Open the companion app and
          tap Sync Now to re-import.
        </div>
      )}

      {/* Sync server status indicator */}
      {syncStatus?.running && (
        <div className="mb-3 flex items-center gap-2 text-xs text-green-700">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Sync server active on {syncStatus.address}:{syncStatus.port}
        </div>
      )}

      {/* Import Filters */}
      <div className="mb-3 p-3 bg-white rounded border border-gray-200">
        <h5 className="text-xs font-medium text-gray-700 mb-2">
          Import Filters
        </h5>

        {/* Date Range Filter */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-600">Import messages from</span>
          <select
            value={lookbackMonths ?? "all"}
            onChange={(e) => handleLookbackChange(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900"
          >
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="9">Last 9 months</option>
            <option value="12">Last 12 months</option>
            <option value="18">Last 18 months</option>
            <option value="24">Last 24 months</option>
            <option value="all">All time</option>
          </select>
        </div>

        {/* Message Count Cap */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-600">Maximum messages</span>
          <select
            value={maxMessages ?? "unlimited"}
            onChange={(e) => handleMaxMessagesChange(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1 bg-white text-gray-900"
          >
            <option value="10000">10,000</option>
            <option value="50000">50,000</option>
            <option value="100000">100,000</option>
            <option value="250000">250,000</option>
            <option value="500000">500,000</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </div>

        {/* Active filter indicator */}
        {(lookbackMonths !== null || maxMessages !== null) && (
          <p className="text-xs text-blue-600 mt-2">
            {lookbackMonths !== null && maxMessages !== null
              ? `Importing last ${lookbackMonths} months, up to ${maxMessages.toLocaleString()} messages`
              : lookbackMonths !== null
                ? `Importing messages from the last ${lookbackMonths} months`
                : `Importing up to ${maxMessages!.toLocaleString()} messages`}
          </p>
        )}
      </div>

      {/* BACKLOG-2347: sync is automatic once paired — the old "tap Sync Now"
          how-to was misleading (and duplicated the source-picker instructions).
          Replaced with an accurate one-liner; the guided pairing entry point
          lives in the import-source section's "Connect your Android phone" CTA. */}
      <div className="mb-3 p-3 bg-green-50 rounded text-xs text-green-700 border border-green-200">
        <p>
          Messages sync <strong>automatically</strong> over WiFi. Keep both
          devices on the same network with the Keepr Companion app installed.
        </p>
      </div>

      {/* Force Re-import Button */}
      <button
        onClick={() => setShowForceWarning(true)}
        disabled={resetting}
        className="w-full px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title="Reset sync timestamp so the companion app re-sends all messages"
      >
        {resetting ? "Resetting..." : "Force Re-import"}
      </button>

      {/* Force re-import warning confirmation */}
      {showForceWarning && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-300 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">
                Force re-import will delete all Android data
              </p>
              <p className="text-xs text-amber-700 mt-1">
                This deletes all synced messages and contacts from the local database,
                then stops the sync server. Open the companion app and tap Sync Now to
                re-import everything from scratch.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleForceReimport}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded transition-all"
                >
                  Continue with Re-import
                </button>
                <button
                  onClick={() => setShowForceWarning(false)}
                  className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 text-xs font-medium rounded border border-gray-300 transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AndroidMessagesSettings;
