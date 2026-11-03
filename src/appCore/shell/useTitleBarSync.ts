/**
 * BACKLOG-4115 PR-3: the title-bar device sync pill's wiring — which pill
 * (if any) and what a click opens. AppShell calls it once and passes the
 * result to TitleBar, which stays presentational.
 *
 * Source: a second useImportSource instance (SR N7, accepted for 2.45: one
 * more cloud preferences read when Settings closes). iPhone state: the
 * app-level IPhoneSyncProvider (no provider = no iPhone pill). Detection
 * on/off: useIPhoneSyncEnabled (SR B2). Android: useAndroidSyncState, polling
 * only while the Android pill is visible (SR B6).
 */
import { useEffect, useState } from "react";
import type { AppStateMachine } from "../state/types";
import { isOnboardingStep } from "../routing";
import { useImportSource } from "../../hooks/useImportSource";
import { useAndroidSyncState } from "../../hooks/useAndroidSyncState";
import { useIPhoneSyncEnabled, useOptionalIPhoneSyncContext } from "../../contexts/IPhoneSyncContext";
import { usePlatform } from "../../contexts/PlatformContext";
import { useRetryCountdown } from "../../utils/syncRetryCooldown";
import { deriveAndroidPill, deriveCompanionPill, deriveIPhonePill, type SyncPillState } from "./syncPillState";

/**
 * Q2 (founder ruling, 2.45.0-pre.3 test): the pill shows, and stays clickable,
 * on every signed-in screen whose title bar is visible — the dashboard, the
 * Settings page (dashboard step underneath) and the error screen. Never during
 * onboarding, loading, or signed out. `false` is the dashboard-only
 * alternative, kept for tests. (Transactions and Contacts open as full-window
 * overlays, AppModals.tsx, that cover the title bar — BACKLOG-4123, 2.46.)
 */
export const PILL_ON_EVERY_SCREEN = true;

type VisibilityInput = Pick<AppStateMachine, "currentStep" | "isAuthenticated" | "currentUser"> & {
  modalState: Pick<AppStateMachine["modalState"], "showSettings">;
};

/** The ONE visibility condition (Q2). */
export function pillVisible(app: VisibilityInput, everyScreen: boolean = PILL_ON_EVERY_SCREEN): boolean {
  if (!everyScreen) return app.currentStep === "dashboard" && !app.modalState.showSettings;
  return app.isAuthenticated && !!app.currentUser && !isOnboardingStep(app.currentStep) && app.currentStep !== "loading";
}

export interface TitleBarSync {
  pill: SyncPillState | null;
  onClick: () => void;
}

const NOOP = () => {};

/** Re-renders every `ms` while `on`, so "Synced 2 hours ago" stays true. */
function useClock(ms: number, on: boolean): number {
  // The state only forces re-renders; the clock is read at render time.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return Date.now();
}

export function useTitleBarSync(app: AppStateMachine, everyScreen: boolean = PILL_ON_EVERY_SCREEN): TitleBarSync {
  const { isMacOS } = usePlatform();
  const source = useImportSource(app.currentUser?.id, app.modalState.showSettings);
  const iphone = useOptionalIPhoneSyncContext();
  const { enabled: iphoneEnabled } = useIPhoneSyncEnabled();
  const visible = pillVisible(app, everyScreen);
  const android = useAndroidSyncState(visible && source === "android-messages-web");
  useRetryCountdown(visible ? iphone?.retryAvailableAt : null); // re-renders the "Try again in N s" count
  const now = useClock(30_000, visible && source !== null);

  if (!visible) return { pill: null, onClick: NOOP };
  if (source === "iphone-sync" && iphone) {
    return { pill: deriveIPhonePill(iphone, iphoneEnabled, now, { isMacOS }), onClick: app.openIPhoneSync };
  }
  if (source === "android-messages-web") {
    return {
      pill: deriveAndroidPill(android.ext, android.status, android.jobStep, android.linkView, now),
      onClick: () => app.openAndroidSync(),
    };
  }
  if (source === "android-companion") return { pill: deriveCompanionPill(), onClick: () => app.openAndroidSync() };
  return { pill: null, onClick: NOOP };
}
