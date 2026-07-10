/**
 * DiagnosticsPreview Component
 * TASK-2180: Collapsible diagnostics preview for the support ticket dialog.
 *
 * Shows the user what diagnostic data will be attached to their ticket.
 */

import React, { useState } from "react";
import type {
  AppDiagnostics,
  IphoneSyncDiagnostics,
} from "../../hooks/useSupportTicket";

interface DiagnosticsPreviewProps {
  diagnostics: AppDiagnostics | null;
  loading: boolean;
}

/**
 * Collapsible diagnostics preview component.
 * Shows users what app data will be attached to their support ticket.
 */
export function DiagnosticsPreview({
  diagnostics,
  loading,
}: DiagnosticsPreviewProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return (
      <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Collecting diagnostics...
        </div>
      </div>
    );
  }

  if (!diagnostics) {
    return (
      <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
        <p className="text-sm text-gray-500">Diagnostics unavailable</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          Diagnostics (attached automatically)
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-4 w-4 text-gray-400 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 p-3">
          <div className="space-y-2 text-xs text-gray-600 font-mono">
            <DiagRow label="App Version" value={diagnostics.app_version} />
            <DiagRow label="Electron" value={diagnostics.electron_version} />
            <DiagRow
              label="OS"
              value={`${diagnostics.os_platform} ${diagnostics.os_version} (${diagnostics.os_arch})`}
            />
            <DiagRow label="Node" value={diagnostics.node_version} />
            <DiagRow
              label="Database"
              value={`${diagnostics.db_initialized ? "Initialized" : "Not initialized"}, ${
                diagnostics.db_encrypted ? "Encrypted" : "Not encrypted"
              }`}
            />
            <DiagRow
              label="Sync"
              value={
                diagnostics.sync_status.is_running
                  ? `Running: ${diagnostics.sync_status.current_operation || "unknown"}`
                  : "Idle"
              }
            />
            <DiagRow
              label="Email"
              value={`Google: ${diagnostics.email_connections.google ? "Yes" : "No"}, Microsoft: ${
                diagnostics.email_connections.microsoft ? "Yes" : "No"
              }`}
            />
            <DiagRow
              label="Memory"
              value={`${formatBytes(diagnostics.memory_usage.heap_used)} / ${formatBytes(
                diagnostics.memory_usage.heap_total
              )}`}
            />
            <DiagRow
              label="Uptime"
              value={formatUptime(diagnostics.uptime_seconds)}
            />
            {diagnostics.iphone_sync && (
              <IphoneSyncSection iphoneSync={diagnostics.iphone_sync} />
            )}
            {diagnostics.recent_errors.length > 0 && (
              <div>
                <span className="text-gray-500">Recent Errors:</span>
                <ul className="mt-1 space-y-1 pl-2">
                  {diagnostics.recent_errors.map((err, i) => (
                    <li key={i} className="text-red-600 truncate">
                      [{err.operation}] {err.error_message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-400 italic">
            This data helps our team diagnose issues faster. No passwords, tokens,
            or personal content are included.
          </p>
        </div>
      )}
    </div>
  );
}

function DiagRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-500 flex-shrink-0">{label}:</span>
      <span className="text-gray-800 truncate text-right">{value}</span>
    </div>
  );
}

/**
 * BACKLOG-1918: iPhone Sync diagnostics sub-section. Renders the driver /
 * device / companion signals collected for self-diagnosing sync tickets.
 * Booleans/enums/counts only — no UDID/serial is present in the data.
 */
function IphoneSyncSection({
  iphoneSync,
}: {
  iphoneSync: IphoneSyncDiagnostics;
}): React.ReactElement {
  const yesNo = (v: boolean): string => (v ? "Yes" : "No");

  const detectionValue = `Mounted: ${yesNo(iphoneSync.device_mounted)}, Detected: ${yesNo(
    iphoneSync.device_detected
  )} (${iphoneSync.connected_device_count})`;

  return (
    <div className="mt-1 border-t border-gray-200 pt-2">
      <span className="text-gray-500">iPhone Sync:</span>
      <div className="mt-1 space-y-1 pl-2">
        <DiagRow label="Phone Type" value={iphoneSync.phone_type} />
        <DiagRow
          label="libimobiledevice"
          value={iphoneSync.libimobiledevice_available ? "Available" : "Missing"}
        />
        <DiagRow label="Detection" value={detectionValue} />
        {iphoneSync.driver_missing_suspected && (
          <div className="text-red-600">
            Driver missing suspected (device seen by OS but not by sync tools)
          </div>
        )}
        {iphoneSync.trust_state && (
          <DiagRow label="Trust State" value={iphoneSync.trust_state} />
        )}
        <DiagRow
          label="Apple Driver"
          value={`${
            iphoneSync.apple_driver.is_installed ? "Installed" : "Not installed"
          }, Service: ${
            iphoneSync.apple_driver.service_running ? "Running" : "Stopped"
          }${
            iphoneSync.apple_driver.version
              ? ` (${iphoneSync.apple_driver.version})`
              : ""
          }`}
        />
        {iphoneSync.windows && (
          <DiagRow
            label="Windows USB"
            value={`Service: ${iphoneSync.windows.apple_mobile_device_service}, Driver: ${yesNo(
              iphoneSync.windows.apple_usb_driver_present
            )}, PnP: ${yesNo(iphoneSync.windows.pnp_iphone_present)}`}
          />
        )}
        {iphoneSync.phone_type === "android" && (
          <DiagRow
            label="Android Companion"
            value={`Paired: ${yesNo(
              iphoneSync.android_companion.paired
            )}, Connected: ${yesNo(iphoneSync.android_companion.connected)} (${
              iphoneSync.android_companion.device_count
            })`}
          />
        )}
        <DiagRow
          label="iPhone Sync Enabled"
          value={
            iphoneSync.user_settings.iphone_sync_enabled === null
              ? "Default"
              : yesNo(iphoneSync.user_settings.iphone_sync_enabled)
          }
        />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
