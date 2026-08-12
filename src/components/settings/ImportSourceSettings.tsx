/**
 * ImportSourceSettings Component
 *
 * Allows users to choose where their TEXT MESSAGES are imported from:
 * - macOS Messages database (native) [macOS only]
 * - Connected iPhone via iTunes backup (sync)
 * - Android Companion app via WiFi (BACKLOG-1447)
 *
 * Only one import source is active at a time (radio button pattern).
 *
 * BACKLOG-2523: this panel governs `messages.source` and NOTHING else.
 * Contact sources are the independent `contactSources.direct.*` checkboxes
 * under Settings > Contacts — BACKLOG-2477 removed the coupling, so any copy
 * here promising a contacts effect is a false claim about the user's data.
 *
 * @module settings/ImportSourceSettings
 */

import React, { useState, useEffect, useCallback } from "react";
import { usePlatform } from "../../contexts/PlatformContext";
import type { ImportSource, UserPreferences } from "../../services/settingsService";
import { settingsService } from '../../services';
import logger from '../../utils/logger';

// Re-export type for consumers
export type { ImportSource } from "../../services/settingsService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PairedDevice {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  lastSeen: string;
}

interface SyncStatus {
  running: boolean;
  port: number | null;
  address: string | null;
  totalMessagesReceived: number;
  lastSyncTimestamp: number | null;
}

interface ImportSourceSettingsProps {
  userId: string;
  /** Callback when the user changes the import source (BACKLOG-1458) */
  onSourceChange?: (source: ImportSource) => void;
  /**
   * BACKLOG-2347: open the guided Android sync wizard. Used by the unpaired
   * empty-state CTA so there is a single "connect" entry point instead of the
   * old stale "guided setup below" copy.
   */
  onConnectAndroid?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(isoOrTimestamp: string | number): string {
  const date = typeof isoOrTimestamp === "number"
    ? new Date(isoOrTimestamp)
    : new Date(isoOrTimestamp);
  const now = Date.now();
  const diffMs = now - date.getTime();

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
 * Import source settings.
 * Allows switching between macOS native import, iPhone sync, and Android companion.
 */
export function ImportSourceSettings({ userId, onSourceChange, onConnectAndroid }: ImportSourceSettingsProps) {
  const { isMacOS } = usePlatform();
  const [source, setSource] = useState<ImportSource>(isMacOS ? "macos-native" : "iphone-sync");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Android device/sync status (management only). BACKLOG-2289 moved the pairing
  // entry point to the guided AndroidSyncSetup wizard, so this component no
  // longer owns QR generation.
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [androidLoading, setAndroidLoading] = useState(false);

  // Load preference on mount, falling back to phoneType-based default
  useEffect(() => {
    if (!userId) return;

    const loadPreference = async () => {
      setLoading(true);
      try {
        const result = await window.api.preferences.get(userId);
        const prefs = result.preferences as UserPreferences | undefined;
        if (result.success && prefs?.messages?.source) {
          setSource(prefs.messages.source);
        } else {
          // BACKLOG-1458: No saved preference — default based on phoneType
          const phoneResult = await settingsService.getPhoneType(userId);
          if (phoneResult.success && phoneResult.data === 'android') {
            setSource('android-companion');
          }
          // Otherwise keep the platform-based default (macos-native or iphone-sync)
        }
      } catch (error) {
        logger.error("[ImportSourceSettings] Failed to load preference:", error);
      } finally {
        setLoading(false);
      }
    };

    loadPreference();
  }, [userId]);

  // Refresh Android pairing status when that source is selected
  const refreshAndroidStatus = useCallback(async () => {
    setAndroidLoading(true);
    try {
      const [pairingResult, syncResult] = await Promise.all([
        window.api.pairing.getStatus(),
        window.api.localSync.getStatus(),
      ]);

      if (pairingResult.success && pairingResult.status) {
        setDevices(pairingResult.status.devices.map((d: PairedDevice & { secret?: string }) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          pairedAt: d.pairedAt,
          lastSeen: d.lastSeen,
        })));
      }

      setSyncStatus(syncResult);
    } catch (err) {
      logger.error("[ImportSourceSettings] Failed to refresh Android status:", err);
    } finally {
      setAndroidLoading(false);
    }
  }, []);

  useEffect(() => {
    if (source === "android-companion") {
      refreshAndroidStatus();
      const interval = setInterval(refreshAndroidStatus, 10_000);
      return () => clearInterval(interval);
    }
  }, [source, refreshAndroidStatus]);

  const handleSourceChange = useCallback(
    async (newSource: ImportSource) => {
      if (!userId || saving) return;

      setSource(newSource);
      setSaving(true);

      try {
        await window.api.preferences.update(userId, {
          messages: {
            source: newSource,
          },
        });
        // BACKLOG-1458: Notify parent of source change for adaptive Messages section
        onSourceChange?.(newSource);
      } catch (error) {
        logger.error("[ImportSourceSettings] Failed to save preference:", error);
        // Revert on error
        setSource(source);
      } finally {
        setSaving(false);
      }
    },
    [userId, source, saving, onSourceChange]
  );

