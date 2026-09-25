import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/electron/renderer";
import App from "./App";
import { AuthProvider, NetworkProvider, PlatformProvider, useAuth, LicenseProvider, useLicense } from "./contexts";
import { StrictFeatureProvider } from "./contexts/StrictFeatureContext";
import ErrorBoundary from "./components/ErrorBoundary";
import {
  FeatureFlaggedProvider,
  LoadingOrchestrator,
} from "./appCore/state/machine";
import { clearCorruptedSession } from "./utils/clearCorruptedSession";
import "./index.css";

// Initialize Sentry in the renderer process (TASK-1967)
// Renderer inherits DSN and configuration from the main process via IPC
Sentry.init({
  // Scrub PII from events before sending to Sentry (BACKLOG-1119)
  beforeSend(event) {
    // Scrub email addresses from breadcrumb messages
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.message && typeof breadcrumb.message === 'string') {
          breadcrumb.message = breadcrumb.message.replace(
            /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            '[REDACTED_EMAIL]'
          );
        }
      }
    }
    return event;
  },
});

// BACKLOG-1632: Clear corrupted Supabase session data from localStorage
// before the SDK can attempt to parse it. Reports to Sentry if corruption found.
const corruptedKeys = clearCorruptedSession();
if (corruptedKeys.length > 0) {
  Sentry.captureMessage("Corrupted Supabase session cleared from localStorage", {
    level: "warning",
    tags: {
      component: "clearCorruptedSession",
      issue: "BACKLOG-1632",
    },
    extra: {
      corruptedKeys,
      count: corruptedKeys.length,
    },
  });
}

// Capture unhandled promise rejections in the renderer (BACKLOG-1119)
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  Sentry.captureException(
    event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? 'Unhandled promise rejection')),
    { tags: { mechanism: 'unhandledrejection' } }
  );
});

/**
 * Wrapper component that provides LicenseProvider with userId from AuthContext.
 * Must be rendered inside AuthProvider.
 */
function LicenseProviderWithAuth({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuth();
  return (
    <LicenseProvider userId={currentUser?.id ?? null}>
      <StrictFeatureProviderWithSession>{children}</StrictFeatureProviderWithSession>
    </LicenseProvider>
  );
}

/**
 * BACKLOG-3476: the session's strict plan answer for checklists, resolved once
 * above the transaction modal. Must be rendered inside LicenseProvider.
 */
function StrictFeatureProviderWithSession({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuth();
  const { organizationId } = useLicense();
  return (
    <StrictFeatureProvider userId={currentUser?.id ?? null} organizationId={organizationId}>
      {children}
    </StrictFeatureProvider>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PlatformProvider>
        <NetworkProvider>
          <AuthProvider>
            <LicenseProviderWithAuth>
              <FeatureFlaggedProvider>
                <LoadingOrchestrator>
                  <App />
                </LoadingOrchestrator>
              </FeatureFlaggedProvider>
            </LicenseProviderWithAuth>
          </AuthProvider>
        </NetworkProvider>
      </PlatformProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
