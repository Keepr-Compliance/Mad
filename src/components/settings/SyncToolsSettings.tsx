/**
 * SyncToolsSettings — Apple driver status & install/repair (Windows only)
 *
 * BACKLOG-1937: Renders as a plain panel inside the "iPhone Sync" Settings
 * category (no longer owns its own section wrapper/heading). When `disabled`
 * (import source ≠ iPhone) the card is grayed and install/repair actions are
 * blocked; driver status is still displayed.
 *
 * Uses the existing IPC bridge:
 *   window.api.drivers.checkApple()   → drivers:check-apple
 *   window.api.drivers.installApple() → drivers:install-apple
 *   window.api.drivers.hasBundled()   → drivers:has-bundled
 */

import React, { useState, useEffect, useCallback } from "react";
import logger from "../../utils/logger";
import { safeErrorMessage } from "../../utils/formatUtils";

// ---------------------------------------------------------------------------
// Types — mirrors WindowApiDrivers return shapes (no duplicate of AppleDriverStatus)
// ---------------------------------------------------------------------------

interface DriverStatusInfo {
  isInstalled: boolean;
  version: string | null;
  serviceRunning: boolean;
  error: string | null;
}

interface InstallProgress {
  phase: "idle" | "downloading" | "installing" | "complete" | "error";
  message: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SyncToolsSettingsProps {
  /**
   * BACKLOG-1937: When true the panel is grayed and install/repair actions are
   * blocked (import source ≠ iPhone). Driver status is still shown.
   */
  disabled?: boolean;
}

export function SyncToolsSettings({ disabled = false }: SyncToolsSettingsProps) {
  const [driverStatus, setDriverStatus] = useState<DriverStatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [installProgress, setInstallProgress] = useState<InstallProgress>({
    phase: "idle",
    message: "",
  });
  // BACKLOG-1943: gate the actual installer call behind an inline confirmation
  // so the Windows UAC/admin elevation prompt doesn't appear with no warning.
  const [confirmingInstall, setConfirmingInstall] = useState(false);

  // ------------------------------------------------------------------
  // Check driver status on mount
  // ------------------------------------------------------------------
  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const status = await window.api.drivers?.checkApple();
      if (status) {
        setDriverStatus({
          isInstalled: status.isInstalled,
          version: status.version,
          serviceRunning: status.serviceRunning,
          error: status.error,
        });
      } else {
        setDriverStatus(null);
      }
    } catch (err) {
      logger.error("[SyncTools] Failed to check drivers:", err);
      setDriverStatus({
        isInstalled: false,
        version: null,
        serviceRunning: false,
        error: "Failed to check driver status",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // ------------------------------------------------------------------
  // Install / Repair handler
  // ------------------------------------------------------------------
  const handleInstall = useCallback(async () => {
    setInstallProgress({ phase: "downloading", message: "Preparing installation..." });

    try {
      setInstallProgress({ phase: "installing", message: "Installing drivers (admin privileges required)..." });

      const result = await window.api.drivers?.installApple();

      if (result?.success) {
        setInstallProgress({ phase: "complete", message: "Sync tools installed successfully." });
        // Refresh status after a short delay to let services start
        setTimeout(() => {
          refreshStatus();
        }, 2000);
      } else {
        setInstallProgress({
          phase: "error",
          message: safeErrorMessage(result?.error, "Installation failed. Try installing iTunes from the Microsoft Store."),
        });
      }
    } catch (err) {
      setInstallProgress({
        phase: "error",
        message: err instanceof Error ? err.message : "Installation failed",
      });
    }
  }, [refreshStatus]);

  // ------------------------------------------------------------------
  // Install confirmation gate (BACKLOG-1943)
  // ------------------------------------------------------------------
  const handleRequestInstall = useCallback(() => {
    setConfirmingInstall(true);
  }, []);

  const handleConfirmInstall = useCallback(() => {
    setConfirmingInstall(false);
    handleInstall();
  }, [handleInstall]);

  const handleCancelInstall = useCallback(() => {
    setConfirmingInstall(false);
  }, []);

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------
  const isInstalling = installProgress.phase === "downloading" || installProgress.phase === "installing";

  return (
    <div className={`space-y-4 ${disabled ? "opacity-50" : ""}`}>
        {/* Description */}
        <p className={`text-sm ${disabled ? "text-gray-400" : "text-gray-600"}`}>
          iPhone sync requires Apple Mobile Device Support to communicate with your device.
        </p>

        {/* Driver Status Card */}
        <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3">
          {/* Driver install status row */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Apple Mobile Device Support</span>
            {loading ? (
              <span className="text-sm text-gray-500">Checking...</span>
            ) : driverStatus?.error && !driverStatus.isInstalled ? (
              <span className="text-sm text-red-600">Error: {safeErrorMessage(driverStatus.error)}</span>
            ) : driverStatus?.isInstalled ? (
              <span className="text-sm text-green-600">
                Installed{driverStatus.version ? ` (v${driverStatus.version})` : ""}
              </span>
            ) : (
              <span className="text-sm text-red-600">Not Installed</span>
            )}
          </div>

          {/* Service status row — only when drivers are installed */}
          {driverStatus?.isInstalled && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Service Status</span>
              <span
                className={`text-sm ${driverStatus.serviceRunning ? "text-green-600" : "text-amber-600"}`}
              >
                {driverStatus.serviceRunning ? "Running" : "Stopped"}
              </span>
            </div>
          )}

          {/* Action buttons */}
          {!loading && !driverStatus?.isInstalled && installProgress.phase === "idle" && !confirmingInstall && (
            <button
              onClick={handleRequestInstall}
              disabled={disabled}
              className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Install Sync Tools
            </button>
          )}

          {!loading &&
            driverStatus?.isInstalled &&
            !driverStatus.serviceRunning &&
            installProgress.phase === "idle" &&
            !confirmingInstall && (
              <button
                onClick={handleRequestInstall}
                disabled={disabled}
                className="w-full px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Repair Installation
              </button>
            )}

          {/* Inline install confirmation (BACKLOG-1943) — replaces the native
              admin-elevation prompt's surprise factor with an in-app warning. */}
          {!disabled && !loading && installProgress.phase === "idle" && confirmingInstall && (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">
                Windows will ask you to approve the installation (an admin prompt will appear). Click Continue to proceed.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleConfirmInstall}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
                >
                  Continue
                </button>
                <button
                  onClick={handleCancelInstall}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Progress indicator */}
          {isInstalling && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-gray-700">{typeof installProgress.message === 'string' ? installProgress.message : String(installProgress.message)}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  role="progressbar"
                  style={{ width: installProgress.phase === "downloading" ? "30%" : "70%" }}
                />
              </div>
            </div>
          )}

          {/* Success display */}
          {installProgress.phase === "complete" && (
            <div className="text-sm text-green-700 bg-green-50 p-3 rounded border border-green-200">
              {typeof installProgress.message === 'string' ? installProgress.message : String(installProgress.message)}
            </div>
          )}

          {/* Error display */}
          {installProgress.phase === "error" && (
            <div className="text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200">
              {typeof installProgress.message === 'string' ? installProgress.message : String(installProgress.message)}
            </div>
          )}
        </div>
    </div>
  );
}
