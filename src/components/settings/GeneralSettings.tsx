import React, { useState, useCallback } from "react";
import { useNotification } from "@/hooks/useNotification";
import { useNetwork } from '../../contexts/NetworkContext';
import { settingsService } from '../../services';
import logger from '../../utils/logger';
import { safeErrorMessage } from '../../utils/formatUtils';
import { InfoTooltip } from '../common/InfoTooltip';
import type { PreferencesResult } from './types';

interface GeneralSettingsProps {
  userId: string;
  initialPreferences: PreferencesResult['preferences'];
}

export function GeneralSettings({ userId, initialPreferences }: GeneralSettingsProps) {
  const { notify } = useNotification();
  const { isOnline } = useNetwork();

  // Local state initialized from loaded preferences
  const [autoSyncOnLogin, setAutoSyncOnLogin] = useState<boolean>(() => {
    const val = initialPreferences?.sync?.autoSyncOnLogin;
    return typeof val === "boolean" ? val : true;
  });
  const [autoDownloadUpdates, setAutoDownloadUpdates] = useState<boolean>(() => {
    const val = initialPreferences?.updates?.autoDownload;
    return typeof val === "boolean" ? val : false;
  });
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.notifications?.enabled;
    return typeof val === "boolean" ? val : true;
  });
  const [exportFormat, setExportFormat] = useState<string>(() => {
    return initialPreferences?.export?.defaultFormat || "combined-pdf";
  });
  const [emailExportMode, setEmailExportMode] = useState<"thread" | "individual">(() => {
    const val = (initialPreferences?.export as { emailExportMode?: string } | undefined)?.emailExportMode;
    return (val === "thread" || val === "individual") ? val : "thread";
  });
  const [contentType, setContentType] = useState<"both" | "emails" | "texts">(() => {
    const val = (initialPreferences?.export as { contentType?: string } | undefined)?.contentType;
    return (val === "both" || val === "emails" || val === "texts") ? val : "both";
  });
  const [attachmentType, setAttachmentType] = useState<"all" | "email" | "text" | "none">(() => {
    const val = (initialPreferences?.export as { attachmentType?: string } | undefined)?.attachmentType;
    return (val === "all" || val === "email" || val === "text" || val === "none") ? val : "all";
  });
  const [autoRoleEnabled, setAutoRoleEnabled] = useState<boolean>(() => {
    const val = initialPreferences?.contactAutoRole?.enabled;
    return typeof val === "boolean" ? val : false;
  });
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'up-to-date' | 'available' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');

  // Handlers
  const handleAutoSyncToggle = async (): Promise<void> => {
    const newValue = !autoSyncOnLogin;
    setAutoSyncOnLogin(newValue);
    try {
      await settingsService.updatePreferences(userId, { sync: { autoSyncOnLogin: newValue } });
    } catch {
      // Silently handle
    }
  };

  const handleAutoDownloadToggle = async (): Promise<void> => {
    const newValue = !autoDownloadUpdates;
    setAutoDownloadUpdates(newValue);
    try {
      await settingsService.updatePreferences(userId, { updates: { autoDownload: newValue } });
    } catch {
      // Silently handle
    }
  };

  const handleNotificationsToggle = async (): Promise<void> => {
    const newValue = !notificationsEnabled;
    setNotificationsEnabled(newValue);
    try {
      await settingsService.updatePreferences(userId, { notifications: { enabled: newValue } });
    } catch {
      // Silently handle
    }
  };

  const handleExportFormatChange = async (newFormat: string): Promise<void> => {
    setExportFormat(newFormat);
    try {
      await settingsService.updatePreferences(userId, { export: { defaultFormat: newFormat } });
    } catch {
      // Silently handle
    }
  };

  const handleContentTypeChange = async (value: "both" | "emails" | "texts"): Promise<void> => {
    setContentType(value);
    try {
      await settingsService.updatePreferences(userId, { export: { contentType: value } });
    } catch {
      // Silently handle
    }
  };

  const handleAttachmentTypeChange = async (value: "all" | "email" | "text" | "none"): Promise<void> => {
    setAttachmentType(value);
    try {
      await settingsService.updatePreferences(userId, { export: { attachmentType: value } });
    } catch {
      // Silently handle
    }
  };

  const handleEmailExportModeChange = async (mode: "thread" | "individual"): Promise<void> => {
    setEmailExportMode(mode);
    try {
      await settingsService.updatePreferences(userId, { export: { emailExportMode: mode } });
    } catch (err) {
      logger.error("Failed to save email export mode preference:", err);
    }
  };

  const handleCheckForUpdates = useCallback(async (): Promise<void> => {
    setUpdateStatus('checking');
    try {
      const result = await window.api.update.checkForUpdates();
      if (result?.updateAvailable) {
        setUpdateStatus('available');
        setUpdateVersion(typeof result.version === 'string' ? result.version : String(result.version ?? ''));
      } else {
        setUpdateStatus('up-to-date');
      }
    } catch {
      setUpdateStatus('error');
    }
    // Auto-reset after 5 seconds
    setTimeout(() => setUpdateStatus('idle'), 5000);
  }, []);

  const handleTestNotification = async (): Promise<void> => {
    try {
      const result = await window.api.notification?.send(
        "Test Notification",
        "Desktop notifications are working correctly."
      );
      if (result?.success) {
        notify.success("Desktop notification sent! Check your notification center if you don't see a banner.");
      } else {
        notify.warning(safeErrorMessage(result?.error, "Notifications may not be supported on this system."));
      }
    } catch {
      notify.error("Failed to send test notification.");
    }
  };

  return (
    <div id="settings-general" className="mt-6 mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        General
      </h3>
      <div className="space-y-4">
        {/* Auto-Sync on Login */}
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex-1">
            <h4 className="text-sm font-medium text-gray-900">
              Auto-Sync on Startup
            </h4>
            <p className="text-xs text-gray-600 mt-1">
              Automatically sync your emails and messages once each time you open the app
            </p>
          </div>
          <button
            onClick={handleAutoSyncToggle}
            className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              autoSyncOnLogin ? "bg-blue-500" : "bg-gray-300"
            }`}
            role="switch"
            aria-checked={autoSyncOnLogin}
            aria-label="Auto-sync on startup"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                autoSyncOnLogin ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Auto-Download Updates */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-gray-900">
                Auto-download Updates
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Automatically download new software updates in the background
              </p>
            </div>
            <button
              onClick={handleAutoDownloadToggle}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoDownloadUpdates ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={autoDownloadUpdates}
              aria-label="Auto-download updates"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoDownloadUpdates ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <button
            onClick={handleCheckForUpdates}
            disabled={updateStatus === 'checking' || !isOnline}
            title={!isOnline ? "You are offline" : undefined}
            className="mt-3 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {!isOnline ? 'Check for Updates' :
             updateStatus === 'checking' ? 'Checking...' :
             updateStatus === 'up-to-date' ? 'Up to date' :
             updateStatus === 'available' ? `Update available (v${updateVersion})` :
             updateStatus === 'error' ? 'Check failed' :
             'Check for Updates'}
          </button>
        </div>

        {/* Notifications */}
        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-gray-900">
                Notifications
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                Show desktop notifications for important events
              </p>
            </div>
            <button
              onClick={handleNotificationsToggle}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                notificationsEnabled ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={notificationsEnabled}
              aria-label="Desktop notifications"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  notificationsEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <button
            onClick={handleTestNotification}
            disabled={!notificationsEnabled}
            className="mt-3 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Test Notification
          </button>
        </div>

        {/* Auto-fill Contact Roles (TASK-1397) */}
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex-1">
            <h4 className="text-sm font-medium text-gray-900">
              Auto-fill Contact Roles
            </h4>
            <p className="text-xs text-gray-600 mt-1">
              Automatically assign roles to contacts based on their most recent transaction
            </p>
          </div>
          <button
            onClick={async () => {
              const newValue = !autoRoleEnabled;
              setAutoRoleEnabled(newValue);
              try {
                await settingsService.updatePreferences(userId, {
                  contactAutoRole: { enabled: newValue },
                });
              } catch {
                setAutoRoleEnabled(!newValue);
              }
            }}
            className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              autoRoleEnabled ? "bg-blue-500" : "bg-gray-300"
            }`}
            role="switch"
            aria-checked={autoRoleEnabled}
            aria-label="Auto-fill contact roles"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                autoRoleEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Export Settings — matching ExportModal UI */}
        <div className="space-y-4 bg-gray-50 rounded-lg p-4 border border-gray-200">
          {/* Format — card layout */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Format</label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {([
                { value: "combined-pdf", label: "One PDF", desc: "Combined PDF with all content", tooltip: "Summary report + all email threads + all text conversations merged into a single PDF file" },
                { value: "folder", label: "Audit Package", desc: "Folder with individual PDFs", tooltip: "Export as individual files organized in folders" },
                { value: "pdf", label: "Summary PDF", desc: "Transaction report only", tooltip: "Generate a summary report PDF without full message content" },
              ] as const).map(({ value, label, desc, tooltip }) => (
                <button
                  key={value}
                  onClick={() => handleExportFormatChange(value)}
                  className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                    exportFormat === value
                      ? "bg-purple-500 text-white shadow-md"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <div className="flex items-center">
                    <span className="font-semibold text-sm">{label}</span>
                    <InfoTooltip text={tooltip} />
                  </div>
                  <div className="text-xs opacity-80 mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Content — pill buttons with per-button tooltips */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Content</label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {([
                { value: "both", label: "Both", tooltip: "Export both email threads and text message conversations" },
                { value: "emails", label: "Emails Only", tooltip: "Export only email threads" },
                { value: "texts", label: "Texts Only", tooltip: "Export only text message conversations" },
              ] as const).map(({ value, label, tooltip }) => (
                <button
                  key={value}
                  onClick={() => handleContentTypeChange(value)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    contentType === value
                      ? "bg-purple-500 text-white shadow-sm"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {label}
                    <InfoTooltip text={tooltip} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Attachments — grayed out for Summary PDF */}
          <div className={exportFormat === "pdf" ? "opacity-40 pointer-events-none" : ""}>
            <label className="flex items-center text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Attachments
              <InfoTooltip text="Attachments are exported as separate files in an /attachments folder, not embedded in the PDF." />
            </label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {([
                { value: "all", label: "All", tooltip: "Include both email and text message attachments" },
                { value: "email", label: "Email Only", tooltip: "Include only email attachments (images, documents)" },
                { value: "text", label: "Text Only", tooltip: "Include only text message attachments (photos, videos)" },
                { value: "none", label: "None", tooltip: "Export without any attachments" },
              ] as const).map(({ value, label, tooltip }) => (
                <button
                  key={value}
                  onClick={() => handleAttachmentTypeChange(value)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    attachmentType === value
                      ? "bg-purple-500 text-white shadow-sm"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {label}
                    <InfoTooltip text={tooltip} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Email Mode — grayed out when content is texts only */}
          <div className={contentType === "texts" ? "opacity-40 pointer-events-none" : ""}>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Email Mode</label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {([
                { value: "thread", label: "Thread View", tooltip: "Group emails by conversation thread" },
                { value: "individual", label: "Individual", tooltip: "List each email as a separate entry" },
              ] as const).map(({ value, label, tooltip }) => (
                <button
                  key={value}
                  onClick={() => handleEmailExportModeChange(value)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                    emailExportMode === value
                      ? "bg-purple-500 text-white shadow-sm"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {label}
                    <InfoTooltip text={tooltip} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
