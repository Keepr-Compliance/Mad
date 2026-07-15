/**
 * Tests for AppRouter.tsx
 *
 * Tests routing logic based on app state machine states.
 * Each test verifies the correct component renders for a given currentStep.
 *
 * Strategy: Mock all child components to isolate routing logic.
 * We don't test child component internals, only that the correct one renders.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppRouter } from "../AppRouter";
import type { AppStateMachine } from "../state/types";

// Mock all child components to isolate routing logic
jest.mock("../../components/Login", () => {
  const MockLogin = (props: Record<string, unknown>) => (
    <div data-testid="login-component" data-props={JSON.stringify(Object.keys(props))}>
      Login Screen
    </div>
  );
  MockLogin.displayName = "Login";
  return { __esModule: true, default: MockLogin };
});

jest.mock("../../components/Dashboard", () => {
  const MockDashboard = () => <div data-testid="dashboard-component">Dashboard</div>;
  MockDashboard.displayName = "Dashboard";
  return { __esModule: true, default: MockDashboard };
});

jest.mock("../../components/OfflineFallback", () => {
  const MockOfflineFallback = () => <div data-testid="offline-fallback-component">Offline Fallback</div>;
  MockOfflineFallback.displayName = "OfflineFallback";
  return { __esModule: true, default: MockOfflineFallback };
});

jest.mock("../../components/onboarding", () => ({
  OnboardingFlow: () => <div data-testid="onboarding-flow-component">Onboarding Flow</div>,
}));

jest.mock("../../components/license/UpgradeScreen", () => ({
  UpgradeScreen: ({ reason }: { reason: string }) => (
    <div data-testid="upgrade-screen-component" data-reason={reason}>
      Upgrade Screen
    </div>
  ),
}));

// BACKLOG-1653: Mock useImportSource hook (extracted from AppRouter)
jest.mock("../../hooks/useImportSource", () => ({
  useImportSource: () => "macos-native",
}));

// Mock routing utilities
jest.mock("../routing", () => ({
  USE_NEW_ONBOARDING: false,
  isOnboardingStep: () => false,
  LoadingScreen: () => <div data-testid="loading-screen-component">Loading Screen</div>,
}));

// Helper to create default modal state
const createModalState = (
  overrides: Partial<AppStateMachine["modalState"]> = {}
): AppStateMachine["modalState"] => ({
  showProfile: false,
  showSettings: false,
  showTransactions: false,
  showContacts: false,
  showAuditTransaction: false,
  showVersion: false,
  showMoveAppPrompt: false,
  showTermsModal: false,
  showIPhoneSync: false,
  ...overrides,
});

// Default mock user
const mockUser = {
  id: "user-123",
  email: "test@example.com",
  display_name: "Test User",
  avatar_url: undefined,
};

// Helper to create default app state machine mock
const createAppStateMock = (
  overrides: Partial<AppStateMachine> = {}
): AppStateMachine => ({
  // Navigation
  currentStep: "dashboard",

  // Auth
  isAuthenticated: true,
  isAuthLoading: false,
  currentUser: mockUser,
  sessionToken: "test-token",
  authProvider: "google",
  subscription: undefined,
  needsTermsAcceptance: false,

  // Network
  isOnline: true,
  isChecking: false,
  connectionError: null,

  // Platform
  isMacOS: true,
  isWindows: false,

  // Permissions
  hasPermissions: true,

  // Secure storage
  hasSecureStorageSetup: true,
  isCheckingSecureStorage: false,
  isDatabaseInitialized: true,
  isInitializingDatabase: false,

  // Email onboarding
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  isCheckingEmailOnboarding: false,

  // Phone type
  hasSelectedPhoneType: true,
  selectedPhoneType: "iphone",
  isLoadingPhoneType: false,
  needsDriverSetup: false,

  // New user flow
  isNewUserFlow: false,

  // Pending data
  pendingOAuthData: null,
  pendingOnboardingData: {
    termsAccepted: false,
    phoneType: null,
    emailConnected: false,
    emailProvider: null,
  },

  // Modal state
  modalState: createModalState(),

  // UI state
  showSetupPromptDismissed: false,
  isTourActive: false,
  appPath: "/Applications/Keepr.app",

  // Sync status
  syncStatus: undefined,
  isAnySyncing: false,
  currentSyncMessage: null,
  triggerRefresh: jest.fn().mockResolvedValue(undefined),

  // Modal methods
  openProfile: jest.fn(),
  closeProfile: jest.fn(),
  openSettings: jest.fn(),
  closeSettings: jest.fn(),
  openTransactions: jest.fn(),
  closeTransactions: jest.fn(),
  openContacts: jest.fn(),
  closeContacts: jest.fn(),
  openAuditTransaction: jest.fn(),
  closeAuditTransaction: jest.fn(),
  toggleVersion: jest.fn(),
  closeVersion: jest.fn(),
  openTermsModal: jest.fn(),
  closeTermsModal: jest.fn(),
  openMoveAppPrompt: jest.fn(),
  closeMoveAppPrompt: jest.fn(),
  openIPhoneSync: jest.fn(),
  closeIPhoneSync: jest.fn(),

  // Navigation
  goToStep: jest.fn(),
  goToEmailOnboarding: jest.fn(),

  // Auth handlers
  handleLoginSuccess: jest.fn(),
  handleLoginPending: jest.fn(),
  handleDeepLinkAuthSuccess: jest.fn(),
  handleLogout: jest.fn().mockResolvedValue(undefined),

  // Terms handlers
  handleAcceptTerms: jest.fn().mockResolvedValue(undefined),
  handleDeclineTerms: jest.fn().mockResolvedValue(undefined),

  // Phone type handlers
  handleSelectIPhone: jest.fn().mockResolvedValue(undefined),
  handleSelectAndroid: jest.fn(),
  handleAndroidGoBack: jest.fn(),
  handleAndroidContinueWithEmail: jest.fn().mockResolvedValue(undefined),
  handlePhoneTypeChange: jest.fn().mockResolvedValue(undefined),
  handleAppleDriverSetupComplete: jest.fn().mockResolvedValue(undefined),
  handleAppleDriverSetupSkip: jest.fn().mockResolvedValue(undefined),

  // Email onboarding handlers
  handleEmailOnboardingComplete: jest.fn().mockResolvedValue(undefined),
  handleEmailOnboardingSkip: jest.fn().mockResolvedValue(undefined),
  handleEmailOnboardingBack: jest.fn(),
  handleStartGoogleEmailConnect: jest.fn().mockResolvedValue(undefined),
  handleStartMicrosoftEmailConnect: jest.fn().mockResolvedValue(undefined),

  // Keychain handlers
  handleKeychainExplanationContinue: jest.fn().mockResolvedValue(undefined),
  handleKeychainBack: jest.fn(),

  // Permission handlers
  handlePermissionsGranted: jest.fn(),
  checkPermissions: jest.fn().mockResolvedValue(undefined),

  // Network handlers
  handleRetryConnection: jest.fn().mockResolvedValue(undefined),

  // UI handlers
  handleDismissSetupPrompt: jest.fn(),
  setIsTourActive: jest.fn(),
  handleDismissMovePrompt: jest.fn(),
  handleNotNowMovePrompt: jest.fn(),

  // Utility
  getPageTitle: jest.fn().mockReturnValue("Keepr."),

  ...overrides,
});

describe("AppRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Loading State", () => {
    it("should render LoadingScreen when currentStep is loading", () => {
      const app = createAppStateMock({ currentStep: "loading" });
      render(<AppRouter app={app} />);
      expect(screen.getByTestId("loading-screen-component")).toBeInTheDocument();
    });
  });

  describe("Login State", () => {
    it("should render Login component when currentStep is login and online", () => {
      const app = createAppStateMock({
        currentStep: "login",
        isOnline: true,
        isAuthenticated: false,
        currentUser: null,
      });
      render(<AppRouter app={app} />);
      expect(screen.getByTestId("login-component")).toBeInTheDocument();
    });

    it("should render OfflineFallback when currentStep is login and offline", () => {
      const app = createAppStateMock({
        currentStep: "login",
        isOnline: false,
        isAuthenticated: false,
        currentUser: null,
      });
      render(<AppRouter app={app} />);
      expect(screen.getByTestId("offline-fallback-component")).toBeInTheDocument();
    });

    it("should not render Login when offline", () => {
      const app = createAppStateMock({
        currentStep: "login",
        isOnline: false,
      });
      render(<AppRouter app={app} />);
      expect(screen.queryByTestId("login-component")).not.toBeInTheDocument();
    });
  });

  describe("Dashboard State", () => {
    it("should render Dashboard when step is dashboard", () => {
      const app = createAppStateMock({ currentStep: "dashboard" });
      render(<AppRouter app={app} />);
      expect(screen.getByTestId("dashboard-component")).toBeInTheDocument();
    });
  });

  describe("Onboarding Flow", () => {
    it("should not render OnboardingFlow when USE_NEW_ONBOARDING is disabled", () => {
      // With USE_NEW_ONBOARDING mocked as false, onboarding steps fall through to null
      const app = createAppStateMock({ currentStep: "phone-type-selection" });
      const { container } = render(<AppRouter app={app} />);
      expect(screen.queryByTestId("onboarding-flow-component")).not.toBeInTheDocument();
      // Legacy route blocks removed - falls through to null fallback
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Fallback", () => {
    it("should render null for unknown steps", () => {
      // Force an unknown step by casting
      const app = createAppStateMock({
        currentStep: "unknown-step" as AppStateMachine["currentStep"],
      });
      const { container } = render(<AppRouter app={app} />);
      expect(container.innerHTML).toBe("");
    });
  });

  describe("Step Priority", () => {
    it("should render loading before any other step check", () => {
      // Loading should take precedence even if other state is set
      const app = createAppStateMock({
        currentStep: "loading",
        isAuthenticated: true,
        isOnline: true,
      });
      render(<AppRouter app={app} />);
      expect(screen.getByTestId("loading-screen-component")).toBeInTheDocument();
      expect(screen.queryByTestId("dashboard-component")).not.toBeInTheDocument();
    });
  });
});
