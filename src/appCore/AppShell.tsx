/**
 * AppShell Component
 *
 * Provides the main application layout structure including:
 * - Title bar / mobile header (shell/TitleBar)
 * - Offline banner
 * - Scrollable content area
 * - Version info button and popup
 */

import React from "react";
import type { AppStateMachine } from "./state/types";
import { ShellBanners, ShellContent, TitleBar } from "./shell";
import SystemHealthMonitor from "../components/SystemHealthMonitor";
import { isOnboardingStep } from "./routing";
import { useSessionValidator } from "../hooks/useSessionValidator";
import { useSessionIdleTimeout } from "../hooks/useIdleSessionExpiry";
import { isElectron } from "../utils/platform";
// TASK-2282: SupportWidget moved to App.tsx (outside auth routes)

// OAuthProvider type to match SystemHealthMonitor expectations
// Note: 'azure' is Microsoft's Azure AD provider
type OAuthProvider = "google" | "microsoft" | "azure";

interface AppShellProps {
  app: AppStateMachine;
  children: React.ReactNode;
}

export function AppShell({ app, children }: AppShellProps) {
  const {
    currentStep,
    isAuthenticated,
    isDatabaseInitialized,
    currentUser,
    authProvider,
    isTourActive,
    needsTermsAcceptance,
    openProfile,
    openSettings,
    handleLogout,
    getPageTitle,
    modalState,
  } = app;

  // TASK-2062: Poll for remote session invalidation
  useSessionValidator({
    isAuthenticated,
    onSessionInvalidated: handleLogout,
  });
  // BACKLOG-3833: user input keeps the session alive; main signs out an idle one
  useSessionIdleTimeout({ isAuthenticated, onExpired: handleLogout });

  // Electron renders the full title bar; web/mobile renders the mobile header
  const runningInElectron = isElectron();

  // PRIMARY DATABASE INITIALIZATION GATE
  // Block all content for authenticated users until database is ready
  // This prevents "Database is not initialized" errors from modal bypass
  // EXCEPTION: Don't block during onboarding - DB init is deferred for first-time macOS users
  // and will be initialized during the secure-storage/keychain step in onboarding
  if (isAuthenticated && !isDatabaseInitialized && !isOnboardingStep(currentStep)) {
    return (
      <div className="min-h-screen min-h-dvh bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        {/* Window dragging during init is provided by the global WindowDragStrip
            rendered in App.tsx (BACKLOG-1790) */}
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Initializing secure storage...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh h-screen flex flex-col bg-gray-50 overflow-hidden">
      {/* Title bar (Electron) / mobile header — BACKLOG-3964: see shell/TitleBar */}
      <TitleBar
        runningInElectron={runningInElectron}
        currentStep={currentStep}
        isAuthenticated={isAuthenticated}
        currentUser={currentUser}
        title={modalState.showSettings ? "Settings" : getPageTitle()}
        onOpenAccount={openProfile}
      />

      <ShellBanners app={app} />

      {/* System Health Monitor - Show permission/connection errors */}
      {/* BACKLOG-2127: mount whenever on the dashboard, NOT gated on
          hasEmailConnected — otherwise the reconnect banner unmounts exactly
          when a stored connection's token breaks (hasEmailConnected flips
          false), so the user never sees a reconnect prompt.

          BACKLOG-3219: `hasPermissions` is gone from this gate for the same
          class of reason, one subsystem over. SystemHealthMonitor is the
          component that REPORTS a missing permission — `diagnosticHandlers`
          pushes `permissions.errors` into its issue list precisely when
          `!permissions.allGranted` — so gating it on that permission being
          PRESENT meant the banner could never fire for the users it exists to
          help. The condition was redundant when permissions are fine and
          inverted when they are not.

          Nothing replaces it, deliberately. The component already decides its
          own visibility (`if (hidden || visibleIssues.length === 0) return
          null`), so a healthy Mac renders nothing from a mounted monitor.
          Substituting `!hasPermissions` would be the same mistake pointed the
          other way — it would suppress the OAuth reconnect banner for every
          user who HAS granted Full Disk Access, i.e. nearly all of them.

          Not a regression from BACKLOG-3212: before it, a user without Full
          Disk Access never reached the dashboard, so this gate was never
          exercised in the failing direction. 3212 correctly releases a user
          who skipped, and that is what made the inversion reachable.

          The remaining conditions were each re-examined and kept.
          `isAuthenticated` / `currentUser` because `currentUser.id` is both
          the `userId` prop and the remount `key`; `authProvider` because it
          supplies the `provider` prop; `currentStep === "dashboard"` because
          that is the surface this banner belongs to. `isTourActive` and
          `needsTermsAcceptance` are NOT render conditions — they are the
          `hidden` prop below, which the component honours itself. */}
      {isAuthenticated &&
        currentUser &&
        authProvider &&
        currentStep === "dashboard" && (
          <SystemHealthMonitor
            key={`health-monitor-${currentUser.id}`}
            userId={currentUser.id}
            provider={authProvider as OAuthProvider}
            hidden={isTourActive || needsTermsAcceptance}
            onOpenSettings={openSettings}
          />
        )}

      {/* Scrollable content area + the Settings page layer (BACKLOG-3964) */}
      <ShellContent app={app}>{children}</ShellContent>

      {/* TASK-2282: SupportWidget moved to App.tsx to be visible on ALL screens */}
    </div>
  );
}
