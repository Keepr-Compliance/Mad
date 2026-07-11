import React, { useEffect } from "react";
import type { ConnectionStatusProps } from "../../types/iphone";
import { TrustComputerHint } from "./TrustComputerHint";
import logger from "../../utils/logger";

/**
 * ConnectionStatus Component
 * Displays iPhone connection status and provides sync action
 */
/**
 * Format a date as a relative time string (e.g., "2 hours ago", "Yesterday")
 */
function formatLastSyncTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 1000 / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) {
    return "Just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  isConnected,
  device,
  onSyncClick,
  lastSyncTime,
  driverMissing = false,
  onInstallDriver,
  isInstallingDriver = false,
  driverInstallError = null,
}) => {
  useEffect(() => {
    logger.info("[ConnectionStatus] Mounted", { isConnected, device: device?.name, lastSyncTime });
    return () => logger.info("[ConnectionStatus] Unmounted");
  }, []);
  if (!isConnected) {
    // BACKLOG-1919: Driver-absent recovery view. When no device is detected AND
    // the Apple Mobile Device Support driver is missing (Windows), replace the
    // silent "Connect your iPhone" text with an inline one-click install button
    // that triggers the UAC admin prompt directly from this screen. Previously
    // the user was stuck here with zero guidance (root cause of ticket #64).
    if (driverMissing && onInstallDriver) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          {/* Driver-missing icon (amber warning) */}
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-amber-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-gray-800">
            Install Apple Mobile Device Support
          </h3>
          <p className="text-gray-500 mt-2 max-w-sm">
            Your iPhone can&apos;t be detected until Apple&apos;s driver is
            installed. Click below and approve the Windows permission prompt,
            then reconnect your iPhone.
          </p>

          {isInstallingDriver ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-gray-600">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span>Approve the Windows permission prompt to continue...</span>
            </div>
          ) : (
            <button
              onClick={() => {
                logger.info("[ConnectionStatus] Install driver (recovery) clicked");
                onInstallDriver();
              }}
              className="mt-6 px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-medium rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all shadow-md hover:shadow-lg"
            >
              Install Apple Mobile Device Support
            </button>
          )}

          {driverInstallError && !isInstallingDriver && (
            <div className="mt-4 max-w-sm text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200">
              {driverInstallError}
            </div>
          )}

          <p className="text-xs text-gray-400 mt-4 max-w-sm">
            You can also install these tools from Settings &rarr; Sync Tools.
            Keepr does not distribute Apple software — this installs Apple&apos;s
            official driver required to communicate with iPhone devices.
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        {/* Disconnected Phone Icon */}
        <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
          <svg
            className="w-8 h-8 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h3 className="text-xl font-semibold text-gray-800">
          Connect Your iPhone
        </h3>
        <p className="text-gray-500 mt-2 max-w-sm">
          Connect your iPhone using a USB cable to sync messages and contacts.
        </p>
        <TrustComputerHint />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      {/* Connected Phone Icon */}
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      </div>
      <h3 className="text-xl font-semibold text-gray-800">
        {device?.name || "iPhone"}
      </h3>
      <p className="text-sm text-gray-500 mt-1">iOS {device?.productVersion}</p>

      {/* Last sync time */}
      {lastSyncTime && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <svg
            className="w-4 h-4 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
          <span className="text-gray-600">
            Last synced: <span className="font-medium">{formatLastSyncTime(lastSyncTime)}</span>
          </span>
        </div>
      )}

      <button
        onClick={() => { logger.info("[ConnectionStatus] Sync iPhone clicked"); onSyncClick(); }}
        className="mt-6 px-6 py-3 bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-medium rounded-lg hover:from-purple-600 hover:to-indigo-700 transition-all shadow-md hover:shadow-lg"
      >
        {lastSyncTime ? "Sync New Data" : "Sync Messages & Contacts"}
      </button>

      {/* Sync time note - different message for first vs subsequent syncs */}
      <div className="mt-4 flex items-start gap-2 text-left max-w-sm">
        <svg
          className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-xs text-gray-400">
          {lastSyncTime ? (
            <>
              <span className="font-medium text-gray-500">Incremental sync</span> will only transfer new data since your last sync. This is usually much faster.
            </>
          ) : (
            <>
              <span className="font-medium text-gray-500">First sync</span> may take up to two hours depending on your phone's data. Future syncs will be much faster as only new data is transferred.
            </>
          )}
        </p>
      </div>
    </div>
  );
};

export default ConnectionStatus;
