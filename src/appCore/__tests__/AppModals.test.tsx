/**
 * Tests for AppModals.tsx
 *
 * Tests conditional modal rendering based on app state.
 * Each test verifies that modals render only when their conditions are met
 * and don't render when conditions are false.
 *
 * Strategy: Mock all modal child components to isolate conditional rendering logic.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppModals } from "../AppModals";
import type { AppStateMachine } from "../state/types";

// Mock all modal child components
jest.mock("../../components/Profile", () => {
  const MockProfile = () => <div data-testid="profile-modal">Profile Modal</div>;
  MockProfile.displayName = "Profile";
  return { __esModule: true, default: MockProfile };
});

jest.mock("../../components/Settings", () => {
  const MockSettings = () => <div data-testid="settings-modal">Settings Modal</div>;
  MockSettings.displayName = "Settings";
  return { __esModule: true, default: MockSettings };
});

jest.mock("../../components/TransactionList", () => {
  const MockTransactionList = () => <div data-testid="transactions-modal">Transactions Modal</div>;
  MockTransactionList.displayName = "TransactionList";
  return { __esModule: true, default: MockTransactionList };
});

jest.mock("../../components/Contacts", () => {
  const MockContacts = () => <div data-testid="contacts-modal">Contacts Modal</div>;
  MockContacts.displayName = "Contacts";
  return { __esModule: true, default: MockContacts };
});

jest.mock("../../components/WelcomeTerms", () => {
  const MockWelcomeTerms = () => <div data-testid="welcome-terms-modal">Welcome Terms Modal</div>;
  MockWelcomeTerms.displayName = "WelcomeTerms";
  return { __esModule: true, default: MockWelcomeTerms };
});

jest.mock("../../components/AuditTransactionModal", () => {
  const MockAuditTransactionModal = () => (
    <div data-testid="audit-transaction-modal">Audit Transaction Modal</div>
  );
  MockAuditTransactionModal.displayName = "AuditTransactionModal";
  return { __esModule: true, default: MockAuditTransactionModal };
});

jest.mock("../../components/MoveAppPrompt", () => {
  const MockMoveAppPrompt = () => <div data-testid="move-app-prompt">Move App Prompt</div>;
  MockMoveAppPrompt.displayName = "MoveAppPrompt";
  return { __esModule: true, default: MockMoveAppPrompt };
});

jest.mock("../modals/IPhoneSyncModal", () => ({
  IPhoneSyncModal: () => <div data-testid="iphone-sync-modal">iPhone Sync Modal</div>,
}));

// Mock useEmailSettingsCallbacks hook
jest.mock("../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
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

describe("AppModals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("No Modals", () => {
    it("should render no modals when all modal flags are false", () => {
      const app = createAppStateMock();
      const { container } = render(<AppModals app={app} />);

      expect(screen.queryByTestId("profile-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("contacts-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("welcome-terms-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("audit-transaction-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("move-app-prompt")).not.toBeInTheDocument();
      expect(screen.queryByTestId("iphone-sync-modal")).not.toBeInTheDocument();
      // Container should still exist (Fragment renders)
      expect(container).toBeTruthy();
    });
  });

  describe("Move App Prompt", () => {
    it("should render MoveAppPrompt when showMoveAppPrompt is true", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showMoveAppPrompt: true }),
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("move-app-prompt")).toBeInTheDocument();
    });

    it("should not render MoveAppPrompt when showMoveAppPrompt is false", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showMoveAppPrompt: false }),
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("move-app-prompt")).not.toBeInTheDocument();
    });
  });

  describe("Profile Modal", () => {
    it("should render Profile when showProfile is true and user + authProvider exist", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showProfile: true }),
        currentUser: mockUser,
        authProvider: "google",
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("profile-modal")).toBeInTheDocument();
    });

    it("should not render Profile when showProfile is true but no currentUser", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showProfile: true }),
        currentUser: null,
        authProvider: "google",
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("profile-modal")).not.toBeInTheDocument();
    });

    it("should not render Profile when showProfile is true but no authProvider", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showProfile: true }),
        currentUser: mockUser,
        authProvider: null,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("profile-modal")).not.toBeInTheDocument();
    });

    it("should not render Profile when showProfile is false", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showProfile: false }),
        currentUser: mockUser,
        authProvider: "google",
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("profile-modal")).not.toBeInTheDocument();
    });
  });

  describe("Settings Modal", () => {
    it("should render Settings when showSettings is true and user exists", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showSettings: true }),
        currentUser: mockUser,
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    });

    it("should not render Settings when showSettings is true but no currentUser", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showSettings: true }),
        currentUser: null,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
    });

    it("should not render Settings when showSettings is false", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showSettings: false }),
        currentUser: mockUser,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
    });
  });

  describe("Transactions View", () => {
    it("should render TransactionList when showTransactions is true and all conditions met", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTransactions: true }),
        currentUser: mockUser,
        authProvider: "google",
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("transactions-modal")).toBeInTheDocument();
    });

    it("should not render TransactionList when showTransactions is true but no user", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTransactions: true }),
        currentUser: null,
        authProvider: "google",
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
    });

    it("should not render TransactionList when showTransactions is true but no authProvider", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTransactions: true }),
        currentUser: mockUser,
        authProvider: null,
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
    });

    it("should not render TransactionList when database not initialized", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTransactions: true }),
        currentUser: mockUser,
        authProvider: "google",
        isDatabaseInitialized: false,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
    });
  });

  describe("Contacts View", () => {
    it("should render Contacts when showContacts is true and conditions met", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showContacts: true }),
        currentUser: mockUser,
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("contacts-modal")).toBeInTheDocument();
    });

    it("should not render Contacts when showContacts is true but no user", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showContacts: true }),
        currentUser: null,
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("contacts-modal")).not.toBeInTheDocument();
    });

    it("should not render Contacts when showContacts is true but database not initialized", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showContacts: true }),
        currentUser: mockUser,
        isDatabaseInitialized: false,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("contacts-modal")).not.toBeInTheDocument();
    });
  });

  describe("Welcome Terms Modal", () => {
    it("should render WelcomeTerms when showTermsModal is true", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTermsModal: true }),
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("welcome-terms-modal")).toBeInTheDocument();
    });

    it("should render WelcomeTerms when needsTermsAcceptance is true and user exists", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTermsModal: false }),
        needsTermsAcceptance: true,
        currentUser: mockUser,
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("welcome-terms-modal")).toBeInTheDocument();
    });

    it("should not render WelcomeTerms when neither condition is met", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showTermsModal: false }),
        needsTermsAcceptance: false,
        currentUser: mockUser,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("welcome-terms-modal")).not.toBeInTheDocument();
    });
  });

  describe("Audit Transaction Modal", () => {
    it("should render AuditTransactionModal when showAuditTransaction is true and all conditions met", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showAuditTransaction: true }),
        currentUser: mockUser,
        authProvider: "google",
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("audit-transaction-modal")).toBeInTheDocument();
    });

    it("should not render AuditTransactionModal when showAuditTransaction is true but no user", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showAuditTransaction: true }),
        currentUser: null,
        authProvider: "google",
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("audit-transaction-modal")).not.toBeInTheDocument();
    });

    it("should not render AuditTransactionModal when no authProvider", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showAuditTransaction: true }),
        currentUser: mockUser,
        authProvider: null,
        isDatabaseInitialized: true,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("audit-transaction-modal")).not.toBeInTheDocument();
    });

    it("should not render AuditTransactionModal when database not initialized", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showAuditTransaction: true }),
        currentUser: mockUser,
        authProvider: "google",
        isDatabaseInitialized: false,
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("audit-transaction-modal")).not.toBeInTheDocument();
    });
  });

  describe("iPhone Sync Modal", () => {
    it("should render IPhoneSyncModal when showIPhoneSync is true", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showIPhoneSync: true }),
      });
      render(<AppModals app={app} />);
      expect(screen.getByTestId("iphone-sync-modal")).toBeInTheDocument();
    });

    it("should not render IPhoneSyncModal when showIPhoneSync is false", () => {
      const app = createAppStateMock({
        modalState: createModalState({ showIPhoneSync: false }),
      });
      render(<AppModals app={app} />);
      expect(screen.queryByTestId("iphone-sync-modal")).not.toBeInTheDocument();
    });
  });

  describe("Multiple Modals", () => {
    it("should render multiple modals simultaneously when conditions are met", () => {
      const app = createAppStateMock({
        modalState: createModalState({
          showMoveAppPrompt: true,
          showSettings: true,
          showIPhoneSync: true,
        }),
        currentUser: mockUser,
      });
      render(<AppModals app={app} />);

      expect(screen.getByTestId("move-app-prompt")).toBeInTheDocument();
      expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
      expect(screen.getByTestId("iphone-sync-modal")).toBeInTheDocument();
    });

    it("should render terms modal alongside other modals", () => {
      const app = createAppStateMock({
        modalState: createModalState({
          showTermsModal: true,
          showMoveAppPrompt: true,
        }),
      });
      render(<AppModals app={app} />);

      expect(screen.getByTestId("welcome-terms-modal")).toBeInTheDocument();
      expect(screen.getByTestId("move-app-prompt")).toBeInTheDocument();
    });
  });
});
