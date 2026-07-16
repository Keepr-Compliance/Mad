/**
 * Tests for useAppStateMachine hook
 *
 * This is the central state machine for the application.
 * Tests verify the hook can be initialized with proper providers
 * and exposes the expected API surface.
 *
 * Note: The hook depends on multiple contexts (Auth, Network, Platform)
 * and flow hooks. We use a wrapper component with actual providers and
 * mock the underlying window.api calls.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../../contexts/AuthContext";
import { NetworkProvider } from "../../../contexts/NetworkContext";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import { LicenseProvider } from "../../../contexts/LicenseContext";
import { AppStateProvider } from "../machine/AppStateContext";
import { useAppStateMachine } from "../useAppStateMachine";
import * as featureFlags from "../machine/utils/featureFlags";

// Mock the feature flags module to enable state machine
jest.mock("../machine/utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const mockIsNewStateMachineEnabled =
  featureFlags.isNewStateMachineEnabled as jest.Mock;

// Capture state from hook for testing
let capturedState: ReturnType<typeof useAppStateMachine> | null = null;

function TestComponent() {
  const state = useAppStateMachine();
  capturedState = state;

  // Use safe property access to avoid crashes on undefined
  return (
    <div data-testid="test-container">
      <span data-testid="current-step">{state?.currentStep ?? "undefined"}</span>
      <span data-testid="is-authenticated">
        {String(state?.isAuthenticated ?? "undefined")}
      </span>
      <span data-testid="is-online">{String(state?.isOnline ?? "undefined")}</span>
      <span data-testid="is-mac">{String(state?.isMacOS ?? "undefined")}</span>
      <span data-testid="is-windows">{String(state?.isWindows ?? "undefined")}</span>
      <span data-testid="has-permissions">
        {String(state?.hasPermissions ?? "undefined")}
      </span>
    </div>
  );
}

// Wrapper with all required providers including AppStateProvider
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PlatformProvider>
      <NetworkProvider>
        <AuthProvider>
          <LicenseProvider userId={null}>
            <AppStateProvider>{children}</AppStateProvider>
          </LicenseProvider>
        </AuthProvider>
      </NetworkProvider>
    </PlatformProvider>
  );
}

// Helper to render with providers
function renderWithProviders() {
  capturedState = null;
  return render(
    <TestWrapper>
      <TestComponent />
    </TestWrapper>,
  );
}

// Setup mock implementations
function setupMocks(options: {
  isAuthenticated?: boolean;
  user?: { id: string; email: string } | null;
  isOnline?: boolean;
  platform?: "darwin" | "win32";
  hasSecureStorage?: boolean;
} = {}) {
  const {
    isAuthenticated = false,
    user = null,
    isOnline = true,
    platform = "darwin",
    hasSecureStorage = false,
  } = options;

  // Mock platform
  (window.api.system as any).platform = platform;

  // Mock auth state
  (window.api.auth.getCurrentUser as jest.Mock).mockResolvedValue(
    isAuthenticated && user ? { user, sessionToken: "test-token" } : null,
  );

  // Mock secure storage check
  (window.api.system.hasEncryptionKeyStore as jest.Mock).mockResolvedValue(
    hasSecureStorage,
  );
  (window.api.system.getSecureStorageStatus as jest.Mock).mockResolvedValue({
    hasKeyStore: hasSecureStorage,
    hasDatabaseKey: hasSecureStorage,
  });
  (window.api.system.initializeSecureStorage as jest.Mock).mockResolvedValue({
    success: true,
  });

  // Mock system checks
  (window.api.system.checkAllPermissions as jest.Mock).mockResolvedValue({
    fullDiskAccess: true,
    contacts: true,
  });
  (window.api.system.checkAllConnections as jest.Mock).mockResolvedValue({
    google: false,
    microsoft: false,
  });
  (window.api.system.checkGoogleConnection as jest.Mock).mockResolvedValue(false);
  (window.api.system.checkMicrosoftConnection as jest.Mock).mockResolvedValue(false);

  // Mock health check for network
  (window.api.system.healthCheck as jest.Mock).mockResolvedValue({
    success: isOnline,
  });

  // Mock phone type
  (window.api.user.getPhoneType as jest.Mock).mockResolvedValue(null);
  (window.api.user.setPhoneType as jest.Mock).mockResolvedValue({ success: true });

  // Mock email onboarding
  (window.api.auth.checkEmailOnboarding as jest.Mock).mockResolvedValue({
    hasEmail: false,
  });
}

describe("useAppStateMachine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedState = null;
    // Enable state machine feature flag (required after legacy code removal)
    mockIsNewStateMachineEnabled.mockReturnValue(true);
    setupMocks();
  });

  describe("initialization", () => {
    it("should render without crashing", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(screen.getByTestId("test-container")).toBeInTheDocument();
      });
    });

    it("should capture state from hook", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });
    });

    it("should have currentStep defined", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.currentStep).toBeDefined();
      });
    });
  });

  describe("context integration", () => {
    it("should have access to auth context values", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      // Auth-related properties should be defined
      expect(capturedState?.isAuthenticated).toBeDefined();
      expect(capturedState?.isAuthLoading).toBeDefined();
    });

    it("should have access to network context values", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      // Network-related properties (using actual property names)
      expect(capturedState?.isOnline).toBeDefined();
      expect(capturedState?.isChecking).toBeDefined(); // Not isNetworkChecking
    });

    it("should have access to platform context values", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      // Platform-related properties should be defined
      expect(capturedState?.isMacOS).toBeDefined();
      expect(capturedState?.isWindows).toBeDefined();
    });
  });

  describe("API surface - navigation", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose goToStep function", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.goToStep).toBe("function");
    });

    it("should expose goToEmailOnboarding function", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.goToEmailOnboarding).toBe("function");
    });
  });

  describe("API surface - modal control", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose profile modal methods", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.openProfile).toBe("function");
      expect(typeof capturedState?.closeProfile).toBe("function");
    });

    it("should expose settings modal methods", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.openSettings).toBe("function");
      expect(typeof capturedState?.closeSettings).toBe("function");
    });

    it("should have modalState object", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(capturedState?.modalState).toBeDefined();
      expect(typeof capturedState?.modalState).toBe("object");
    });
  });

  describe("API surface - auth handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose handleLoginSuccess", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleLoginSuccess).toBe("function");
    });

    it("should expose handleLoginPending", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleLoginPending).toBe("function");
    });

    it("should expose handleLogout", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleLogout).toBe("function");
    });
  });

  describe("API surface - terms handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose handleAcceptTerms", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleAcceptTerms).toBe("function");
    });

    it("should expose handleDeclineTerms", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleDeclineTerms).toBe("function");
    });
  });

  describe("API surface - phone type handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose handleSelectIPhone", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleSelectIPhone).toBe("function");
    });

    it("should expose handleSelectAndroid", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleSelectAndroid).toBe("function");
    });

    it("should expose handlePhoneTypeChange", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handlePhoneTypeChange).toBe("function");
    });
  });

  describe("API surface - email handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose handleStartGoogleEmailConnect", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleStartGoogleEmailConnect).toBe("function");
    });

    it("should expose handleStartMicrosoftEmailConnect", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleStartMicrosoftEmailConnect).toBe("function");
    });

    it("should expose handleEmailOnboardingComplete", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleEmailOnboardingComplete).toBe("function");
    });
  });

  describe("API surface - permission handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose handlePermissionsGranted", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handlePermissionsGranted).toBe("function");
    });

    it("should expose checkPermissions", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.checkPermissions).toBe("function");
    });
  });

  describe("state properties", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should have app state properties", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.hasPermissions).toBeDefined();
        expect(capturedState?.isNewUserFlow).toBeDefined();
      });
    });

    it("should have pending data state", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(capturedState?.pendingOnboardingData).toBeDefined();
      expect("pendingOAuthData" in (capturedState ?? {})).toBe(true);
      // TASK-1603: pendingEmailTokens removed after flow reorder
      // DB is always initialized before email step, so email tokens
      // are saved directly to DB (no pending state needed)
    });

    it("should have secure storage related properties in state object", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      // These properties come from useSecureStorage flow hook
      // They may be undefined if flow hook hasn't initialized
      // Just verify the state object exists and has expected shape
      expect("hasSecureStorageSetup" in (capturedState ?? {})).toBe(true);
      expect("isCheckingSecureStorage" in (capturedState ?? {})).toBe(true);
      expect("isDatabaseInitialized" in (capturedState ?? {})).toBe(true);
    });

    it("should have phone type state", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(capturedState?.hasSelectedPhoneType).toBeDefined();
      expect(capturedState?.selectedPhoneType).toBeDefined();
      expect(capturedState?.isLoadingPhoneType).toBeDefined();
    });
  });

  describe("initial state values", () => {
    it("should start with loading step", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.currentStep).toBe("loading");
      });
    });

    it("should have default pending onboarding data", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.pendingOnboardingData).toEqual({
          termsAccepted: false,
          phoneType: null,
          emailConnected: false,
          emailProvider: null,
        });
      });
    });


    it("should start with tour inactive", async () => {
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.isTourActive).toBe(false);
      });
    });

    it("should have true for hasPermissions initially (prevents flicker)", async () => {
      // Default to true to prevent UI flicker for returning users
      // Actual permission status is verified by async effect
      setupMocks({ isAuthenticated: false });

      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
        expect(capturedState?.hasPermissions).toBe(true);
      });
    });
  });

  describe("UI handlers", () => {
    beforeEach(() => {
      setupMocks({ isAuthenticated: false });
    });

    it("should expose setIsTourActive", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.setIsTourActive).toBe("function");
    });

    it("should expose handleDismissSetupPrompt", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.handleDismissSetupPrompt).toBe("function");
    });

    it("should expose getPageTitle", async () => {
      renderWithProviders();

      await waitFor(() => {
        expect(capturedState).not.toBeNull();
      });

      expect(typeof capturedState?.getPageTitle).toBe("function");
    });
  });
});
