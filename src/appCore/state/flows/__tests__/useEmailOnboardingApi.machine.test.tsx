/**
 * useEmailOnboardingApi State Machine Path Tests
 *
 * Tests for the state machine path of the useEmailOnboardingApi hook.
 * Verifies that when the feature flag is enabled, the hook correctly
 * derives its state from the state machine instead of local state.
 *
 * TASK-1612: Updated to mock authService instead of window.api.
 *
 * @module appCore/state/flows/__tests__/useEmailOnboardingApi.machine.test
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useEmailOnboardingApi } from "../useEmailOnboardingApi";
import { AppStateProvider } from "../../machine/AppStateContext";
import type {
  AppState,
  LoadingState,
  ReadyState,
  OnboardingState,
} from "../../machine/types";
import * as featureFlags from "../../machine/utils/featureFlags";

// Mock the feature flags module
jest.mock("../../machine/utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const mockIsNewStateMachineEnabled =
  featureFlags.isNewStateMachineEnabled as jest.Mock;

// Mock authService methods
const mockCompleteEmailOnboarding = jest.fn();

// TASK-1612: Mock the authService module instead of window.api
jest.mock("@/services", () => ({
  authService: {
    completeEmailOnboarding: (...args: unknown[]) => mockCompleteEmailOnboarding(...args),
  },
}));

// Default mock options for useEmailOnboardingApi
const defaultOptions = {
  userId: "test-user-id",
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

const readyStateEmailConnected: ReadyState = {
  status: "ready",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    fda: "granted",
  },
};

const readyStateEmailNotConnected: ReadyState = {
  status: "ready",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: false,
    needsDriverSetup: false,
    fda: "granted",
  },
};

const onboardingStatePhoneType: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  completedSteps: [],
};

const onboardingStateEmailConnect: OnboardingState = {
  status: "onboarding",
  step: "email-connect",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  completedSteps: ["phone-type", "secure-storage"],
};

const onboardingStatePermissions: OnboardingState = {
  status: "onboarding",
  step: "permissions",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  completedSteps: ["phone-type", "secure-storage", "email-connect"],
};

describe("useEmailOnboardingApi - State Machine Path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsNewStateMachineEnabled.mockReturnValue(true);
  });

  const createWrapper = (initialState?: AppState) => {
    return ({ children }: { children: React.ReactNode }) => (
      <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
    );
  };

  describe("return interface", () => {
    it("returns the same interface shape as legacy path", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });

      // Verify all expected properties exist
      expect(result.current).toHaveProperty("hasCompletedEmailOnboarding");
      expect(result.current).toHaveProperty("hasEmailConnected");
      expect(result.current).toHaveProperty("isCheckingEmailOnboarding");
      expect(result.current).toHaveProperty("setHasCompletedEmailOnboarding");
      expect(result.current).toHaveProperty("setHasEmailConnected");
      expect(result.current).toHaveProperty("completeEmailOnboarding");

      // Verify types
      expect(typeof result.current.hasCompletedEmailOnboarding).toBe("boolean");
      expect(typeof result.current.hasEmailConnected).toBe("boolean");
      expect(typeof result.current.isCheckingEmailOnboarding).toBe("boolean");
      expect(typeof result.current.setHasCompletedEmailOnboarding).toBe("function");
      expect(typeof result.current.setHasEmailConnected).toBe("function");
      expect(typeof result.current.completeEmailOnboarding).toBe("function");
    });
  });

  describe("hasCompletedEmailOnboarding", () => {
    it("returns false when on email-connect onboarding step", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.hasCompletedEmailOnboarding).toBe(false);
    });

    it("returns true when past email-connect step", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePermissions),
      });
      expect(result.current.hasCompletedEmailOnboarding).toBe(true);
    });

    it("returns true when ready", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });
      expect(result.current.hasCompletedEmailOnboarding).toBe(true);
    });

    it("returns false during loading", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.hasCompletedEmailOnboarding).toBe(false);
    });

    it("returns false when on phone-type step (before email-connect)", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });
      expect(result.current.hasCompletedEmailOnboarding).toBe(false);
    });
  });

  describe("hasEmailConnected", () => {
    it("returns true when user has email connected (ready state)", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });
      expect(result.current.hasEmailConnected).toBe(true);
    });

    it("returns false when user has no email connected (ready state)", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailNotConnected),
      });
      expect(result.current.hasEmailConnected).toBe(false);
    });

    it("returns false during onboarding (email not yet connected)", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.hasEmailConnected).toBe(false);
    });

    it("returns true during loading (to avoid flicker)", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      // Loading state returns true to avoid flicker (matching legacy behavior)
      expect(result.current.hasEmailConnected).toBe(true);
    });
  });

  describe("isCheckingEmailOnboarding", () => {
    it("returns true when checking storage", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(true);
    });

    it("returns true when initializing database", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(true);
    });

    it("returns true when loading auth", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingAuth),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(true);
    });

    it("returns true when loading user data", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(true);
    });

    it("returns false when ready", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(false);
    });

    it("returns false when onboarding", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.isCheckingEmailOnboarding).toBe(false);
    });
  });

  describe("setters (no-ops)", () => {
    it("setHasCompletedEmailOnboarding is a no-op", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });

      const valueBefore = result.current.hasCompletedEmailOnboarding;
      act(() => {
        result.current.setHasCompletedEmailOnboarding(false);
      });
      // Value should remain unchanged
      expect(result.current.hasCompletedEmailOnboarding).toBe(valueBefore);
    });

    it("setHasEmailConnected is a no-op", () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });

      const valueBefore = result.current.hasEmailConnected;
      act(() => {
        result.current.setHasEmailConnected(false);
      });
      // Value should remain unchanged
      expect(result.current.hasEmailConnected).toBe(valueBefore);
    });
  });

  describe("completeEmailOnboarding", () => {
    it("calls API on success", async () => {
      mockCompleteEmailOnboarding.mockResolvedValueOnce({ success: true });

      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });

      await act(async () => {
        await result.current.completeEmailOnboarding();
      });

      expect(mockCompleteEmailOnboarding).toHaveBeenCalledWith("test-user");
    });

    it("handles API error gracefully", async () => {
      mockCompleteEmailOnboarding.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });

      // Should not throw
      await act(async () => {
        await result.current.completeEmailOnboarding();
      });

      expect(mockCompleteEmailOnboarding).toHaveBeenCalledWith("test-user");
    });

    it("does nothing when no user is available (loading state)", async () => {
      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });

      await act(async () => {
        await result.current.completeEmailOnboarding();
      });

      expect(mockCompleteEmailOnboarding).not.toHaveBeenCalled();
    });

    it("uses user id from state machine, not from options", async () => {
      mockCompleteEmailOnboarding.mockResolvedValueOnce({ success: true });

      // Options have different userId than state machine
      const optionsWithDifferentUser = {
        ...defaultOptions,
        userId: "different-user-id",
      };

      const { result } = renderHook(
        () => useEmailOnboardingApi(optionsWithDifferentUser),
        {
          wrapper: createWrapper(onboardingStateEmailConnect),
        }
      );

      await act(async () => {
        await result.current.completeEmailOnboarding();
      });

      // Should use user id from state machine (test-user), not from options
      expect(mockCompleteEmailOnboarding).toHaveBeenCalledWith("test-user");
    });
  });

  describe("state transitions", () => {
    it("returns correct values for each loading phase", () => {
      // Test checking-storage phase
      const { result: resultChecking } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultChecking.current.isCheckingEmailOnboarding).toBe(true);
      expect(resultChecking.current.hasCompletedEmailOnboarding).toBe(false);
      expect(resultChecking.current.hasEmailConnected).toBe(true); // true during loading to avoid flicker

      // Test initializing-db phase
      const { result: resultInit } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultInit.current.isCheckingEmailOnboarding).toBe(true);
      expect(resultInit.current.hasCompletedEmailOnboarding).toBe(false);

      // Test loading-auth phase
      const { result: resultAuth } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultAuth.current.isCheckingEmailOnboarding).toBe(true);
      expect(resultAuth.current.hasCompletedEmailOnboarding).toBe(false);

      // Test loading-user-data phase
      const { result: resultUserData } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(loadingUserData) }
      );
      expect(resultUserData.current.isCheckingEmailOnboarding).toBe(true);
      expect(resultUserData.current.hasCompletedEmailOnboarding).toBe(false);
    });

    it("returns correct values for ready and onboarding states", () => {
      // Test ready state with email connected
      const { result: resultReady } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(readyStateEmailConnected) }
      );
      expect(resultReady.current.isCheckingEmailOnboarding).toBe(false);
      expect(resultReady.current.hasCompletedEmailOnboarding).toBe(true);
      expect(resultReady.current.hasEmailConnected).toBe(true);

      // Test ready state without email connected
      const { result: resultReadyNoEmail } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(readyStateEmailNotConnected) }
      );
      expect(resultReadyNoEmail.current.hasEmailConnected).toBe(false);

      // Test onboarding state (email-connect step)
      const { result: resultOnboarding } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(onboardingStateEmailConnect) }
      );
      expect(resultOnboarding.current.isCheckingEmailOnboarding).toBe(false);
      expect(resultOnboarding.current.hasCompletedEmailOnboarding).toBe(false);
      expect(resultOnboarding.current.hasEmailConnected).toBe(false);

      // Test onboarding state (past email-connect step)
      const { result: resultOnboardingPast } = renderHook(
        () => useEmailOnboardingApi(defaultOptions),
        { wrapper: createWrapper(onboardingStatePermissions) }
      );
      expect(resultOnboardingPast.current.isCheckingEmailOnboarding).toBe(false);
      expect(resultOnboardingPast.current.hasCompletedEmailOnboarding).toBe(true);
    });
  });

  describe("feature flag toggle", () => {
    it("uses state machine path when flag is enabled", () => {
      mockIsNewStateMachineEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useEmailOnboardingApi(defaultOptions), {
        wrapper: createWrapper(readyStateEmailConnected),
      });

      // Should use derived state (ready state = email onboarding complete)
      expect(result.current.hasCompletedEmailOnboarding).toBe(true);
      expect(result.current.hasEmailConnected).toBe(true);
      expect(result.current.isCheckingEmailOnboarding).toBe(false);
    });
  });
});

describe("useEmailOnboardingApi - State Machine Required", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Disable state machine
    mockIsNewStateMachineEnabled.mockReturnValue(false);
  });

  it("throws error when feature flag is disabled (legacy path removed)", () => {
    // Legacy code paths have been removed - hook now requires state machine
    expect(() => {
      renderHook(() => useEmailOnboardingApi(defaultOptions));
    }).toThrow("useEmailOnboardingApi requires state machine to be enabled");
  });
});
