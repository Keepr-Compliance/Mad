import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { LLMSettings } from "./settings/LLMSettings";
import { MacOSMessagesImportSettings } from "./settings/MacOSMessagesImportSettings";
import { GoogleMessagesSettings } from "./settings/GoogleMessagesSettings";
import { GoogleMessagesLinkProvider } from "./settings/android/googleMessagesLink";
import { ImportSourceSettings } from "./settings/ImportSourceSettings";
import { TextsLookbackSettings } from "./settings/TextsLookbackSettings";
import { TextsLookbackProvider } from "./settings/textsLookback";
import { IphoneSyncSettings } from "./settings/IphoneSyncSettings";
import { FeatureGate } from "./common/FeatureGate";
import { SettingsPageHeader } from "./settings/SettingsPageHeader";
import { visibleSettingsTabs } from "./settings/settingsTabs";
import { useSettingsSectionRouting } from "./settings/useSettingsSectionRouting";
import { AccountSettings, type AccountSettingsProps } from "./settings/account/AccountSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { EmailSettings } from "./settings/EmailSettings";
import { ContactsSettings } from "./settings/ContactsSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { DataPrivacySettings } from "./settings/DataPrivacySettings";
import { TroubleshootingSettings } from "./settings/TroubleshootingSettings";
import { SupportAccessSettings } from "./settings/SupportAccessSettings";
import { AboutSettings } from "./settings/AboutSettings";
import { SyncToolsSettings } from "./settings/SyncToolsSettings";
import { useScrollSpy } from "@/hooks/useScrollSpy";
import { useFeatureGate } from "@/hooks/useFeatureGate";
import { usePlatform } from "@/contexts/PlatformContext";
import { useIPhoneSyncEnabled } from "@/contexts/IPhoneSyncContext";
import { OfflineNotice } from './common/OfflineNotice';
import { settingsService } from '../services';
import logger from '../utils/logger';
import type { ImportSource } from '../services/settingsService';
import { shownImportSource } from './settings/importSourceLabels';
import { loadChosenImportSource } from '../services/importSourcePolicy';
import type { PreferencesResult } from './settings/types';


interface SettingsComponentProps {
  onClose: () => void;
  userId: string;
  /** BACKLOG-3964: the Account tab's user and sign-in provider. */
  account: AccountSettingsProps;
  /** BACKLOG-3964: section id (or data-testid) to open at; scrolled to once loaded. */
  initialSection?: string | null;
  /** Called once `initialSection` has been reached (the caller clears it). */
  onSectionReached?: () => void;
  onLogout?: () => Promise<void>;
  onEmailConnected?: (email: string, provider: "google" | "microsoft") => void;
  onEmailDisconnected?: (provider: "google" | "microsoft", anyStillConnected?: boolean) => void;
  /** Settings › Google Messages' Link / Relink: the Sync Android modal at its link step. */
  onLinkGoogleMessages?: () => void;
  /** BACKLOG-3156 stage G: the iPhone pane's "Import from iPhone" — the dashboard's iPhone sync. */
  onImportIphone?: () => void;
}

/**
 * Settings — the full Settings page (BACKLOG-3964: no longer a popup). One
 * header row (Back + tabs), one column of section cards.
 */
