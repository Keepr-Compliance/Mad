/**
 * SettingsLayer — the Settings page as a layer over the app content
 * (BACKLOG-3964).
 *
 * Settings is a full page, not a popup. It is drawn over the routed screen
 * (the Dashboard stays mounted underneath and keeps its state) and over any
 * popup already open (z-[105]: above the popups' z-50..z-[100], below the
 * slice-3 account panel scrim at z-[110]; toasts and the "?" button sit above
 * it — src/constants/zLayers.ts). Opening it closes nothing, and Back
 * only closes Settings, so Back returns to whatever was showing before.
 *
 * Esc is Back. It is caught on window in the capture phase so a popup
 * underneath never also receives it (see useEscapeToClose); a menu or dialog
 * open INSIDE the page keeps its own Escape.
 *
 * The Settings callbacks live here (moved from AppModals), not in AppShell.
 */
import React, { useCallback, useRef } from "react";
import Settings from "../../components/Settings";
import type { AppStateMachine } from "../state/types";
import { useEmailSettingsCallbacks } from "../hooks/useEmailSettingsCallbacks";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { Z_CLASS } from "../../constants/zLayers";
// The support form is mounted at the app root, above this layer (Z_CLASS.supportDialog). Esc belongs to it.
import { isSupportFormOpen } from "../../components/support/supportDialogSelector";
import { INERT } from "./inert";

/** Something open inside the page that should take Escape for itself. */
const NESTED_OVERLAY =
  '[role="menu"], [role="dialog"], [aria-modal="true"], [aria-haspopup][aria-expanded="true"], .fixed.inset-0';

interface SettingsLayerProps {
  app: AppStateMachine;
}

export function SettingsLayer({ app }: SettingsLayerProps) {
  // Mounted only while Settings is shown, so its hooks (Esc, email callbacks)
  // exist only then.
  if (!app.modalState.showSettings || !app.currentUser) return null;
  return <OpenSettingsLayer app={app} user={app.currentUser} />;
}

function OpenSettingsLayer({ app, user }: SettingsLayerProps & { user: NonNullable<AppStateMachine["currentUser"]> }) {
  const {
    modalState,
    authProvider,
    closeSettings,
    clearSettingsTarget,
    openAndroidSync,
    openIPhoneSync,
    openLearnSession,
    openLearnScore,
    handleLogout,
  } = app;
  const rootRef = useRef<HTMLDivElement>(null);

  // BACKLOG-4174: the account panel can open over Settings. Its Esc listener
  // registers after this one on the same window target, so without the
  // showProfile gate one Esc would close Settings and then the panel.
  useEscapeToClose(true, closeSettings, () =>
    modalState.showProfile || !!rootRef.current?.querySelector(NESTED_OVERLAY) || isSupportFormOpen(),
  );

  const { handleEmailConnectedFromSettings, handleEmailDisconnectedFromSettings } =
    useEmailSettingsCallbacks({ userId: user.id });

  // Founder: Settings › Google Messages' Link / Relink — the same modal, at its link step.
  const handleLinkGoogleMessagesFromSettings = useCallback(() => {
    closeSettings();
    openAndroidSync("link");
  }, [closeSettings, openAndroidSync]);

  // BACKLOG-3156 stage G: Settings › Messages › iPhone "Import from iPhone" — the
  // same iPhone sync the dashboard's Sync iPhone card opens.
  const handleImportIphoneFromSettings = useCallback(() => {
    closeSettings();
    openIPhoneSync();
  }, [closeSettings, openIPhoneSync]);

  // BACKLOG-4120 (2.46.1): Help Keepr learn › Start — Settings closes first, then
  // the questions open over the main screen (AppModals). Opened inside Settings,
  // the question dialog sat behind the page and Start appeared to do nothing.
  const handleStartLearnFromSettings = useCallback(
    (total: number) => {
      closeSettings();
      openLearnSession(total);
    },
    [closeSettings, openLearnSession],
  );

  // BACKLOG-4120: Help Keepr learn › See score — the same hand-off as Start.
  const handleSeeLearnScoreFromSettings = useCallback(() => {
    closeSettings();
    openLearnScore();
  }, [closeSettings, openLearnScore]);

  // BACKLOG-4174: under the account panel, Settings stays shown (same scroll,
  // same tab) but takes no focus, click or screen-reader read.
  return (
    <div
      ref={rootRef}
      className={`absolute inset-0 ${Z_CLASS.settings} bg-gray-50`}
      data-testid="settings-layer"
      {...(modalState.showProfile ? INERT : {})}
    >
      <Settings
        userId={user.id}
        account={{ user, provider: authProvider }}
        initialSection={modalState.settingsTarget}
        onSectionReached={clearSettingsTarget}
        onClose={closeSettings}
        onLogout={handleLogout}
        onEmailConnected={handleEmailConnectedFromSettings}
        onEmailDisconnected={handleEmailDisconnectedFromSettings}
        onLinkGoogleMessages={handleLinkGoogleMessagesFromSettings}
        onImportIphone={handleImportIphoneFromSettings}
        onStartLearn={handleStartLearnFromSettings}
        onSeeLearnScore={handleSeeLearnScoreFromSettings}
      />
    </div>
  );
}
