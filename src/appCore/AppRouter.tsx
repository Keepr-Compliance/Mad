/**
 * AppRouter Component
 *
 * Handles routing between different application screens based on currentStep.
 * This is a pure extraction of the routing logic from App.tsx.
 */

import { useState, useCallback, useRef, lazy, Suspense } from "react";
import Login from "../components/Login";
import Dashboard from "../components/Dashboard";
import OfflineFallback from "../components/OfflineFallback";
import { UpgradeScreen, type UpgradeReason } from "../components/license/UpgradeScreen";
import type { AppStateMachine } from "./state/types";
import { useImportSource } from "../hooks/useImportSource";
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
    hasEmailConnected, showSetupPromptDismissed,
    // Handlers
    handleLoginSuccess, handleLoginPending, handleDeepLinkAuthSuccess,
    handleRetryConnection,
    openAuditTransaction, openTransactions, openContacts,
    handleDismissSetupPrompt, setIsTourActive, openIPhoneSync, openSettings,
    handleLogout,
  } = app;

  // Ref for scroll-to-highlight targets in Settings modal (cross-component).
  // The Settings modal mounts/unmounts dynamically, so the ref is re-resolved
  // each time via the callback below.
  const scrollTargetRef = useRef<HTMLElement | null>(null);

  // Track license blocked state for login screen
  const [licenseBlocked, setLicenseBlocked] = useState<{
    blocked: boolean;
    reason: UpgradeReason;
  }>({ blocked: false, reason: "unknown" });

  // Handle license blocked during login
  const handleLicenseBlocked = useCallback((data: { userId: string; blockReason: string }) => {
    // Map blockReason to UpgradeReason
    let reason: UpgradeReason = "unknown";
    if (data.blockReason === "expired") {
      reason = "trial_expired";
    } else if (data.blockReason === "transaction_limit") {
      reason = "transaction_limit";
    } else if (data.blockReason === "suspended") {
      reason = "suspended";
    }
    setLicenseBlocked({ blocked: true, reason });
  }, []);

  // Handle logout from UpgradeScreen - reset blocked state and call app logout
  const handleUpgradeScreenLogout = useCallback(async () => {
    setLicenseBlocked({ blocked: false, reason: "unknown" });
    await handleLogout();
  }, [handleLogout]);

  // BACKLOG-1653: Import source preference to gate iPhone sync card.
  const importSource = useImportSource(currentUser?.id, app.modalState.showSettings);

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
      return <UpgradeScreen reason={licenseBlocked.reason} onLogout={handleUpgradeScreenLogout} />;
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

    // Scroll to and highlight a target element inside the Settings modal.
    // Reusable helper for handleContinueSetup and handleOpenSettings.
    const scrollToSettingsSection = (elementId: string) => {
      setTimeout(() => {
        scrollTargetRef.current = document.getElementById(elementId);
        if (scrollTargetRef.current) {
          scrollTargetRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
          scrollTargetRef.current.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
          const el = scrollTargetRef.current;
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
          }, 3000);
        }
      }, 500);
    };

    // Handler to open Settings and scroll to Email Connections section
    const handleContinueSetup = () => {
      openSettings();
      scrollToSettingsSection("settings-email");
    };

    // Handler to open Settings, optionally scrolling to a specific section
    const handleOpenSettings = (scrollTarget?: string) => {
      openSettings();
      if (scrollTarget) {
        scrollToSettingsSection(scrollTarget);
      }
    };

    return (
      <Dashboard
        onAuditNew={openAuditTransaction}
        onViewTransactions={openTransactions}
        onManageContacts={openContacts}
        onSyncPhone={showIPhoneSyncButton ? openIPhoneSync : undefined}
        onTourStateChange={setIsTourActive}
        showSetupPrompt={!hasEmailConnected && !showSetupPromptDismissed}
        onContinueSetup={handleContinueSetup}
        onDismissSetupPrompt={handleDismissSetupPrompt}
        onTriggerRefresh={app.triggerRefresh}
        onOpenSettings={handleOpenSettings}
        user={currentUser ?? undefined}
      />
    );
  }

  // Fallback - should not reach here
  return null;
}