  const handleDisconnect = useCallback(async (deviceId: string) => {
    try {
      const result = await window.api.pairing.disconnect(deviceId);
      if (result.success) {
        setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId));
      } else {
        logger.error("[ImportSourceSettings] Disconnect failed:", result.error);
      }
    } catch (err) {
      logger.error("[ImportSourceSettings] Disconnect error:", err);
    }
  }, []);

  const handleStopServer = useCallback(async () => {
    try {
      await window.api.localSync.stopServer();
      await refreshAndroidStatus();
    } catch (err) {
      logger.error("[ImportSourceSettings] Stop server error:", err);
    }
  }, [refreshAndroidStatus]);

  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <h4 className="text-sm font-medium text-gray-900 mb-2">Import Source</h4>
      <p className="text-xs text-gray-600 mb-3">
        Choose where to import your text messages from.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {/* Radio: macOS Messages (macOS only)
                BACKLOG-2523: this radio governs MESSAGES only. Mac contacts
                answer to the `macosContacts` checkbox under Settings > Contacts
                regardless of what is selected here — see BACKLOG-2477 and the
                comment on SyncOrchestratorService.getContactsSyncPreferences. */}
            {isMacOS && (
              <label
                className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                  source === "macos-native"
                    ? "border-blue-500 ring-1 ring-blue-500"
                    : "border-gray-200 hover:border-gray-300"
                } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <input
                  type="radio"
                  name="importSource"
                  value="macos-native"
                  checked={source === "macos-native"}
                  onChange={() => handleSourceChange("macos-native")}
                  disabled={saving}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">
                    macOS Messages
                  </div>
                  <div className="text-xs text-gray-500">
                    Import text messages from your Mac's Messages app
                  </div>
                </div>
              </label>
            )}

            {/* Radio: iPhone Sync */}
            <label
              className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                source === "iphone-sync"
                  ? "border-blue-500 ring-1 ring-blue-500"
                  : "border-gray-200 hover:border-gray-300"
              } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <input
                type="radio"
                name="importSource"
                value="iphone-sync"
                checked={source === "iphone-sync"}
                onChange={() => handleSourceChange("iphone-sync")}
                disabled={saving}
                className="mt-0.5 w-5 h-5"
              />
              <div>
                <div className="text-sm font-medium text-gray-900">
                  iPhone Sync
                </div>
                <div className="text-xs text-gray-500">
                  Sync from a connected iPhone{isMacOS ? " (same as Windows experience)" : " via backup"}
                </div>
              </div>
            </label>

            {/* Radio: Android Companion (BACKLOG-1447) */}
            <label
              className={`flex items-start gap-3 p-3 bg-white rounded border cursor-pointer transition-all ${
                source === "android-companion"
                  ? "border-green-500 ring-1 ring-green-500"
                  : "border-gray-200 hover:border-gray-300"
              } ${saving ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <input
                type="radio"
                name="importSource"
                value="android-companion"
                checked={source === "android-companion"}
                onChange={() => handleSourceChange("android-companion")}
                disabled={saving}
                className="mt-0.5 w-5 h-5"
              />
              <div>
                <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                  Android Companion
                  <svg className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
                  </svg>
                </div>
                <div className="text-xs text-gray-500">
                  Sync SMS messages from your Android phone over WiFi
                </div>
              </div>
            </label>
          </div>

          {/* Show iPhone instructions when that source is selected */}
          {source === "iphone-sync" && (
            <div className="mt-3 p-3 bg-blue-50 rounded text-xs text-blue-700">
              <p className="font-medium mb-1">To use iPhone Sync:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Connect your iPhone to this {isMacOS ? "Mac" : "PC"} via USB</li>
                <li>Trust this computer on your iPhone if prompted</li>
                <li>Click "Import from iPhone" to sync messages</li>
              </ol>
            </div>
          )}

          {/* Android Companion details when selected (BACKLOG-1447) */}
          {source === "android-companion" && (
            <div className="mt-3 space-y-3">
              {/* Sync Server Status Card */}
              {syncStatus?.running && (
                <div className="bg-green-50 rounded-lg p-3 border border-green-200">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      <span className="text-xs font-medium text-green-800">Sync Server Active</span>
                    </div>
                    <button
                      onClick={handleStopServer}
                      className="text-xs text-green-700 hover:text-green-900 underline"
                    >
                      Stop
                    </button>
                  </div>
                  <div className="text-xs text-green-700 space-y-0.5">
                    <p>Listening on {syncStatus.address}:{syncStatus.port}</p>
                    {syncStatus.totalMessagesReceived > 0 && (
                      <p>{syncStatus.totalMessagesReceived} messages received</p>
                    )}
                    {syncStatus.lastSyncTimestamp && (
                      <p>Last sync: {formatRelativeTime(syncStatus.lastSyncTimestamp)}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Paired Devices */}
              {androidLoading ? (
                <div className="bg-white rounded-lg p-3 border border-gray-200">
                  <span className="text-xs text-gray-500">Loading devices...</span>
                </div>
              ) : devices.length > 0 ? (
                <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
                  {devices.map((device) => (
                    <div key={device.deviceId} className="p-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{device.deviceName}</p>
                        <p className="text-xs text-gray-500">
                          Paired {formatRelativeTime(device.pairedAt)}
                          {" | "}
                          Last seen {formatRelativeTime(device.lastSeen)}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDisconnect(device.deviceId)}
                        className="text-xs text-red-600 hover:text-red-800 font-medium"
                      >
                        Disconnect
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                /* BACKLOG-2347: single "connect" entry point. Replaces the stale
                   "Use the guided setup below" copy (setup moved to the guided
                   wizard in BACKLOG-2320) and the misleading "tap Sync Now"
                   how-to — one CTA that opens the wizard. */
                <div className="bg-white rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500 mb-2">
                    No devices paired yet.
                  </p>
                  <button
                    onClick={() => onConnectAndroid?.()}
                    className="w-full min-h-[40px] px-3 py-2 bg-green-500 text-white text-sm font-medium rounded hover:bg-green-600 active:bg-green-700 transition-colors"
                  >
                    Connect your Android phone
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ImportSourceSettings;
