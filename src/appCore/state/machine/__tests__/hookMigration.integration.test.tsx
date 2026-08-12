/**
 * Hook Migration Integration Tests
 *
 * Integration tests verifying all migrated hooks work correctly together
 * with the state machine when the feature flag is enabled.
 *
 * These tests verify:
 * - Each hook derives correct state from the state machine
 * - Hooks update properly when state transitions occur
 * - Action dispatches work correctly through hooks
 * - All hooks maintain consistent behavior with the state machine
 *
 * Migrated hooks tested:
 * - useSecureStorage (TASK-941)
 * - usePhoneTypeApi (TASK-942)
 * - useEmailOnboardingApi (TASK-943)
 * - useNavigationFlow (TASK-945)
 *
 * @module appCore/state/machine/__tests__/hookMigration.integration.test
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { AppStateProvider } from "../AppStateContext";
import { useAppState } from "../useAppState";
import type {
  AppState,
  LoadingState,
  ReadyState,
  OnboardingState,
  UnauthenticatedState,
  ErrorState,
} from "../types";
import * as featureFlags from "../utils/featureFlags";

// Import hooks to test
import { useSecureStorage } from "../../flows/useSecureStorage";
import { usePhoneTypeApi } from "../../flows/usePhoneTypeApi";
import { useEmailOnboardingApi } from "../../flows/useEmailOnboardingApi";
import { useNavigationFlow } from "../../flows/useNavigationFlow";

// ============================================
// MOCKS
// ============================================

// Mock the feature flags module
jest.mock("../utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const mockIsNewStateMachineEnabled =
  featureFlags.isNewStateMachineEnabled as jest.Mock;

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] || null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    clear: jest.fn(() => {
      store = {};
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
  };
})();
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// Mock window.api for hooks that call it
const mockApi = {
  user: {
    setPhoneType: jest.fn().mockResolvedValue({ success: true }),
    getPhoneType: jest.fn().mockResolvedValue({ success: true, phoneType: null }),
  },
  auth: {
    completeEmailOnboarding: jest.fn().mockResolvedValue({ success: true }),
    checkEmailOnboarding: jest.fn().mockResolvedValue({ success: true, completed: false }),
  },
  system: {
    checkAllConnections: jest.fn().mockResolvedValue({ success: true }),
    initializeSecureStorage: jest.fn().mockResolvedValue({ success: true }),
    hasEncryptionKeyStore: jest.fn().mockResolvedValue({ hasKeyStore: true }),
  },
};

Object.defineProperty(window, "api", { value: mockApi, writable: true });

// ============================================
// TEST FIXTURES
// ============================================

const testUser = { id: "test-user-123", email: "test@example.com" };

const macOSPlatform = { isMacOS: true, isWindows: false, hasIPhone: true };
const completeUserData = {
  phoneType: "iphone" as const,
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  hasPermissions: true,
};

// Test states
const loadingCheckingStorage: LoadingState = {
  status: "loading",
  phase: "checking-storage",
};

const loadingInitializingDb: LoadingState = {
  status: "loading",
  phase: "initializing-db",
};

const loadingAuth: LoadingState = {
  status: "loading",
  phase: "loading-auth",
};

const loadingUserData: LoadingState = {
  status: "loading",
  phase: "loading-user-data",
};

const unauthenticatedState: UnauthenticatedState = {
  status: "unauthenticated",
};

const onboardingPhoneType: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: testUser,
  platform: macOSPlatform,
  completedSteps: [],
};

const onboardingSecureStorage: OnboardingState = {
  status: "onboarding",
  step: "secure-storage",
  user: testUser,
  platform: macOSPlatform,
  completedSteps: ["phone-type"],
};

const onboardingEmailConnect: OnboardingState = {
  status: "onboarding",
  step: "email-connect",
  user: testUser,
  platform: macOSPlatform,
  completedSteps: ["phone-type", "secure-storage"],
};

const onboardingPermissions: OnboardingState = {
  status: "onboarding",
  step: "permissions",
  user: testUser,
  platform: macOSPlatform,
  completedSteps: ["phone-type", "secure-storage", "email-connect"],
};

const readyStateMacOS: ReadyState = {
  status: "ready",
  user: testUser,
  platform: macOSPlatform,
  userData: completeUserData,
};

const errorState: ErrorState = {
  status: "error",
  error: {
    code: "DB_INIT_FAILED",
    message: "Failed to initialize database",
  },
  recoverable: true,
  previousState: loadingInitializingDb,
};

// ============================================
// DEFAULT HOOK OPTIONS
// ============================================

const defaultSecureStorageOptions = {
  isWindows: false,
  isMacOS: true,
  pendingOAuthData: null,
  pendingOnboardingData: {
    phoneType: null as "iphone" | "android" | null,
    emailProvider: null as "google" | "microsoft" | null,
    emailConnected: false,
    termsAccepted: false,
  },
  isAuthenticated: false,
  login: jest.fn(),
  onPendingOAuthClear: jest.fn(),
  onPendingOnboardingClear: jest.fn(),
  onPhoneTypeSet: jest.fn(),
  onEmailOnboardingComplete: jest.fn(),
  onNewUserFlowSet: jest.fn(),
  onNeedsDriverSetup: jest.fn(),
};

const defaultPhoneTypeOptions = {
  userId: "test-user-123",
  isWindows: false,
};

const defaultEmailOnboardingOptions = {
  userId: "test-user-123",
};

const defaultNavigationFlowOptions = {
  isAuthenticated: true,
  isAuthLoading: false,
  needsTermsAcceptance: false,
  isMacOS: true,
  isWindows: false,
  pendingOAuthData: null,
  pendingOnboardingData: {
    phoneType: null as "iphone" | "android" | null,
    emailProvider: null as "google" | "microsoft" | null,
    emailConnected: false,
    termsAccepted: false,
  },
  isCheckingSecureStorage: false,
  isDatabaseInitialized: true,
  isInitializingDatabase: false,
  initializeSecureStorage: jest.fn().mockResolvedValue(true),
  hasSelectedPhoneType: true,
  isLoadingPhoneType: false,
  needsDriverSetup: false,
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  isCheckingEmailOnboarding: false,
  hasPermissions: true,
  showTermsModal: false,
  onSetShowTermsModal: jest.fn(),
};

// ============================================
// TEST SETUP
// ============================================

describe("Hook Migration Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    // Enable state machine for all tests
    mockIsNewStateMachineEnabled.mockReturnValue(true);
  });

  // Helper to create wrapper with specific initial state
  const createWrapper = (initialState?: AppState) => {
    return ({ children }: { children: React.ReactNode }) => (
      <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
    );
  };

  // ============================================
  // useSecureStorage with State Machine
  // ============================================

  describe("useSecureStorage with state machine", () => {
    it("derives isDatabaseInitialized from state machine", () => {
      // When in loading (checking-storage), DB is not initialized
      const { result: resultLoading } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultLoading.current.isDatabaseInitialized).toBe(false);

      // When past initializing-db phase, DB is initialized
      const { result: resultAuth } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultAuth.current.isDatabaseInitialized).toBe(true);

      // When ready, DB is initialized
      const { result: resultReady } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.isDatabaseInitialized).toBe(true);
    });

    it("derives isCheckingSecureStorage from state machine", () => {
      const { result: resultChecking } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultChecking.current.isCheckingSecureStorage).toBe(true);

      const { result: resultNotChecking } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultNotChecking.current.isCheckingSecureStorage).toBe(false);
    });

    it("derives isInitializingDatabase from state machine", () => {
      const { result: resultInit } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultInit.current.isInitializingDatabase).toBe(true);

      const { result: resultNotInit } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultNotInit.current.isInitializingDatabase).toBe(false);
    });

    it("derives hasSecureStorageSetup from state machine", () => {
      // In checking-storage phase, setup is not complete
      const { result: resultChecking } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultChecking.current.hasSecureStorageSetup).toBe(false);

      // Past checking-storage, setup is complete
      const { result: resultPast } = renderHook(
        () => useSecureStorage(defaultSecureStorageOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultPast.current.hasSecureStorageSetup).toBe(true);
    });
  });

  // ============================================
  // usePhoneTypeApi with State Machine
  // ============================================

  describe("usePhoneTypeApi with state machine", () => {
    it("derives hasSelectedPhoneType from state machine", () => {
      // At phone-type step, not yet selected
      const { result: resultAtStep } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(onboardingPhoneType) }
      );
      expect(resultAtStep.current.hasSelectedPhoneType).toBe(false);

      // Past phone-type step, selected
      const { result: resultPastStep } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );
      expect(resultPastStep.current.hasSelectedPhoneType).toBe(true);

      // When ready, selected
      const { result: resultReady } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.hasSelectedPhoneType).toBe(true);
    });

    it("derives selectedPhoneType from state machine", () => {
      // In ready state, gets from userData
      const { result: resultReady } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.selectedPhoneType).toBe("iphone");
    });

    it("derives isLoadingPhoneType from state machine", () => {
      // During loading phases, isLoadingPhoneType is true
      const { result: resultLoading } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultLoading.current.isLoadingPhoneType).toBe(true);

      // When ready, not loading
      const { result: resultReady } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.isLoadingPhoneType).toBe(false);
    });

    it("savePhoneType dispatches onboarding step complete", async () => {
      const { result } = renderHook(
        () => ({
          phoneType: usePhoneTypeApi(defaultPhoneTypeOptions),
          appState: useAppState(),
        }),
        { wrapper: createWrapper(onboardingPhoneType) }
      );

      // Initially at phone-type step
      expect(result.current.appState.state.status).toBe("onboarding");
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("phone-type");
      }

      // Save phone type
      await act(async () => {
        await result.current.phoneType.savePhoneType("iphone");
      });

      // API should be called
      expect(mockApi.user.setPhoneType).toHaveBeenCalledWith(
        "test-user-123",
        "iphone"
      );

      // Should have dispatched ONBOARDING_STEP_COMPLETE
      // The state machine should advance to next step
      expect(result.current.appState.state.status).toBe("onboarding");
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.completedSteps).toContain("phone-type");
      }
    });

    it("setters are no-ops in state machine mode", () => {
      const { result } = renderHook(
        () => usePhoneTypeApi(defaultPhoneTypeOptions),
        { wrapper: createWrapper(onboardingPhoneType) }
      );

      // These should be no-ops - not throw
      expect(() => {
        result.current.setHasSelectedPhoneType(true);
        result.current.setSelectedPhoneType("android");
        result.current.setNeedsDriverSetup(true);
      }).not.toThrow();

      // Values should remain derived from state machine
      expect(result.current.hasSelectedPhoneType).toBe(false);
    });
  });

  // ============================================
  // useEmailOnboardingApi with State Machine
  // ============================================

  describe("useEmailOnboardingApi with state machine", () => {
    it("derives hasCompletedEmailOnboarding from state machine", () => {
      // At email-connect step, not complete
      const { result: resultAtStep } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );
      expect(resultAtStep.current.hasCompletedEmailOnboarding).toBe(false);

      // Past email-connect step, complete
      const { result: resultPastStep } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(onboardingPermissions) }
      );
      expect(resultPastStep.current.hasCompletedEmailOnboarding).toBe(true);

      // When ready, complete
      const { result: resultReady } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.hasCompletedEmailOnboarding).toBe(true);
    });

    it("derives hasEmailConnected from state machine", () => {
      // During onboarding, email is not connected yet
      const { result: resultOnboarding } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );
      expect(resultOnboarding.current.hasEmailConnected).toBe(false);

      // When ready, get from userData
      const { result: resultReady } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.hasEmailConnected).toBe(true);
    });

    it("derives isCheckingEmailOnboarding from state machine", () => {
      // During loading phases, checking
      const { result: resultLoading } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(loadingUserData) }
      );
      expect(resultLoading.current.isCheckingEmailOnboarding).toBe(true);

      // When not loading, not checking
      const { result: resultReady } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.isCheckingEmailOnboarding).toBe(false);
    });

    it("completeEmailOnboarding dispatches onboarding step complete", async () => {
      const { result } = renderHook(
        () => ({
          email: useEmailOnboardingApi(defaultEmailOnboardingOptions),
          appState: useAppState(),
        }),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );

      // Initially at email-connect step
      expect(result.current.appState.state.status).toBe("onboarding");
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("email-connect");
      }

      // Complete email onboarding
      await act(async () => {
        await result.current.email.completeEmailOnboarding();
      });

      // API should be called
      expect(mockApi.auth.completeEmailOnboarding).toHaveBeenCalledWith(
        "test-user-123"
      );

      // Should have dispatched ONBOARDING_STEP_COMPLETE
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.completedSteps).toContain("email-connect");
      }
    });

    it("setters are no-ops in state machine mode", () => {
      const { result } = renderHook(
        () => useEmailOnboardingApi(defaultEmailOnboardingOptions),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );

      // These should be no-ops - not throw
      expect(() => {
        result.current.setHasCompletedEmailOnboarding(true);
        result.current.setHasEmailConnected(true);
      }).not.toThrow();

      // Values should remain derived from state machine
      expect(result.current.hasCompletedEmailOnboarding).toBe(false);
    });
  });

  // ============================================
  // useNavigationFlow with State Machine
  // ============================================

  describe("useNavigationFlow with state machine", () => {
    it("derives currentStep from state machine", () => {
      // In loading state, step is 'loading'
      const { result: resultLoading } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultLoading.current.currentStep).toBe("loading");

      // In unauthenticated state, step is 'login'
      const { result: resultUnauth } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(unauthenticatedState) }
      );
      expect(resultUnauth.current.currentStep).toBe("login");

      // In onboarding phone-type step
      const { result: resultPhoneType } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(onboardingPhoneType) }
      );
      expect(resultPhoneType.current.currentStep).toBe("phone-type-selection");

      // In onboarding secure-storage step (maps to keychain-explanation)
      const { result: resultSecure } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(onboardingSecureStorage) }
      );
      expect(resultSecure.current.currentStep).toBe("keychain-explanation");

      // In onboarding email-connect step (maps to email-onboarding)
      const { result: resultEmail } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(onboardingEmailConnect) }
      );
      expect(resultEmail.current.currentStep).toBe("email-onboarding");

      // In ready state, step is 'dashboard'
      const { result: resultReady } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.currentStep).toBe("dashboard");
    });

    it("derives correct page titles", () => {
      const { result: resultReady } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );
      expect(resultReady.current.getPageTitle()).toBe("Keepr.");

      const { result: resultLogin } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(unauthenticatedState) }
      );
      expect(resultLogin.current.getPageTitle()).toBe("Welcome");
    });

    it("navigation setters are no-ops in state machine mode", () => {
      const { result } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );

      const initialStep = result.current.currentStep;

      // These should be no-ops - not throw
      expect(() => {
        result.current.setCurrentStep("login");
        result.current.goToStep("login");
        result.current.goToEmailOnboarding();
      }).not.toThrow();

      // Step should remain unchanged (derived from state machine)
      expect(result.current.currentStep).toBe(initialStep);
    });

    it("handleDismissSetupPrompt still works for UI state", () => {
      const { result } = renderHook(
        () => useNavigationFlow(defaultNavigationFlowOptions),
        { wrapper: createWrapper(readyStateMacOS) }
      );

      expect(result.current.showSetupPromptDismissed).toBe(false);

      act(() => {
        result.current.handleDismissSetupPrompt();
      });

      expect(result.current.showSetupPromptDismissed).toBe(true);
    });
  });

  // ============================================
  // All Hooks Together
  // ============================================

  describe("all hooks together", () => {
    it("all hooks derive consistent state from same app state", () => {
      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          secureStorage: useSecureStorage(defaultSecureStorageOptions),
          phoneType: usePhoneTypeApi(defaultPhoneTypeOptions),
          emailOnboarding: useEmailOnboardingApi(defaultEmailOnboardingOptions),
          navigationFlow: useNavigationFlow(defaultNavigationFlowOptions),
        }),
        { wrapper: createWrapper(readyStateMacOS) }
      );

      // All hooks should reflect ready state
      expect(result.current.appState.state.status).toBe("ready");
      expect(result.current.secureStorage.isDatabaseInitialized).toBe(true);
      expect(result.current.phoneType.hasSelectedPhoneType).toBe(true);
      expect(result.current.emailOnboarding.hasCompletedEmailOnboarding).toBe(true);
      expect(result.current.navigationFlow.currentStep).toBe("dashboard");
    });

    it("all hooks update when state machine transitions", () => {
      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          secureStorage: useSecureStorage(defaultSecureStorageOptions),
          phoneType: usePhoneTypeApi(defaultPhoneTypeOptions),
          emailOnboarding: useEmailOnboardingApi(defaultEmailOnboardingOptions),
          navigationFlow: useNavigationFlow(defaultNavigationFlowOptions),
        }),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );

      // Initially in loading state
      expect(result.current.appState.state.status).toBe("loading");
      expect(result.current.secureStorage.isDatabaseInitialized).toBe(false);
      expect(result.current.secureStorage.isCheckingSecureStorage).toBe(true);
      expect(result.current.navigationFlow.currentStep).toBe("loading");

      // Simulate storage checked -> DB init phase
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });

      // TASK-2086: STORAGE_CHECKED now transitions to validating-auth (pre-DB auth)
      // before initializing-db
      if (result.current.appState.state.status === "loading") {
        expect(result.current.appState.state.phase).toBe("validating-auth");
      }
      expect(result.current.secureStorage.isCheckingSecureStorage).toBe(false);
      expect(result.current.secureStorage.isInitializingDatabase).toBe(false);
    });

    it("all hooks handle error state gracefully", () => {
      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          secureStorage: useSecureStorage(defaultSecureStorageOptions),
          phoneType: usePhoneTypeApi(defaultPhoneTypeOptions),
          emailOnboarding: useEmailOnboardingApi(defaultEmailOnboardingOptions),
          navigationFlow: useNavigationFlow(defaultNavigationFlowOptions),
        }),
        { wrapper: createWrapper(errorState) }
      );

      // Should be in error state
      expect(result.current.appState.state.status).toBe("error");
      expect(result.current.appState.error?.code).toBe("DB_INIT_FAILED");

      // Hooks should return safe defaults for error state
      expect(result.current.secureStorage.isDatabaseInitialized).toBe(false);
      expect(result.current.phoneType.hasSelectedPhoneType).toBe(false);
      expect(result.current.emailOnboarding.hasCompletedEmailOnboarding).toBe(false);
      // Navigation derives 'error' for error state (shows error-with-retry UI)
      expect(result.current.navigationFlow.currentStep).toBe("error");
    });
  });
});
