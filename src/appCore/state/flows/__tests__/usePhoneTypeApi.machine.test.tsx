/**
 * usePhoneTypeApi State Machine Path Tests
 *
 * Tests for the state machine path of the usePhoneTypeApi hook.
 * Verifies that when the feature flag is enabled, the hook correctly
 * derives its state from the state machine instead of local state.
 *
 * TASK-1612: Updated to mock settingsService instead of window.api.
 *
 * @module appCore/state/flows/__tests__/usePhoneTypeApi.machine.test
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { usePhoneTypeApi } from "../usePhoneTypeApi";
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

// Mock settingsService methods
const mockSetPhoneType = jest.fn();
const mockSetPhoneTypeCloud = jest.fn();
// BACKLOG-1842: savePhoneType now persists messages.source for Android users.
const mockUpdatePreferences = jest.fn();

// TASK-1612: Mock the settingsService module instead of window.api
jest.mock("@/services", () => ({
  settingsService: {
    setPhoneType: (...args: unknown[]) => mockSetPhoneType(...args),
    setPhoneTypeCloud: (...args: unknown[]) => mockSetPhoneTypeCloud(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

// Default mock options for usePhoneTypeApi
const defaultOptions = {
  userId: "test-user-id",
  isWindows: false,
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

const readyStateIPhone: ReadyState = {
  status: "ready",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    hasPermissions: true,
  },
};

const readyStateAndroid: ReadyState = {
  status: "ready",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  userData: {
    phoneType: "android",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    hasPermissions: true,
  },
};


const readyStateWindowsIPhoneNeedsDriver: ReadyState = {
  status: "ready",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: false, isWindows: true, hasIPhone: true },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: true,
    hasPermissions: true,
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
  completedSteps: ["phone-type"],
};

const onboardingStateWindowsIPhone: OnboardingState = {
  status: "onboarding",
  step: "apple-driver",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: false, isWindows: true, hasIPhone: true },
  completedSteps: ["phone-type", "email-connect"],
};

describe("usePhoneTypeApi - State Machine Path", () => {
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
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });

      // Verify all expected properties exist
      expect(result.current).toHaveProperty("hasSelectedPhoneType");
      expect(result.current).toHaveProperty("selectedPhoneType");
      expect(result.current).toHaveProperty("isLoadingPhoneType");
      expect(result.current).toHaveProperty("needsDriverSetup");
      expect(result.current).toHaveProperty("setHasSelectedPhoneType");
      expect(result.current).toHaveProperty("setSelectedPhoneType");
      expect(result.current).toHaveProperty("setNeedsDriverSetup");
      expect(result.current).toHaveProperty("savePhoneType");

      // Verify types
      expect(typeof result.current.hasSelectedPhoneType).toBe("boolean");
      expect(typeof result.current.isLoadingPhoneType).toBe("boolean");
      expect(typeof result.current.needsDriverSetup).toBe("boolean");
      expect(typeof result.current.setHasSelectedPhoneType).toBe("function");
      expect(typeof result.current.setSelectedPhoneType).toBe("function");
      expect(typeof result.current.setNeedsDriverSetup).toBe("function");
      expect(typeof result.current.savePhoneType).toBe("function");
    });
  });

  describe("hasSelectedPhoneType", () => {
    it("returns false when on phone-type onboarding step", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });
      expect(result.current.hasSelectedPhoneType).toBe(false);
    });

    it("returns true when past phone-type step", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.hasSelectedPhoneType).toBe(true);
    });

    it("returns true when ready", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });
      expect(result.current.hasSelectedPhoneType).toBe(true);
    });

    it("returns false during loading", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.hasSelectedPhoneType).toBe(false);
    });
  });

  describe("selectedPhoneType", () => {
    it("returns iphone when user has selected iphone", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });
      expect(result.current.selectedPhoneType).toBe("iphone");
    });

    it("returns android when user has selected android", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateAndroid),
      });
      expect(result.current.selectedPhoneType).toBe("android");
    });

    it("returns null when no phone type selected", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });
      expect(result.current.selectedPhoneType).toBeNull();
    });

    it("returns iphone from platform during onboarding when hasIPhone is true", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.selectedPhoneType).toBe("iphone");
    });

    it("returns null during loading", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.selectedPhoneType).toBeNull();
    });
  });

  describe("isLoadingPhoneType", () => {
    it("returns true when checking storage", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.isLoadingPhoneType).toBe(true);
    });

    it("returns true when initializing database", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingInitializingDb),
      });
      expect(result.current.isLoadingPhoneType).toBe(true);
    });

    it("returns true when loading auth", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingAuth),
      });
      expect(result.current.isLoadingPhoneType).toBe(true);
    });

    it("returns true when loading user data", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      expect(result.current.isLoadingPhoneType).toBe(true);
    });

    it("returns false when ready", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });
      expect(result.current.isLoadingPhoneType).toBe(false);
    });

    it("returns false when onboarding", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });
      expect(result.current.isLoadingPhoneType).toBe(false);
    });
  });

  describe("needsDriverSetup", () => {
    it("returns true for Windows + iPhone user needing drivers (ready state)", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateWindowsIPhoneNeedsDriver),
      });
      expect(result.current.needsDriverSetup).toBe(true);
    });

    it("returns false for macOS user (ready state)", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });
      expect(result.current.needsDriverSetup).toBe(false);
    });

    it("returns true for Windows + iPhone during onboarding", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStateWindowsIPhone),
      });
      expect(result.current.needsDriverSetup).toBe(true);
    });

    it("returns false for macOS user during onboarding", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });
      expect(result.current.needsDriverSetup).toBe(false);
    });

    it("returns false during loading", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });
      // Returns false because status is loading (not ready or onboarding)
      expect(result.current.needsDriverSetup).toBe(false);
    });
  });

  describe("setters (no-ops)", () => {
    it("setHasSelectedPhoneType is a no-op", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });

      const valueBefore = result.current.hasSelectedPhoneType;
      act(() => {
        result.current.setHasSelectedPhoneType(false);
      });
      // Value should remain unchanged
      expect(result.current.hasSelectedPhoneType).toBe(valueBefore);
    });

    it("setSelectedPhoneType is a no-op", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });

      const valueBefore = result.current.selectedPhoneType;
      act(() => {
        result.current.setSelectedPhoneType("android");
      });
      // Value should remain unchanged (iphone from state)
      expect(result.current.selectedPhoneType).toBe(valueBefore);
    });

    it("setNeedsDriverSetup is a no-op", () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });

      const valueBefore = result.current.needsDriverSetup;
      act(() => {
        result.current.setNeedsDriverSetup(true);
      });
      // Value should remain unchanged
      expect(result.current.needsDriverSetup).toBe(valueBefore);
    });
  });

  describe("savePhoneType", () => {
    beforeEach(() => {
      // TASK-1600: Default to successful cloud save
      mockSetPhoneTypeCloud.mockResolvedValue({ success: true });
      mockSetPhoneType.mockResolvedValue({ success: true });
      // BACKLOG-1842: default successful preference update
      mockUpdatePreferences.mockResolvedValue({ success: true });
    });

    // BACKLOG-1842: an Android user must have messages.source persisted so the
    // dashboard sync path never imports local macOS iMessages for them.
    it("persists messages.source='android-companion' when Android is selected", async () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      await act(async () => {
        await result.current.savePhoneType("android");
      });

      expect(mockUpdatePreferences).toHaveBeenCalledWith("test-user", {
        messages: { source: "android-companion" },
      });
    });

    it("does NOT touch messages.source when iPhone is selected (macos-native stays correct)", async () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      await act(async () => {
        await result.current.savePhoneType("iphone");
      });

      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it("still succeeds when the Android messages.source write fails (graceful degradation)", async () => {
      mockUpdatePreferences.mockRejectedValueOnce(new Error("pref error"));

      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.savePhoneType("android");
      });

      // The preference write is best-effort; the phone-type save still succeeds.
      expect(saveResult).toBe(true);
    });

    it("calls cloud API first and local API second, returns true on success", async () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.savePhoneType("iphone");
      });

      // TASK-1600: Cloud API should be called first
      expect(mockSetPhoneTypeCloud).toHaveBeenCalledWith("test-user", "iphone");
      // Local API should also be called (DB is initialized in onboardingStatePhoneType)
      expect(mockSetPhoneType).toHaveBeenCalledWith("test-user", "iphone");
      expect(saveResult).toBe(true);
    });

    it("returns true even when local DB fails (graceful degradation)", async () => {
      // TASK-1600: Local DB failure should not fail the operation
      // Cloud save succeeded (in beforeEach), local fails
      mockSetPhoneType.mockResolvedValueOnce({
        success: false,
        error: "DB error",
      });

      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.savePhoneType("android");
      });

      // TASK-1600: Should still succeed because cloud save worked
      expect(saveResult).toBe(true);
    });

    it("returns false when cloud API throws error", async () => {
      // TASK-1600: Only exception in cloud API should cause failure
      mockSetPhoneTypeCloud.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(onboardingStatePhoneType),
      });

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.savePhoneType("iphone");
      });

      expect(saveResult).toBe(false);
    });

    it("returns false when no user is available (loading state)", async () => {
      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(loadingUserData),
      });

      let saveResult: boolean | undefined;
      await act(async () => {
        saveResult = await result.current.savePhoneType("iphone");
      });

      expect(mockSetPhoneTypeCloud).not.toHaveBeenCalled();
      expect(mockSetPhoneType).not.toHaveBeenCalled();
      expect(saveResult).toBe(false);
    });

    it("uses user id from state machine, not from options", async () => {
      // Options have different userId than state machine
      const optionsWithDifferentUser = {
        ...defaultOptions,
        userId: "different-user-id",
      };

      const { result } = renderHook(
        () => usePhoneTypeApi(optionsWithDifferentUser),
        {
          wrapper: createWrapper(onboardingStatePhoneType),
        }
      );

      await act(async () => {
        await result.current.savePhoneType("iphone");
      });

      // TASK-1600: Should use user id from state machine (test-user), not from options
      // Cloud API is called first
      expect(mockSetPhoneTypeCloud).toHaveBeenCalledWith("test-user", "iphone");
      // Local API is called second
      expect(mockSetPhoneType).toHaveBeenCalledWith("test-user", "iphone");
    });
  });

  describe("state transitions", () => {
    it("returns correct values for each loading phase", () => {
      // Test checking-storage phase
      const { result: resultChecking } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(loadingCheckingStorage) }
      );
      expect(resultChecking.current.isLoadingPhoneType).toBe(true);
      expect(resultChecking.current.hasSelectedPhoneType).toBe(false);
      expect(resultChecking.current.selectedPhoneType).toBeNull();

      // Test initializing-db phase
      const { result: resultInit } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(loadingInitializingDb) }
      );
      expect(resultInit.current.isLoadingPhoneType).toBe(true);
      expect(resultInit.current.hasSelectedPhoneType).toBe(false);

      // Test loading-auth phase
      const { result: resultAuth } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(loadingAuth) }
      );
      expect(resultAuth.current.isLoadingPhoneType).toBe(true);
      expect(resultAuth.current.hasSelectedPhoneType).toBe(false);

      // Test loading-user-data phase
      const { result: resultUserData } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(loadingUserData) }
      );
      expect(resultUserData.current.isLoadingPhoneType).toBe(true);
      expect(resultUserData.current.hasSelectedPhoneType).toBe(false);
    });

    it("returns correct values for ready and onboarding states", () => {
      // Test ready state
      const { result: resultReady } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(readyStateIPhone) }
      );
      expect(resultReady.current.isLoadingPhoneType).toBe(false);
      expect(resultReady.current.hasSelectedPhoneType).toBe(true);
      expect(resultReady.current.selectedPhoneType).toBe("iphone");

      // Test onboarding state (phone-type step)
      const { result: resultOnboarding } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(onboardingStatePhoneType) }
      );
      expect(resultOnboarding.current.isLoadingPhoneType).toBe(false);
      expect(resultOnboarding.current.hasSelectedPhoneType).toBe(false);
      expect(resultOnboarding.current.selectedPhoneType).toBeNull();

      // Test onboarding state (past phone-type step)
      const { result: resultOnboardingPast } = renderHook(
        () => usePhoneTypeApi(defaultOptions),
        { wrapper: createWrapper(onboardingStateEmailConnect) }
      );
      expect(resultOnboardingPast.current.isLoadingPhoneType).toBe(false);
      expect(resultOnboardingPast.current.hasSelectedPhoneType).toBe(true);
      expect(resultOnboardingPast.current.selectedPhoneType).toBe("iphone");
    });
  });

  describe("feature flag toggle", () => {
    it("uses state machine path when flag is enabled", () => {
      mockIsNewStateMachineEnabled.mockReturnValue(true);

      const { result } = renderHook(() => usePhoneTypeApi(defaultOptions), {
        wrapper: createWrapper(readyStateIPhone),
      });

      // Should use derived state (ready state = has phone type)
      expect(result.current.hasSelectedPhoneType).toBe(true);
      expect(result.current.selectedPhoneType).toBe("iphone");
      expect(result.current.isLoadingPhoneType).toBe(false);
    });
  });
});

describe("usePhoneTypeApi - State Machine Required", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Disable state machine
    mockIsNewStateMachineEnabled.mockReturnValue(false);
  });

  it("throws error when feature flag is disabled (legacy path removed)", () => {
    // Legacy code paths have been removed - hook now requires state machine
    expect(() => {
      renderHook(() => usePhoneTypeApi(defaultOptions));
    }).toThrow("usePhoneTypeApi requires state machine to be enabled");
  });
});