function Settings({ onClose, userId, account, initialSection, onSectionReached, onLogout, onEmailConnected, onEmailDisconnected, onLinkGoogleMessages, onImportIphone }: SettingsComponentProps) {
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");
  // BACKLOG-3423: lets a source change re-gate iPhone USB detection live.
  const { applyImportSource } = useIPhoneSyncEnabled();
  // BACKLOG-1937: renderer-safe platform detection (contextIsolation=true → no process.platform)
  const { isWindows, isMacOS } = usePlatform();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // BACKLOG-3964: one tab list, shared with the account side panel.
  const visibleTabs = useMemo(() => visibleSettingsTabs(hasAIAddon), [hasAIAddon]);
  const visibleTabIds = useMemo(() => visibleTabs.map((t) => t.id), [visibleTabs]);

  // Preferences loaded once and distributed to sub-components as initial values
  const [loadingPreferences, setLoadingPreferences] = useState<boolean>(true);
  const [preferences, setPreferences] = useState<PreferencesResult['preferences']>(undefined);

  // Connection status reported by EmailSettings, needed by ContactsSettings
  const [isGoogleConnected, setIsGoogleConnected] = useState<boolean>(false);
  const [isMicrosoftConnected, setIsMicrosoftConnected] = useState<boolean>(false);

  // BACKLOG-1458: Track active import source for adaptive Messages section
  const [activeImportSource, setActiveImportSource] = useState<ImportSource | null>(null);
  // BACKLOG-3892 / BACKLOG-3156 stage F: the texts lookback picker is a row of
  // the LIVE source panel's Import Preferences — macOS Messages (Mac only; it
  // renders nothing off a Mac), Google Messages, or iPhone. Anything else (no
  // source chosen on Windows, a stored macos-native off a Mac) keeps the
  // standalone card. Exactly one picker renders.
  const lookbackHome: 'macos' | 'google' | 'iphone' | 'standalone' =
    isMacOS && activeImportSource === 'macos-native'
      ? 'macos'
      : activeImportSource === 'android-messages-web'
        ? 'google'
        : activeImportSource === 'iphone-sync'
          ? 'iphone'
          : 'standalone';

  // BACKLOG-3964: the tab strip is outside the scroller now, so only a small
  // offset (was 48 for the sticky strip inside it).
  const activeTabId = useScrollSpy(visibleTabIds, scrollContainerRef, 8, !loadingPreferences);
  useSettingsSectionRouting(initialSection, !loadingPreferences, scrollContainerRef, onSectionReached);

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
          // BACKLOG-3418: through the one shared derivation, so this section,
          // the source radio, the Dashboard button and iPhone detection agree.
          // A Windows/Linux user who chose nothing gets `null`: no source shown,
          // and the iPhone Sync (USB) toggle stays disabled.
          // SR C6: a stored "android-companion" shows as Google Messages.
          const chosen = await loadChosenImportSource(
            prefs as Parameters<typeof loadChosenImportSource>[0],
            isMacOS,
            () => settingsService.getPhoneType(userId),
          );
          setActiveImportSource(chosen ? shownImportSource(chosen) : null);
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
    // BACKLOG-3423: re-gate iPhone USB detection on the new source without
    // waiting for a restart — switching away from iPhone stops the 2s device
    // poll, switching back to it starts it again. This writes no preference:
    // the user's stored `iphoneSyncEnabled` choice is left exactly as it was.
    applyImportSource(newSource);
  }, [applyImportSource]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50" data-testid="settings-page">
        <SettingsPageHeader onBack={onClose} tabs={visibleTabs} activeTabId={activeTabId} onTabClick={handleTabClick} />
        <div className="flex-none bg-white">
          <OfflineNotice />
        </div>

        {/* One column of section cards (mock: max 760px). Each direct section
            child is styled as a white card here, so the section components keep
            their own markup. */}
        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto scroll-smooth scroll-pt-2 px-3 py-4 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-[760px] [&>[id^=settings-]]:!mt-0 [&>[id^=settings-]]:!mb-4 [&>[id^=settings-]]:rounded-xl [&>[id^=settings-]]:border [&>[id^=settings-]]:border-gray-200 [&>[id^=settings-]]:bg-white [&>[id^=settings-]]:p-4 sm:[&>[id^=settings-]]:p-5">
          {loadingPreferences ? (
            <div className="flex flex-col items-center justify-center pt-24 pb-20">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-gray-500">Loading settings...</p>
            </div>
          ) : (
          <>
            <AccountSettings {...account} mailboxes={{ google: isGoogleConnected, microsoft: isMicrosoftConnected }} />

            <GeneralSettings userId={userId} initialPreferences={preferences} />


            <EmailSettings
              userId={userId}
              initialPreferences={preferences}
              onEmailConnected={onEmailConnected}
              onEmailDisconnected={onEmailDisconnected}
              onConnectionStatusChange={handleConnectionStatusChange}
            />

            {/* BACKLOG-3156 stage F: one lookback value for the Messages AND
                iPhone Sync sections — the picker can sit in either. */}
            <TextsLookbackProvider userId={userId}>
            {/* BACKLOG-3156 stage G: one owner of the Google Messages link state
                for the Sources card's Android row and the Google pane. */}
            <GoogleMessagesLinkProvider>
            {/* Messages Import — adapts per active import source (BACKLOG-1458) */}
            <div id="settings-messages" className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Messages</h3>
              <div className="space-y-4">
                <ImportSourceSettings
                  userId={userId}
                  onSourceChange={handleImportSourceChange}
                  onLinkGoogleMessages={onLinkGoogleMessages}
                />
                {/* BACKLOG-3892 S3: ONE "How far back to import texts" picker for
                    every source, on Mac and Windows. Founder QA 2026-10-12 /
                    BACKLOG-3156 stage F: it sits inside the live source panel's
                    Import Preferences (macOS Messages, Google Messages, iPhone);
                    only with no such panel is it this standalone card. Exactly
                    one renders. */}
                {lookbackHome === 'standalone' && <TextsLookbackSettings userId={userId} />}
                {/* BACKLOG-3156 stage G (founder approved 2026-10-13): one pane per
                    selected source — Import Preferences, Stored on this computer,
                    its actions. SR C6 (founder): the Android Companion panel is
                    no longer mounted. */}
                {activeImportSource === 'android-messages-web' ? (
                  /* BACKLOG-3659 P3d: Android with Google Messages (Keepr's
                     extension). Its link status and Link / Relink / Unlink are
                     on the Android row of the Sources card above. */
                  <GoogleMessagesSettings
                    userId={userId}
                    lookbackPicker={
                      lookbackHome === 'google' ? <TextsLookbackSettings userId={userId} embedded /> : undefined
                    }
                  />
                ) : activeImportSource === 'iphone-sync' ? (
                  /* BACKLOG-1706 / BACKLOG-3156 stage G: the iPhone pane — the USB
                     detection opt-in, what is stored from iPhone, and Import. */
                  <IphoneSyncSettings
                    userId={userId}
                    onImportIphone={onImportIphone}
                    lookbackPicker={
                      lookbackHome === 'iphone' ? <TextsLookbackSettings userId={userId} embedded /> : undefined
                    }
                  />
                ) : (
                  /* BACKLOG-2335: the macOS panel is live only for macos-native
                     (an unknown stored value reads as that on a Mac, 3749). */
                  <MacOSMessagesImportSettings
                    userId={userId}
                    enabled={activeImportSource === 'macos-native'}
                    lookbackPicker={
                      lookbackHome === 'macos' ? <TextsLookbackSettings userId={userId} embedded /> : undefined
                    }
                  />
                )}
              </div>
            </div>
            </GoogleMessagesLinkProvider>

            {/* iPhone Sync — the Windows Apple Mobile Device driver tools
                (TASK-2277 / BACKLOG-1937). BACKLOG-3156 stage G: the USB toggle
                moved into the Messages section's iPhone pane, so this section
                is Windows-only. Grayed out when the import source is not iPhone. */}
            {isWindows && (() => {
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
                    <SyncToolsSettings disabled={!iphoneSourceActive} />
                  </div>
                </div>
              );
            })()}
            </TextsLookbackProvider>

            <ContactsSettings
              userId={userId}
              initialPreferences={preferences}
              isMicrosoftConnected={isMicrosoftConnected}
              isGoogleConnected={isGoogleConnected}
              messagesImportSource={activeImportSource}
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
            <SupportAccessSettings />
            <AboutSettings />
          </>
          )}
          </div>
        </div>
    </div>
  );
}

export default Settings;
