/**
 * AppRouter Component
 *
 * Handles routing between different application screens based on currentStep.
 * This is a pure extraction of the routing logic from App.tsx.
 */

import { useState, useCallback, useMemo, lazy, Suspense } from "react";
import Login from "../components/Login";
import Dashboard from "../components/Dashboard";
import OfflineFallback from "../components/OfflineFallback";
import { UpgradeScreen, upgradeReasonFor, type UpgradeReason } from "../components/license/UpgradeScreen";
import type { AppStateMachine } from "./state/types";
import { useImportSource } from "../hooks/useImportSource";
import { useOpenLinkScreen } from "../hooks/useOpenLinkScreen";
import { useReportCurrentScreenName } from "../utils/currentScreenName";
import { makeOpenTransactionAt } from "./openTransactionRequest";
import {
  USE_NEW_ONBOARDING,
  isOnboardingStep,
  LoadingScreen,
} from "./routing";

// BACKLOG-1096: Lazy-load route components not needed on initial render.
const OnboardingFlow = lazy(() =>
  import("../components/onboarding").then((m) => ({ default: m.OnboardingFlow }))
);

interface AppRouterProps {
  app: AppStateMachine;
}

export function AppRouter({ app }: AppRouterProps) {
  const {
    // State
    currentStep, isOnline, isChecking, connectionError,
    currentUser,
    // Handlers
    handleLoginSuccess, handleLoginPending, handleDeepLinkAuthSuccess,
    handleRetryConnection,
    openAuditTransaction, openTransactions, openContacts,
    setIsTourActive, openIPhoneSync, openAndroidSync, openSettings,
    handleLogout,
  } = app;

  // BACKLOG-3965 PR-4b: the ONE helper Dashboard rows call (store write + open view).
  const openTransactionAt = useMemo(() => makeOpenTransactionAt(openTransactions), [openTransactions]);

  // Track license blocked state for login screen
  const [licenseBlocked, setLicenseBlocked] = useState<{
    blocked: boolean;
    reason: UpgradeReason;
    userId?: string; // BACKLOG-4038: support form prefill for the blocked user
  }>({ blocked: false, reason: "unknown" });

  // Handle license blocked during login
  const handleLicenseBlocked = useCallback((data: { userId: string; blockReason: string }) => {
    // BACKLOG-4038: expired -> ended, suspended -> suspended, anything else -> fallback.
    setLicenseBlocked({ blocked: true, reason: upgradeReasonFor(data.blockReason), userId: data.userId });
  }, []);

  // Handle logout from UpgradeScreen - reset blocked state and call app logout
  const handleUpgradeScreenLogout = useCallback(async () => {
    setLicenseBlocked({ blocked: false, reason: "unknown" });
    await handleLogout();
  }, [handleLogout]);

  // BACKLOG-1653: Import source preference to gate iPhone sync card.
  const importSource = useImportSource(currentUser?.id, app.modalState.showSettings);
  // C1: keepr://link opens the link screen (Settings › Google Messages).
  useOpenLinkScreen(openAndroidSync);
  useReportCurrentScreenName(currentStep, app.modalState as unknown as Record<string, unknown>);

  // New onboarding architecture (when enabled)
  if (USE_NEW_ONBOARDING && isOnboardingStep(currentStep)) {
    return <Suspense fallback={<LoadingScreen />}><OnboardingFlow app={app} /></Suspense>;
  }

  // Loading state
  if (currentStep === "loading") {
    return <LoadingScreen />;
  }

  // Login screen (with offline fallback)
  if (currentStep === "login") {
    // Show UpgradeScreen if license was blocked during login
    if (licenseBlocked.blocked) {
      return <UpgradeScreen reason={licenseBlocked.reason} userId={licenseBlocked.userId} onLogout={handleUpgradeScreenLogout} />;
    }

    if (!isOnline) {
      return (
        <OfflineFallback
          isOffline={true}
          isRetrying={isChecking}
          error={connectionError}
          onRetry={handleRetryConnection}
          mode="fullscreen"
        />
      );
    }
    // Window dragging on the login screen is provided by the global
    // WindowDragStrip rendered in App.tsx (BACKLOG-1790)
    return (
      <Login
        onLoginSuccess={handleLoginSuccess}
        onLoginPending={handleLoginPending}
        onDeepLinkAuthSuccess={handleDeepLinkAuthSuccess}
        onLicenseBlocked={handleLicenseBlocked}
      />
    );
  }

  // Dashboard
  if (currentStep === "dashboard") {
    // BACKLOG-1653: Show iPhone sync card based on import source preference,
    // not platform or phone type. Card shows when user explicitly selects
    // "iphone-sync" in Settings, regardless of macOS or Windows.
    const showIPhoneSyncButton = importSource === "iphone-sync";
    // BACKLOG-2320: Show Android sync card based on import source preference,
    // mirroring the iPhone flow. Card shows when the user selects the Android
    // companion ("android-companion") as their import source in Settings.
    // BACKLOG-3659: also for Android with Google Messages (Keepr's extension).
    const showAndroidSyncButton = importSource === "android-companion" || importSource === "android-messages-web";

    return (
      <Dashboard
        onAuditNew={openAuditTransaction}
        onViewTransactions={openTransactions}
        onManageContacts={openContacts}
        onSyncPhone={showIPhoneSyncButton ? openIPhoneSync : undefined}
        onSyncAndroid={showAndroidSyncButton ? openAndroidSync : undefined}
        onTourStateChange={setIsTourActive}
        onTriggerRefresh={app.triggerRefresh}
        onOpenSettings={openSettings}
        onOpenTransaction={openTransactionAt}
        user={currentUser ?? undefined}
      />
    );
  }

  // Fallback - should not reach here
  return null;
}
