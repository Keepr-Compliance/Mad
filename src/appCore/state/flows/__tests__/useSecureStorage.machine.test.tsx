/**
 * useSecureStorage State Machine Path Tests
 *
 * Tests for the state machine path of the useSecureStorage hook.
 * Verifies that when the feature flag is enabled, the hook correctly
 * derives its state from the state machine instead of local state.
 *
 * @module appCore/state/flows/__tests__/useSecureStorage.machine.test
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useSecureStorage } from "../useSecureStorage";
import { AppStateProvider } from "../../machine/AppStateContext";
import type { AppState, LoadingState, ReadyState, OnboardingState } from "../../machine/types";
import * as featureFlags from "../../machine/utils/featureFlags";

// Mock the feature flags module
jest.mock("../../machine/utils/featureFlags", () => ({
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

// Default mock options for useSecureStorage
const defaultOptions = {
  isWindows: false,
  isMacOS: true,
  pendingOAuthData: null,
  pendingOnboardingData: {
    termsAccepted: false,
    phoneType: null as "iphone" | "android" | null,
    emailProvider: null as "google" | "microsoft" | null,
    emailConnected: false,
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

const readyState: ReadyState = {
  status: "ready",
  user: { id: "test", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    hasPermissions: true,
  },
};

const onboardingState: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: { id: "test", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  completedSteps: [],
};

describe("useSecureStorage - State Machine Path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    mockIsNewStateMachineEnabled.mockReturnValue(true);
  });

  const createWrapper = (initialState?: AppState) => {
    return ({ children }: { children: React.ReactNode }) => (
      <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
    );
  };

  describe("return interface", () => {
    it("returns the same interface shape as legacy path", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      // Verify all expected properties exist
      expect(result.current).toHaveProperty("hasSecureStorageSetup");
      expect(result.current).toHaveProperty("isCheckingSecureStorage");
      expect(result.current).toHaveProperty("isDatabaseInitialized");
      expect(result.current).toHaveProperty("isInitializingDatabase");
      expect(result.current).toHaveProperty("initializeSecureStorage");

      // Verify types
      expect(typeof result.current.hasSecureStorageSetup).toBe("boolean");
      expect(typeof result.current.isCheckingSecureStorage).toBe("boolean");
      expect(typeof result.current.isDatabaseInitialized).toBe("boolean");
      expect(typeof result.current.isInitializingDatabase).toBe("boolean");
      expect(typeof result.current.initializeSecureStorage).toBe("function");
    });
  });

  describe("isDatabaseInitialized", () => {
    it("returns false when checking storage", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.isDatabaseInitialized).toBe(false);
    });

    it("returns false when initializing database", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.isDatabaseInitialized).toBe(false);
    });

    it("returns true when loading auth (past db init)", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingAuth),
      });
      expect(result.current.isDatabaseInitialized).toBe(true);
    });

    it("returns true when loading user data (past db init)", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.isDatabaseInitialized).toBe(true);
    });

    it("returns true when ready", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.isDatabaseInitialized).toBe(true);
    });

    it("returns true when onboarding", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(onboardingState),
      });
      expect(result.current.isDatabaseInitialized).toBe(true);
    });
  });

  describe("isCheckingSecureStorage", () => {
    it("returns true when in checking-storage phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.isCheckingSecureStorage).toBe(true);
    });

    it("returns false when past checking-storage phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.isCheckingSecureStorage).toBe(false);
    });

    it("returns false when ready", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.isCheckingSecureStorage).toBe(false);
    });
  });

  describe("isInitializingDatabase", () => {
    it("returns false when checking storage", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.isInitializingDatabase).toBe(false);
    });

    it("returns true when in initializing-db phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.isInitializingDatabase).toBe(true);
    });

    it("returns false when past initializing-db phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingAuth),
      });
      expect(result.current.isInitializingDatabase).toBe(false);
    });

    it("returns false when ready", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.isInitializingDatabase).toBe(false);
    });
  });

  describe("hasSecureStorageSetup", () => {
    it("returns false when in checking-storage phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.hasSecureStorageSetup).toBe(false);
    });

    it("returns true when past checking-storage phase", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.hasSecureStorageSetup).toBe(true);
    });

    it("returns true when ready", () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.hasSecureStorageSetup).toBe(true);
    });
  });

  describe("initializeSecureStorage", () => {
    it("returns true (initialization handled by orchestrator)", async () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });

      let initResult: boolean | undefined;
      await act(async () => {
        initResult = await result.current.initializeSecureStorage();
      });

      expect(initResult).toBe(true);
    });

    it("is callable multiple times", async () => {
      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      await act(async () => {
        const result1 = await result.current.initializeSecureStorage();
        const result2 = await result.current.initializeSecureStorage();
        expect(result1).toBe(true);
        expect(result2).toBe(true);
      });
    });
  });

  describe("feature flag toggle", () => {
    it("uses state machine path when flag is enabled", () => {
      mockIsNewStateMachineEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useSecureStorage(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      // Should use derived state (ready state = db initialized)
      expect(result.current.isDatabaseInitialized).toBe(true);
      expect(result.current.isCheckingSecureStorage).toBe(false);
    });
  });

  describe("state transitions", () => {
    it("returns correct values for each loading phase", () => {
      // Test checking-storage phase
      const { result: resultChecking } = renderHook(
        () => useSecureStorage(defaultOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultChecking.current.isCheckingSecureStorage).toBe(true);
      expect(resultChecking.current.isDatabaseInitialized).toBe(false);
      expect(resultChecking.current.isInitializingDatabase).toBe(false);

      // Test initializing-db phase
      const { result: resultInit } = renderHook(
        () => useSecureStorage(defaultOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultInit.current.isCheckingSecureStorage).toBe(false);
      expect(resultInit.current.isInitializingDatabase).toBe(true);
      expect(resultInit.current.isDatabaseInitialized).toBe(false);

      // Test loading-auth phase (past db init)
      const { result: resultAuth } = renderHook(
        () => useSecureStorage(defaultOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultAuth.current.isCheckingSecureStorage).toBe(false);
      expect(resultAuth.current.isInitializingDatabase).toBe(false);
      expect(resultAuth.current.isDatabaseInitialized).toBe(true);
    });

    it("returns correct values for ready and onboarding states", () => {
      // Test ready state
      const { result: resultReady } = renderHook(
        () => useSecureStorage(defaultOptions),
        { wrapper: createWrapper(readyState) }
      );
      expect(resultReady.current.isCheckingSecureStorage).toBe(false);
      expect(resultReady.current.isInitializingDatabase).toBe(false);
      expect(resultReady.current.isDatabaseInitialized).toBe(true);
      expect(resultReady.current.hasSecureStorageSetup).toBe(true);

      // Test onboarding state
      const { result: resultOnboarding } = renderHook(
        () => useSecureStorage(defaultOptions),
        { wrapper: createWrapper(onboardingState) }
      );
      expect(resultOnboarding.current.isCheckingSecureStorage).toBe(false);
      expect(resultOnboarding.current.isInitializingDatabase).toBe(false);
      expect(resultOnboarding.current.isDatabaseInitialized).toBe(true);
      expect(resultOnboarding.current.hasSecureStorageSetup).toBe(true);
    });
  });
});

describe("useSecureStorage - State Machine Required", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.clear();
    // Disable state machine
    mockIsNewStateMachineEnabled.mockReturnValue(false);
  });

  it("throws error when feature flag is disabled (legacy path removed)", () => {
    // Legacy code paths have been removed - hook now requires state machine
    expect(() => {
      renderHook(() => useSecureStorage(defaultOptions));
    }).toThrow("useSecureStorage requires state machine to be enabled");
  });
});
