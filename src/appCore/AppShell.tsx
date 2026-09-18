/**
 * AppShell Component
 *
 * Provides the main application layout structure including:
 * - Title bar with user menu (Electron only - hidden on web/mobile)
 * - Offline banner
 * - Scrollable content area
 * - Version info button and popup
 */

import React from "react";
import type { AppStateMachine } from "./state/types";
import { OfflineBanner } from "./shell";
import { ResumeSetupBanner } from "../components/setup/ResumeSetupBanner";
import SystemHealthMonitor from "../components/SystemHealthMonitor";
import { isOnboardingStep } from "./routing";
import { useSessionValidator } from "../hooks/useSessionValidator";
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
    isOnline,
    isChecking,
    openProfile,
    openSettings,
    handleRetryConnection,
    handleLogout,
    getPageTitle,
  } = app;

  // TASK-2062: Poll for remote session invalidation
  useSessionValidator({
    isAuthenticated,
    onSessionInvalidated: handleLogout,
  });

  // Detect Electron for title bar drag region
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
      {/* Title Bar - Only show on Electron (desktop) and not on login screen.
          On mobile/web platforms, there is no OS-level drag region needed.
          BACKLOG-1790: this bar is intentionally NOT a drag-region — the single
          global drag surface (WindowDragStrip in App.tsx) overlays its top 36px.
          Interactive elements inside that band (profile button) keep
          .no-drag-region to stay clickable. */}
      {runningInElectron && currentStep !== "login" && (
        <div className="flex-shrink-0 bg-gradient-to-b from-gray-100 to-gray-50 border-b border-gray-200 px-4 py-3 flex items-center justify-between select-none">
          <div className="w-8" /> {/* Spacer for centering */}
          <h1 className="text-sm font-semibold text-gray-700">
            {getPageTitle()}
          </h1>
          {/* User Menu Button */}
          {isAuthenticated && currentUser && (
            <button
              onClick={openProfile}
              className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 hover:from-blue-500 hover:to-purple-600 flex items-center justify-center text-white text-sm font-bold shadow-md transition-all hover:shadow-lg no-drag-region"
              title={`${currentUser.display_name || currentUser.email} - Click for account settings`}
              data-tour="profile-button"
              data-testid="nav-profile"
            >
              {currentUser.avatar_url ? (
                <img
                  src={currentUser.avatar_url}
                  alt="Profile"
                  className="w-8 h-8 rounded-full"
                />
              ) : (
                currentUser.display_name?.[0]?.toUpperCase() ||
                currentUser.email?.[0]?.toUpperCase() ||
                "?"
              )}
            </button>
          )}
        </div>
      )}

      {/* Mobile Header - Show page title and profile on non-Electron platforms */}
      {!runningInElectron && currentStep !== "login" && isAuthenticated && currentUser && (
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between lg:hidden">
          <h1 className="text-base font-semibold text-gray-900">
            {getPageTitle()}
          </h1>
          <button
            onClick={openProfile}
            className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 hover:from-blue-500 hover:to-purple-600 flex items-center justify-center text-white text-sm font-bold shadow-md transition-all hover:shadow-lg"
            title={`${currentUser.display_name || currentUser.email} - Click for account settings`}
            data-tour="profile-button"
            data-testid="nav-profile"
          >
            {currentUser.avatar_url ? (
              <img
                src={currentUser.avatar_url}
                alt="Profile"
                className="w-8 h-8 rounded-full"
              />
            ) : (
              currentUser.display_name?.[0]?.toUpperCase() ||
              currentUser.email?.[0]?.toUpperCase() ||
              "?"
            )}
          </button>
        </div>
      )}

      {/* Offline Banner - Show when network is unavailable */}
      {currentStep !== "login" && (
        <OfflineBanner
          isOnline={isOnline}
          isChecking={isChecking}
          onRetry={handleRetryConnection}
        />
      )}

      {/* Resume Setup Banner (BACKLOG-1709 / BACKLOG-1711) - persistent, floor-aware
          nudge shown in the main app whenever the user is below the onboarding
          data-source floor (no email AND no texts source). Self-gates: renders
          null when the floor is satisfied (incl. texts-only) or dismissed this
          session. Not shown on the login screen. */}
      {currentStep !== "login" && <ResumeSetupBanner app={app} />}

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

      {/* Scrollable Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {children}
      </div>

      {/* TASK-2282: SupportWidget moved to App.tsx to be visible on ALL screens */}
    </div>
  );
}
