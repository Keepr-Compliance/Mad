import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ResponsiveModal } from "./common/ResponsiveModal";
import { LLMSettings } from "./settings/LLMSettings";
import { MacOSMessagesImportSettings } from "./settings/MacOSMessagesImportSettings";
import { AndroidMessagesSettings } from "./settings/AndroidMessagesSettings";
import { ImportSourceSettings } from "./settings/ImportSourceSettings";
import { IphoneSyncSettings } from "./settings/IphoneSyncSettings";
import { FeatureGate } from "./common/FeatureGate";
import { SettingsTabBar } from "./settings/SettingsTabBar";
import { GeneralSettings } from "./settings/GeneralSettings";
import { EmailSettings } from "./settings/EmailSettings";
import { ContactsSettings } from "./settings/ContactsSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { DataPrivacySettings } from "./settings/DataPrivacySettings";
import { TroubleshootingSettings } from "./settings/TroubleshootingSettings";
import { AboutSettings } from "./settings/AboutSettings";
import { SyncToolsSettings } from "./settings/SyncToolsSettings";
import { useScrollSpy } from "@/hooks/useScrollSpy";
import { useFeatureGate } from "@/hooks/useFeatureGate";
import { usePlatform } from "@/contexts/PlatformContext";
import { OfflineNotice } from './common/OfflineNotice';
import { settingsService } from '../services';
import logger from '../utils/logger';
import type { ImportSource } from '../services/settingsService';
import type { PreferencesResult } from './settings/types';

const SETTINGS_TABS = [
  { id: "settings-general", label: "General" },
  { id: "settings-email", label: "Email" },
  { id: "settings-messages", label: "Messages" },
  // BACKLOG-1937: merged "Sync Tools" + iPhone USB toggle into one iPhone Sync category
  { id: "settings-iphone-sync", label: "iPhone Sync" },
  { id: "settings-contacts", label: "Contacts" },
  { id: "settings-ai", label: "AI" },
  { id: "settings-security", label: "Security" },
  { id: "settings-data", label: "Data & Privacy" },
  { id: "settings-troubleshooting", label: "Troubleshooting" },
  { id: "settings-about", label: "About" },
];

interface SettingsComponentProps {
  onClose: () => void;
  userId: string;
  onLogout?: () => Promise<void>;
  onEmailConnected?: (email: string, provider: "google" | "microsoft") => void;
  onEmailDisconnected?: (provider: "google" | "microsoft") => void;
}

