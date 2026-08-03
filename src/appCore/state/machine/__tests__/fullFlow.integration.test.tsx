/**
 * Full App Flow Integration Tests
 *
 * Comprehensive integration tests verifying complete application flows
 * with all migrated hooks working together through the state machine.
 *
 * Test scenarios:
 * - New user flow (macOS)
 * - New user flow (Windows)
 * - Returning user flow (macOS)
 * - Returning user flow (Windows)
 * - No flicker verification for returning users
 * - Error recovery scenarios
 *
 * @module appCore/state/machine/__tests__/fullFlow.integration.test
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
  PlatformInfo,
  UserData,
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

const macOSPlatform: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: true };
const windowsPlatform: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: true };

const returningUserDataMacOS: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  hasPermissions: true,
};

const returningUserDataWindows: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  hasPermissions: false, // Windows doesn't need permissions
};

// Initial loading state
const initialLoadingState: LoadingState = {
  status: "loading",
  phase: "checking-storage",
};

// ============================================
// DEFAULT HOOK OPTIONS
// ============================================

const createDefaultSecureStorageOptions = (isMacOS: boolean) => ({
  isWindows: !isMacOS,
  isMacOS,
  pendingOAuthData: null,
  pendingOnboardingData: {
    phoneType: null as "iphone" | "android" | null,
    // BACKLOG-2414: narrowed from `string | null` to the union the hook options
    // actually declare. Value is unchanged (`null`); no test overrides it.
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
});

const createDefaultPhoneTypeOptions = (isWindows: boolean) => ({
  userId: "test-user-123",
  isWindows,
});

const defaultEmailOnboardingOptions = {
  userId: "test-user-123",
};

const createDefaultNavigationFlowOptions = (isMacOS: boolean) => ({
  isAuthenticated: true,
  isAuthLoading: false,
  needsTermsAcceptance: false,
  isMacOS,
  isWindows: !isMacOS,
  pendingOAuthData: null,
  pendingOnboardingData: {
    phoneType: null as "iphone" | "android" | null,
    // BACKLOG-2414: narrowed from `string | null` to the union the hook options
    // actually declare. Value is unchanged (`null`); no test overrides it.
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
});

// ============================================
// TEST SETUP
// ============================================

describe("Full App Flow Integration Tests", () => {
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
  // NEW USER FLOW (macOS)
  // ============================================

  describe("New User Flow (macOS)", () => {
    it("transitions loading -> onboarding -> ready", async () => {
      const secureStorageOpts = createDefaultSecureStorageOptions(true);
      const phoneTypeOpts = createDefaultPhoneTypeOptions(false);
      const navOpts = createDefaultNavigationFlowOptions(true);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          storage: useSecureStorage(secureStorageOpts),
          phoneType: usePhoneTypeApi(phoneTypeOpts),
          email: useEmailOnboardingApi(defaultEmailOnboardingOptions),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Initial: loading, checking storage
      expect(result.current.appState.state.status).toBe("loading");
      expect(result.current.storage.isDatabaseInitialized).toBe(false);
      expect(result.current.navigation.currentStep).toBe("loading");

      // Step 1: Storage check complete
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });

      // TASK-2086: Should be in validating-auth phase first
      if (result.current.appState.state.status === "loading") {
        expect(result.current.appState.state.phase).toBe("validating-auth");
      }

      // Step 1.5: Pre-DB auth validation passes
      act(() => {
        result.current.appState.dispatch({
          type: "AUTH_PRE_VALIDATED",
          valid: true,
        });
      });

      // Should be initializing DB
      if (result.current.appState.state.status === "loading") {
        expect(result.current.appState.state.phase).toBe("initializing-db");
      }
      expect(result.current.storage.isInitializingDatabase).toBe(true);

      // Step 2: DB init complete
      act(() => {
        result.current.appState.dispatch({
          type: "DB_INIT_COMPLETE",
          success: true,
        });
      });

      // Should be loading auth
      if (result.current.appState.state.status === "loading") {
        expect(result.current.appState.state.phase).toBe("loading-auth");
      }
      expect(result.current.storage.isDatabaseInitialized).toBe(true);

      // Step 3: Auth loaded (new user on macOS)
      act(() => {
        result.current.appState.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: macOSPlatform,
        });
      });

      // Should be in onboarding at phone-type step
      expect(result.current.appState.state.status).toBe("onboarding");
      expect(result.current.navigation.currentStep).toBe("phone-type-selection");
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("phone-type");
      }

      // Step 4: Complete phone-type step
      act(() => {
        result.current.appState.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
      });

      // On macOS, next step should be secure-storage
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("secure-storage");
      }
      expect(result.current.navigation.currentStep).toBe("keychain-explanation");

      // Step 5: Complete secure-storage step
      act(() => {
        result.current.appState.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "secure-storage",
        });
      });

      // Next step should be email-connect
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("email-connect");
      }
      expect(result.current.navigation.currentStep).toBe("email-onboarding");

      // Step 6: Complete email-connect step
      act(() => {
        result.current.appState.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "email-connect",
        });
      });

      // On macOS, next step should be permissions
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("permissions");
      }
      expect(result.current.navigation.currentStep).toBe("permissions");

      // Step 7: Complete permissions step -> APP_READY
      act(() => {
        result.current.appState.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "permissions",
        });
      });

      // Should now be ready
      expect(result.current.appState.state.status).toBe("ready");
      expect(result.current.navigation.currentStep).toBe("dashboard");
    });

    it("stores platform info correctly for macOS", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Go through loading to onboarding
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
      });
      act(() => {
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
      });
      act(() => {
        result.current.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: macOSPlatform,
        });
      });

      expect(result.current.state.status).toBe("onboarding");
      expect(result.current.platform?.isMacOS).toBe(true);
      expect(result.current.platform?.isWindows).toBe(false);
    });
  });

  // ============================================
  // NEW USER FLOW (Windows)
  // ============================================

  describe("New User Flow (Windows)", () => {
    it("skips secure-storage step on Windows (DPAPI auto-handles)", async () => {
      const secureStorageOpts = createDefaultSecureStorageOptions(false);
      const phoneTypeOpts = createDefaultPhoneTypeOptions(true);
      const navOpts = createDefaultNavigationFlowOptions(false);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          storage: useSecureStorage(secureStorageOpts),
          phoneType: usePhoneTypeApi(phoneTypeOpts),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Go through loading to onboarding
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "DB_INIT_COMPLETE",
          success: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: windowsPlatform,
        });
      });

      // Should be at phone-type step
      expect(result.current.appState.state.status).toBe("onboarding");
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("phone-type");
      }

      // Complete phone-type step
      act(() => {
        result.current.appState.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
      });

      // On Windows, should skip secure-storage and go directly to email-connect
      if (result.current.appState.state.status === "onboarding") {
        expect(result.current.appState.state.step).toBe("email-connect");
      }
      expect(result.current.navigation.currentStep).toBe("email-onboarding");
    });

    it("skips permissions step on Windows", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Go through loading to onboarding
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
      });
      act(() => {
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
      });
      act(() => {
        result.current.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: windowsPlatform,
        });
      });

      // Complete phone-type
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
      });

      // Complete email-connect
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "email-connect",
        });
      });

      // On Windows (no iPhone), should skip to apple-driver or finish
      // Depending on phone type, might go to apple-driver or finish
      // With hasIPhone=true, should go to apple-driver
      if (result.current.state.status === "onboarding") {
        expect(result.current.state.step).toBe("apple-driver");
      }

      // Complete apple-driver -> should be ready
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "apple-driver",
        });
      });

      expect(result.current.state.status).toBe("ready");
    });

    it("stores platform info correctly for Windows", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Go through loading to onboarding
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
      });
      act(() => {
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
      });
      act(() => {
        result.current.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: windowsPlatform,
        });
      });

      expect(result.current.platform?.isMacOS).toBe(false);
      expect(result.current.platform?.isWindows).toBe(true);
    });
  });

  // ============================================
  // RETURNING USER FLOW
  // ============================================

  describe("Returning User Flow", () => {
    it("skips onboarding and goes directly to ready (macOS)", async () => {
      const navOpts = createDefaultNavigationFlowOptions(true);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Simulate returning user flow
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "DB_INIT_COMPLETE",
          success: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: false,
          platform: macOSPlatform,
        });
      });

      // Should go to loading-user-data phase
      expect(result.current.appState.state.status).toBe("loading");
      if (result.current.appState.state.status === "loading") {
        expect(result.current.appState.state.phase).toBe("loading-user-data");
      }

      // Load user data (returning user with complete data)
      // Note: USER_DATA_LOADED requires user and platform context from previous AUTH_LOADED
      act(() => {
        result.current.appState.dispatch({
          type: "USER_DATA_LOADED",
          data: returningUserDataMacOS,
          user: testUser,
          platform: macOSPlatform,
        } as any); // Extended action type with context
      });

      // Should skip onboarding, go straight to ready
      expect(result.current.appState.state.status).toBe("ready");
      expect(result.current.navigation.currentStep).toBe("dashboard");
    });

    it("skips onboarding and goes directly to ready (Windows)", async () => {
      const navOpts = createDefaultNavigationFlowOptions(false);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Simulate returning user flow
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "DB_INIT_COMPLETE",
          success: true,
        });
      });
      act(() => {
        result.current.appState.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: false,
          platform: windowsPlatform,
        });
      });

      // Load user data (with required context)
      act(() => {
        result.current.appState.dispatch({
          type: "USER_DATA_LOADED",
          data: returningUserDataWindows,
          user: testUser,
          platform: windowsPlatform,
        } as any); // Extended action type with context
      });

      // Should skip onboarding, go straight to ready
      expect(result.current.appState.state.status).toBe("ready");
      expect(result.current.navigation.currentStep).toBe("dashboard");
    });

    it("has no flicker (no temporary onboarding state)", async () => {
      const stateHistory: string[] = [];

      const { result } = renderHook(
        () => {
          const appState = useAppState();
          // Track state changes
          if (
            stateHistory.length === 0 ||
            stateHistory[stateHistory.length - 1] !== appState.state.status
          ) {
            stateHistory.push(appState.state.status);
          }
          return appState;
        },
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Simulate returning user flow rapidly (as would happen in real app)
      // Note: USER_DATA_LOADED requires user and platform context
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
        result.current.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: false,
          platform: macOSPlatform,
        });
        result.current.dispatch({
          type: "USER_DATA_LOADED",
          data: returningUserDataMacOS,
          user: testUser,
          platform: macOSPlatform,
        } as any);
      });

      // Verify no 'onboarding' state in history
      expect(stateHistory).not.toContain("onboarding");

      // Valid states for returning user: loading -> ready
      const validStates = ["loading", "ready"];
      stateHistory.forEach((s) => {
        expect(validStates).toContain(s);
      });

      // Final state should be ready
      expect(result.current.state.status).toBe("ready");
    });

    it("does not show onboarding screens during fast path", async () => {
      const navOpts = createDefaultNavigationFlowOptions(true);
      const stepHistory: string[] = [];

      const { result } = renderHook(
        () => {
          const nav = useNavigationFlow(navOpts);
          // Track step changes
          if (
            stepHistory.length === 0 ||
            stepHistory[stepHistory.length - 1] !== nav.currentStep
          ) {
            stepHistory.push(nav.currentStep);
          }
          return { appState: useAppState(), nav };
        },
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Simulate returning user flow (with required context for USER_DATA_LOADED)
      act(() => {
        result.current.appState.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
        result.current.appState.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
        result.current.appState.dispatch({ type: "DB_INIT_COMPLETE", success: true });
        result.current.appState.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: false,
          platform: macOSPlatform,
        });
        result.current.appState.dispatch({
          type: "USER_DATA_LOADED",
          data: returningUserDataMacOS,
          user: testUser,
          platform: macOSPlatform,
        } as any);
      });

      // Onboarding screen steps should never appear in history
      const onboardingSteps = [
        "phone-type-selection",
        "keychain-explanation",
        "email-onboarding",
        "permissions",
        "apple-driver-setup",
      ];

      stepHistory.forEach((step) => {
        expect(onboardingSteps).not.toContain(step);
      });

      // Final step should be dashboard
      expect(result.current.nav.currentStep).toBe("dashboard");
    });
  });

  // ============================================
  // ERROR RECOVERY
  // ============================================

  describe("Error Recovery", () => {
    it("handles database init failure gracefully", async () => {
      const secureStorageOpts = createDefaultSecureStorageOptions(true);
      const navOpts = createDefaultNavigationFlowOptions(true);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          storage: useSecureStorage(secureStorageOpts),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(initialLoadingState) }
      );

      // Storage check passes
      act(() => {
        result.current.appState.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });

      // Pre-auth validation passes
      act(() => {
        result.current.appState.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });

      // DB init fails
      act(() => {
        result.current.appState.dispatch({
          type: "DB_INIT_COMPLETE",
          success: false,
          error: "Encryption key not found",
        });
      });

      // Should be in error state
      expect(result.current.appState.state.status).toBe("error");
      if (result.current.appState.state.status === "error") {
        expect(result.current.appState.state.error.code).toBe("DB_INIT_FAILED");
        expect(result.current.appState.state.error.message).toContain(
          "Encryption key not found"
        );
        expect(result.current.appState.state.recoverable).toBe(true);
      }

      // Storage hook should reflect not initialized
      expect(result.current.storage.isDatabaseInitialized).toBe(false);
    });

    it("allows retry from error state", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Get to error state
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
      });
      act(() => {
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.dispatch({
          type: "DB_INIT_COMPLETE",
          success: false,
          error: "Failed",
        });
      });

      expect(result.current.state.status).toBe("error");

      // Dispatch RETRY
      act(() => {
        result.current.dispatch({ type: "RETRY" });
      });

      // Should return to previous state (loading, initializing-db)
      expect(result.current.state.status).toBe("loading");
      if (result.current.state.status === "loading") {
        expect(result.current.state.phase).toBe("initializing-db");
      }
    });

    it("handles auth failure gracefully", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Go through loading
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
      });
      act(() => {
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
      });
      act(() => {
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
      });

      // Auth fails - dispatch ERROR action
      act(() => {
        result.current.dispatch({
          type: "ERROR",
          error: {
            code: "AUTH_FAILED",
            message: "Failed to authenticate",
          },
          recoverable: true,
        });
      });

      expect(result.current.state.status).toBe("error");
      if (result.current.state.status === "error") {
        expect(result.current.state.error.code).toBe("AUTH_FAILED");
        expect(result.current.state.recoverable).toBe(true);
      }
    });

    it("non-recoverable error blocks retry", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Get to non-recoverable error state
      act(() => {
        result.current.dispatch({
          type: "ERROR",
          error: {
            code: "UNKNOWN_ERROR",
            message: "Fatal error",
          },
          recoverable: false,
        });
      });

      expect(result.current.state.status).toBe("error");

      // Try to retry
      act(() => {
        result.current.dispatch({ type: "RETRY" });
      });

      // Should still be in error state (retry blocked)
      expect(result.current.state.status).toBe("error");
    });
  });

  // ============================================
  // LOGOUT FLOW
  // ============================================

  describe("Logout Flow", () => {
    it("transitions to unauthenticated from ready state", () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testUser,
        platform: macOSPlatform,
        userData: returningUserDataMacOS,
      };

      const navOpts = createDefaultNavigationFlowOptions(true);

      const { result } = renderHook(
        () => ({
          appState: useAppState(),
          navigation: useNavigationFlow(navOpts),
        }),
        { wrapper: createWrapper(readyState) }
      );

      // Verify we start in ready state
      expect(result.current.appState.state.status).toBe("ready");
      expect(result.current.appState.currentUser?.email).toBe("test@example.com");
      expect(result.current.navigation.currentStep).toBe("dashboard");

      // Logout
      act(() => {
        result.current.appState.dispatch({ type: "LOGOUT" });
      });

      // Should immediately be unauthenticated
      expect(result.current.appState.state.status).toBe("unauthenticated");
      expect(result.current.appState.currentUser).toBeNull();
      expect(result.current.navigation.currentStep).toBe("login");
    });

    it("transitions to unauthenticated from onboarding state", () => {
      const onboardingState: OnboardingState = {
        status: "onboarding",
        step: "phone-type",
        user: testUser,
        platform: macOSPlatform,
        completedSteps: [],
      };

      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(onboardingState),
      });

      // Logout during onboarding
      act(() => {
        result.current.dispatch({ type: "LOGOUT" });
      });

      expect(result.current.state.status).toBe("unauthenticated");
      expect(result.current.currentUser).toBeNull();
    });

    it("clears user and platform data on logout", () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testUser,
        platform: macOSPlatform,
        userData: returningUserDataMacOS,
      };

      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(readyState),
      });

      // Verify user is set
      expect(result.current.currentUser).not.toBeNull();
      expect(result.current.platform).not.toBeNull();

      // Logout
      act(() => {
        result.current.dispatch({ type: "LOGOUT" });
      });

      // All user data should be cleared
      expect(result.current.currentUser).toBeNull();
      expect(result.current.platform).toBeNull();
    });
  });

  // ============================================
  // CONCURRENT OPERATIONS
  // ============================================

  describe("Concurrent Operations", () => {
    it("handles rapid dispatch calls without corruption", async () => {
      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(initialLoadingState),
      });

      // Rapid-fire multiple dispatches
      act(() => {
        result.current.dispatch({ type: "STORAGE_CHECKED", hasKeyStore: true });
        result.current.dispatch({ type: "AUTH_PRE_VALIDATED", valid: true });
        result.current.dispatch({ type: "DB_INIT_COMPLETE", success: true });
        result.current.dispatch({
          type: "AUTH_LOADED",
          user: testUser,
          isNewUser: true,
          platform: macOSPlatform,
        });
      });

      // State should be consistent
      expect(result.current.state.status).toBe("onboarding");

      // More rapid dispatches for onboarding steps
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "secure-storage",
        });
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "email-connect",
        });
      });

      // State should still be consistent (not corrupted)
      expect(result.current.state.status).toBeDefined();

      if (result.current.state.status === "onboarding") {
        // All completed steps should be tracked
        expect(result.current.state.completedSteps).toContain("phone-type");
        expect(result.current.state.completedSteps).toContain("secure-storage");
        expect(result.current.state.completedSteps).toContain("email-connect");
      }
    });

    it("ignores invalid transitions gracefully", () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testUser,
        platform: macOSPlatform,
        userData: returningUserDataMacOS,
      };

      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(readyState),
      });

      // Try to dispatch loading-specific action from ready state
      act(() => {
        result.current.dispatch({
          type: "STORAGE_CHECKED",
          hasKeyStore: true,
        });
      });

      // Should still be in ready state (invalid transition ignored)
      expect(result.current.state.status).toBe("ready");
    });

    it("APP_READY action is no-op when already ready", () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testUser,
        platform: macOSPlatform,
        userData: returningUserDataMacOS,
      };

      const { result } = renderHook(() => useAppState(), {
        wrapper: createWrapper(readyState),
      });

      const beforeState = result.current.state;

      act(() => {
        result.current.dispatch({ type: "APP_READY" });
      });

      // State should be unchanged
      expect(result.current.state).toBe(beforeState);
    });
  });
});
