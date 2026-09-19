import React, { useState, useEffect, useCallback } from "react";
import { useNotification } from "@/hooks/useNotification";
import { useNetwork } from '../../contexts/NetworkContext';
import logger from '../../utils/logger';
import { safeErrorMessage } from '../../utils/formatUtils';
import { formatRelativeTime } from './types';

interface ActiveDevice {
  device_id: string;
  device_name: string;
  os: string;
  platform: string;
  last_seen_at: string;
  isCurrentDevice: boolean;
}

interface SecuritySettingsProps {
  userId: string;
  onLogout?: () => Promise<void>;
}

export function SecuritySettings({ userId, onLogout }: SecuritySettingsProps) {
  const { notify } = useNotification();
  const { isOnline } = useNetwork();

  const [signingOutAllDevices, setSigningOutAllDevices] = useState<boolean>(false);
  const [activeDevices, setActiveDevices] = useState<ActiveDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState<boolean>(false);

  // Load active devices
  const loadActiveDevices = useCallback(async () => {
    if (!userId || !isOnline) return;
    setDevicesLoading(true);
    try {
      const result = await window.api.auth.getActiveDevices(userId);
      if (result?.success && result.devices) {
        setActiveDevices(result.devices);
      }
    } catch (err) {
      logger.error("Failed to load active devices:", err);
    } finally {
      setDevicesLoading(false);
    }
  }, [userId, isOnline]);

  useEffect(() => {
    loadActiveDevices();
  }, [loadActiveDevices]);

  // Sign out all devices
  const handleSignOutAllDevices = async (): Promise<void> => {
    const confirmed = window.confirm(
      "This will sign you out of all devices, including this one. You will need to log in again.\n\nContinue?"
    );
    if (!confirmed) return;
    setSigningOutAllDevices(true);
    try {
      const result = await window.api.auth.signOutAllDevices();
      if (result.success) {
        if (onLogout) {
          await onLogout();
        }
      } else {
        notify.error("Failed to sign out of all devices: " + safeErrorMessage(result.error, "Unknown error"));
      }
    } catch (error) {
      logger.error("Failed to sign out of all devices:", error);
      notify.error("Failed to sign out of all devices. Please try again.");
    } finally {
      setSigningOutAllDevices(false);
    }
  };

  return (
    <div id="settings-security" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Security
      </h3>
      <div className="space-y-3">
        {/* TASK-2045: Sign out all devices */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-gray-900">
                Sign Out All Devices
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Sign out of all active sessions across all your devices
              </p>
            </div>
            <button
              onClick={handleSignOutAllDevices}
              disabled={signingOutAllDevices || !isOnline}
              title={!isOnline ? "You are offline" : undefined}
              className="ml-4 px-3 py-2 bg-white border border-red-300 text-red-700 hover:bg-red-50 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {signingOutAllDevices ? "Signing out..." : "Sign Out All Devices"}
            </button>
          </div>
        </div>

        {/* TASK-2062: Active Sessions */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="text-sm font-medium text-gray-900">
                Active Sessions
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Devices where your account is currently logged in
              </p>
            </div>
            <button
              onClick={loadActiveDevices}
              disabled={devicesLoading || !isOnline}
              title={!isOnline ? "You are offline" : "Refresh device list"}
              className="px-2 py-1 text-xs font-medium text-gray-600 bg-white hover:bg-gray-100 rounded border border-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {devicesLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {devicesLoading && activeDevices.length === 0 ? (
            <p className="text-xs text-gray-500">Loading devices...</p>
          ) : activeDevices.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              {isOnline ? "No active sessions found." : "Go online to view active sessions."}
            </p>
          ) : (
            <div className="space-y-2">
              {activeDevices.map((device) => (
                <div
                  key={device.device_id}
                  className={`p-3 rounded border text-xs ${
                    device.isCurrentDevice
                      ? "bg-blue-50 border-blue-200"
                      : "bg-white border-gray-100"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg
                        className="w-4 h-4 text-gray-400 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                      </svg>
                      <span className="font-medium text-gray-800">
                        {typeof device.device_name === 'string' ? (device.device_name || "Unknown device") : "Unknown device"}
                      </span>
                      {device.isCurrentDevice && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
                          This device
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-gray-500 ml-6">
                    <span>{String(device.os || device.platform || "Unknown")}</span>
                    <span className="text-gray-300">|</span>
                    <span>
                      {formatRelativeTime(device.last_seen_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