/** Settings — tab container that delegates to focused sub-components. */
function Settings({ onClose, userId, onLogout, onEmailConnected, onEmailDisconnected }: SettingsComponentProps) {
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");
  // BACKLOG-1937: renderer-safe platform detection (contextIsolation=true → no process.platform)
  const { isWindows, isMacOS } = usePlatform();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const visibleTabs = useMemo(
    () =>
      SETTINGS_TABS.filter((t) => {
        if (t.id === "settings-ai" && !hasAIAddon) return false;
        // BACKLOG-1937: iPhone Sync category shows on all platforms (grayed, not hidden)
        return true;
      }),
    [hasAIAddon]
  );
  const visibleTabIds = useMemo(() => visibleTabs.map((t) => t.id), [visibleTabs]);

  // Preferences loaded once and distributed to sub-components as initial values
  const [loadingPreferences, setLoadingPreferences] = useState<boolean>(true);
  const [preferences, setPreferences] = useState<PreferencesResult['preferences']>(undefined);

  // Connection status reported by EmailSettings, needed by ContactsSettings
  const [isGoogleConnected, setIsGoogleConnected] = useState<boolean>(false);
  const [isMicrosoftConnected, setIsMicrosoftConnected] = useState<boolean>(false);

  // BACKLOG-1458: Track active import source for adaptive Messages section
  const [activeImportSource, setActiveImportSource] = useState<ImportSource | null>(null);

  const activeTabId = useScrollSpy(visibleTabIds, scrollContainerRef, 48, !loadingPreferences);

  const handleTabClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const handleConnectionStatusChange = useCallback((google: boolean, microsoft: boolean) => {
    setIsGoogleConnected(google);
    setIsMicrosoftConnected(microsoft);
  }, []);

  // Load all preferences once on mount
  useEffect(() => {
    const loadPreferences = async (): Promise<void> => {
      setLoadingPreferences(true);
      try {
        const result = await settingsService.getPreferences(userId);
        const prefs = result.data as PreferencesResult['preferences'];
        if (result.success && prefs) {
          setPreferences(prefs);

          // BACKLOG-1458: Derive active import source from preferences + phoneType
          // The messages.source field is stored in preferences but not in PreferencesResult type
          const messagesPrefs = (prefs as Record<string, unknown>).messages as
            | { source?: ImportSource }
            | undefined;
          if (messagesPrefs?.source) {
            setActiveImportSource(messagesPrefs.source);
          } else {
            // No saved source — check phoneType for default
            const phoneResult = await settingsService.getPhoneType(userId);
            if (phoneResult.success && phoneResult.data === 'android') {
              setActiveImportSource('android-companion');
            } else {
              setActiveImportSource(isMacOS ? 'macos-native' : 'iphone-sync');
            }
          }
        } else if (!result.success) {
          logger.error("[Settings] Failed to load preferences:", result.error);
        }
      } catch (error) {
        logger.error("[Settings] Error loading preferences:", error);
      } finally {
        setLoadingPreferences(false);
      }
    };
    if (userId) {
      loadPreferences();
    }
  }, [userId, isMacOS]);

  // BACKLOG-1458: Callback for ImportSourceSettings to notify parent of source changes
  const handleImportSourceChange = useCallback((newSource: ImportSource) => {
    setActiveImportSource(newSource);
  }, []);

  return (
    <ResponsiveModal onClose={onClose} overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-3xl sm:max-h-[90vh]">
        {/* Header */}
        <div
          className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-purple-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg"
          data-testid="settings-page"
        >
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              data-testid="settings-close"
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h2 className="text-lg font-bold text-white">Settings</h2>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <h2 className="text-xl font-bold text-white">Settings</h2>
            <button
              onClick={onClose}
              data-testid="settings-close"
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Settings Content - Scrollable area */}
        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto scroll-smooth scroll-pt-12 px-6 pb-6">
          {loadingPreferences ? (
            <div className="flex flex-col items-center justify-center pt-24 pb-20">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-gray-500">Loading settings...</p>
            </div>
          ) : (
          <>
            <SettingsTabBar tabs={visibleTabs} activeTabId={activeTabId} onTabClick={handleTabClick} />
            <div className="sticky top-10 z-10 -mx-6 bg-white">
              <OfflineNotice />
            </div>

            <GeneralSettings userId={userId} initialPreferences={preferences} />

            <EmailSettings
              userId={userId}
              initialPreferences={preferences}
              onEmailConnected={onEmailConnected}
              onEmailDisconnected={onEmailDisconnected}
              onConnectionStatusChange={handleConnectionStatusChange}
            />

            {/* Messages Import — adapts per active import source (BACKLOG-1458) */}
            <div id="settings-messages" className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Messages</h3>
              <div className="space-y-4">
                <ImportSourceSettings userId={userId} onSourceChange={handleImportSourceChange} />
                {/* BACKLOG-1937: iPhone USB toggle moved to the dedicated iPhone Sync category below */}
                {activeImportSource === 'android-companion' ? (
                  <AndroidMessagesSettings userId={userId} />
                ) : (
                  <MacOSMessagesImportSettings userId={userId} />
                )}
              </div>
            </div>

            {/* iPhone Sync — merged USB toggle + (Windows) Apple driver tools (BACKLOG-1937).
                Grayed out when the import source is not iPhone. */}
            {(() => {
              const iphoneSourceActive = activeImportSource === 'iphone-sync';
              return (
                <div id="settings-iphone-sync" className="mb-8">
                  <h3
                    className={`text-lg font-semibold mb-4 ${
                      iphoneSourceActive ? "text-gray-900" : "text-gray-400"
                    }`}
                  >
                    iPhone Sync
                  </h3>
                  {!iphoneSourceActive && (
                    <p className="text-xs text-gray-400 mb-4">
                      Available when your import source is set to iPhone.
                    </p>
                  )}
                  <div className="space-y-4">
                    {/* BACKLOG-1706: iPhone-over-USB detection opt-in (off by default on macOS) */}
                    <IphoneSyncSettings disabled={!iphoneSourceActive} />
                    {/* Apple Mobile Device driver tools — Windows only (TASK-2277) */}
                    {isWindows && <SyncToolsSettings disabled={!iphoneSourceActive} />}
                  </div>
                </div>
              );
            })()}

            <ContactsSettings
              userId={userId}
              initialPreferences={preferences}
              isMicrosoftConnected={isMicrosoftConnected}
              isGoogleConnected={isGoogleConnected}
            />

            {/* AI Settings - Only visible with AI add-on (BACKLOG-462) */}
            <FeatureGate requires="ai_addon">
              <div id="settings-ai" className="mb-8">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">AI Settings</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-gray-900">Transaction Detection</h4>
                      <p className="text-xs text-gray-600 mt-1">
                        Scans your email for new transactions since your last scan. First scan covers 1 month.
                      </p>
                    </div>
                    <span className="ml-4 text-sm text-gray-500 font-medium bg-gray-100 px-3 py-1.5 rounded border border-gray-200">
                      Automatic
                    </span>
                  </div>
                  <LLMSettings userId={userId} />
                </div>
              </div>
            </FeatureGate>

            <SecuritySettings userId={userId} onLogout={onLogout} />

            <DataPrivacySettings userId={userId} />
            <TroubleshootingSettings />
            <AboutSettings />
          </>
          )}
        </div>

        {/* Footer — hidden on mobile (back button in header handles close) */}
        <div className="hidden sm:block flex-shrink-0 bg-gray-50 px-6 py-4 border-t border-gray-200 rounded-b-xl">
          <button
            onClick={onClose}
            className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2.5 px-4 rounded-lg transition-all"
          >
            Done
          </button>
        </div>
    </ResponsiveModal>
  );
}

export default Settings;
