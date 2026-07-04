/**
 * App.tsx - Main Application Component
 *
 * This is the root component that composes the application from modular pieces:
 * - NotificationProvider: Unified notification system (toasts)
 * - UpdateNotification: Auto-update notification (BACKLOG-610: always visible)
 * - LicenseGate: Blocks app when license invalid (SPRINT-062)
 * - AppShell: Layout structure (title bar, offline banner, version info)
 * - TrialStatusBanner: Shows trial days remaining (SPRINT-062)
 * - AppRouter: Screen routing based on current step
 * - AppModals: Modal dialogs (profile, settings, etc.)
 * - SupportWidget: Floating "?" button (TASK-2282: visible on ALL screens)
 *
 * Note: LicenseProvider is in main.tsx (must wrap App for useAppStateMachine to use useLicense).
 *
 * All state management is handled by useAppStateMachine hook.
 * The app state machine is passed as a single prop to child components,
 * eliminating prop drilling and providing semantic methods instead of raw setters.
 */

import {
  AppShell,
  AppRouter,
  AppModals,
  useAppStateMachine,
} from "./appCore";
import { NotificationProvider } from "./contexts/NotificationContext";
import { IPhoneSyncProvider } from "./contexts/IPhoneSyncContext";
import { LicenseGate, TrialStatusBanner } from "./components/license";
import UpdateNotification from "./components/UpdateNotification";
import { SupportWidget } from "./components/support/SupportWidget";

function App() {
  const app = useAppStateMachine();

  return (
    <NotificationProvider>
      {/* BACKLOG-610: UpdateNotification must be outside LicenseGate
          so it's visible even when license is blocked/loading or user is stuck */}
      <UpdateNotification />
      <LicenseGate>
        {/* BACKLOG-1706: userId lets the provider resolve the iPhone-sync opt-in
            (off by default on macOS) and gate device detection accordingly. */}
        <IPhoneSyncProvider userId={app.currentUser?.id ?? null}>
          <AppShell app={app}>
            <TrialStatusBanner />
            <AppRouter app={app} />
            <AppModals app={app} />
          </AppShell>
        </IPhoneSyncProvider>
      </LicenseGate>
      {/* TASK-2282: SupportWidget outside LicenseGate so it's visible on ALL screens
          including login, onboarding, error states, and license-blocked states.
          Widget detects auth state internally via IPC. */}
      <SupportWidget />
    </NotificationProvider>
  );
}

export default App;
