/**
 * useNavigationFlow State Machine Path Tests
 *
 * Tests for the state machine path of the useNavigationFlow hook.
 * Verifies that when the feature flag is enabled, the hook correctly
 * derives its navigation state from the state machine instead of effects.
 *
 * @module appCore/state/flows/__tests__/useNavigationFlow.machine.test
 */

import React from "react";
import { renderHook, act } from "@testing-library/react";
import { useNavigationFlow } from "../useNavigationFlow";
import { AppStateProvider } from "../../machine/AppStateContext";
import type {
  AppState,
  LoadingState,
  ReadyState,
  OnboardingState,
  UnauthenticatedState,
  ErrorState,
} from "../../machine/types";
import * as featureFlags from "../../machine/utils/featureFlags";

// Mock the feature flags module
jest.mock("../../machine/utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const mockIsNewStateMachineEnabled =
  featureFlags.isNewStateMachineEnabled as jest.Mock;

// Default mock options for useNavigationFlow (legacy path requires these)
const defaultOptions = {
  isAuthenticated: false,
  isAuthLoading: false,
  needsTermsAcceptance: false,
  isMacOS: true,
  isWindows: false,
  pendingOAuthData: null,
  pendingOnboardingData: {
    termsAccepted: false,
    phoneType: null as "iphone" | "android" | null,
    emailConnected: false,
    emailProvider: null as "google" | "microsoft" | null,
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

const readyState: ReadyState = {
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

const onboardingStatePhoneType: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  completedSteps: [],
};

const onboardingStateSecureStorage: OnboardingState = {
  status: "onboarding",
  step: "secure-storage",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: true },
  completedSteps: ["phone-type"],
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

const onboardingStateAppleDriver: OnboardingState = {
  status: "onboarding",
  step: "apple-driver",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: false, isWindows: true, hasIPhone: true },
  completedSteps: ["phone-type", "email-connect"],
};

const onboardingStateAndroidComingSoon: OnboardingState = {
  status: "onboarding",
  step: "android-coming-soon",
  user: { id: "test-user", email: "test@example.com" },
  platform: { isMacOS: true, isWindows: false, hasIPhone: false },
  completedSteps: ["phone-type"],
};

const errorState: ErrorState = {
  status: "error",
  error: { code: "UNKNOWN_ERROR", message: "Test error" },
  recoverable: true,
};

describe("useNavigationFlow - State Machine Path", () => {
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
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      // Verify all expected properties exist
      expect(result.current).toHaveProperty("currentStep");
      expect(result.current).toHaveProperty("showSetupPromptDismissed");
      expect(result.current).toHaveProperty("isTourActive");
      expect(result.current).toHaveProperty("setCurrentStep");
      expect(result.current).toHaveProperty("setIsTourActive");
      expect(result.current).toHaveProperty("goToStep");
      expect(result.current).toHaveProperty("goToEmailOnboarding");
      expect(result.current).toHaveProperty("handleDismissSetupPrompt");
      expect(result.current).toHaveProperty("getPageTitle");

      // Verify types
      expect(typeof result.current.currentStep).toBe("string");
      expect(typeof result.current.showSetupPromptDismissed).toBe("boolean");
      expect(typeof result.current.isTourActive).toBe("boolean");
      expect(typeof result.current.setCurrentStep).toBe("function");
      expect(typeof result.current.setIsTourActive).toBe("function");
      expect(typeof result.current.goToStep).toBe("function");
      expect(typeof result.current.goToEmailOnboarding).toBe("function");
      expect(typeof result.current.handleDismissSetupPrompt).toBe("function");
      expect(typeof result.current.getPageTitle).toBe("function");
    });
  });

  describe("currentStep derivation", () => {
    it("returns 'loading' when in loading state", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.currentStep).toBe("loading");
    });

    it("returns 'loading' for all loading phases", () => {
      const phases = [
        loadingCheckingStorage,
        loadingInitializingDb,
        loadingAuth,
        loadingUserData,
      ];

      phases.forEach((loadingState) => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(loadingState),
        });
        expect(result.current.currentStep).toBe("loading");
      });
    });

    it("returns 'login' when unauthenticated", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(unauthenticatedState),
      });
      expect(result.current.currentStep).toBe("login");
    });

    it("returns 'dashboard' when ready", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.currentStep).toBe("dashboard");
    });

    it("returns 'error' when in error state", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(errorState),
      });
      // TASK-2278: Error state now maps to 'error' (shows ErrorScreen with retry)
      expect(result.current.currentStep).toBe("error");
    });

    describe("onboarding step mapping", () => {
      it("maps phone-type to phone-type-selection", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStatePhoneType),
        });
        expect(result.current.currentStep).toBe("phone-type-selection");
      });

      it("maps secure-storage to keychain-explanation", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStateSecureStorage),
        });
        expect(result.current.currentStep).toBe("keychain-explanation");
      });

      it("maps email-connect to email-onboarding", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStateEmailConnect),
        });
        expect(result.current.currentStep).toBe("email-onboarding");
      });

      it("maps permissions to permissions", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStatePermissions),
        });
        expect(result.current.currentStep).toBe("permissions");
      });

      it("maps apple-driver to apple-driver-setup", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStateAppleDriver),
        });
        expect(result.current.currentStep).toBe("apple-driver-setup");
      });

      it("maps android-coming-soon to android-coming-soon", () => {
        const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
          wrapper: createWrapper(onboardingStateAndroidComingSoon),
        });
        expect(result.current.currentStep).toBe("android-coming-soon");
      });
    });
  });

  describe("setters (no-ops)", () => {
    it("setCurrentStep is a no-op", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      const valueBefore = result.current.currentStep;
      act(() => {
        result.current.setCurrentStep("login");
      });
      // Value should remain unchanged (derived from state)
      expect(result.current.currentStep).toBe(valueBefore);
    });

    it("goToStep is a no-op", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      const valueBefore = result.current.currentStep;
      act(() => {
        result.current.goToStep("login");
      });
      // Value should remain unchanged
      expect(result.current.currentStep).toBe(valueBefore);
    });

    it("goToEmailOnboarding dispatches START_EMAIL_SETUP and navigates to email onboarding", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      // Should start on dashboard (ready state)
      expect(result.current.currentStep).toBe("dashboard");
      act(() => {
        result.current.goToEmailOnboarding();
      });
      // Should now be on email onboarding
      expect(result.current.currentStep).toBe("email-onboarding");
    });
  });

  describe("UI-only state (preserved)", () => {
    it("handleDismissSetupPrompt updates showSetupPromptDismissed", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      expect(result.current.showSetupPromptDismissed).toBe(false);
      act(() => {
        result.current.handleDismissSetupPrompt();
      });
      expect(result.current.showSetupPromptDismissed).toBe(true);
    });

    it("setIsTourActive updates isTourActive", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      expect(result.current.isTourActive).toBe(false);
      act(() => {
        result.current.setIsTourActive(true);
      });
      expect(result.current.isTourActive).toBe(true);
    });
  });

  describe("getPageTitle", () => {
    it("returns 'Welcome' for login step", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(unauthenticatedState),
      });
      expect(result.current.getPageTitle()).toBe("Welcome");
    });

    it("returns 'Setup' for email-onboarding step", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });
      expect(result.current.getPageTitle()).toBe("Setup");
    });

    it("returns 'Setup' for permissions step", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(onboardingStatePermissions),
      });
      expect(result.current.getPageTitle()).toBe("Setup");
    });

    it("returns 'Keepr' for dashboard step", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });
      expect(result.current.getPageTitle()).toBe("Keepr.");
    });

    it("returns 'Keepr.' for loading step (default)", () => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(loadingCheckingStorage),
      });
      expect(result.current.getPageTitle()).toBe("Keepr.");
    });
  });

  describe("no navigation effects", () => {
    it("does not trigger navigation effects in state machine mode", () => {
      // This test verifies that the hook doesn't use effects for navigation
      // by checking that the derived step is immediately available
      // (effects would cause initial render to have wrong value)
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(onboardingStateEmailConnect),
      });

      // Should be immediately correct (no effect needed)
      expect(result.current.currentStep).toBe("email-onboarding");
    });

    it("maintains derived state across renders", () => {
      const { result, rerender } = renderHook(
        () => useNavigationFlow(defaultOptions),
        {
          wrapper: createWrapper(readyState),
        }
      );

      expect(result.current.currentStep).toBe("dashboard");
      rerender();
      expect(result.current.currentStep).toBe("dashboard");
    });
  });

  describe("feature flag toggle", () => {
    it("uses state machine path when flag is enabled", () => {
      mockIsNewStateMachineEnabled.mockReturnValue(true);

      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(readyState),
      });

      // Should use derived state (ready state = dashboard)
      expect(result.current.currentStep).toBe("dashboard");
    });
  });
});

describe("useNavigationFlow - State Machine Required", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Disable state machine
    mockIsNewStateMachineEnabled.mockReturnValue(false);
  });

  it("throws error when feature flag is disabled (legacy path removed)", () => {
    // Legacy code paths have been removed - hook now requires state machine
    expect(() => {
      renderHook(() => useNavigationFlow(defaultOptions));
    }).toThrow("useNavigationFlow requires state machine to be enabled");
  });
});

describe("deriveAppStep mapping completeness", () => {
  beforeEach(() => {
    mockIsNewStateMachineEnabled.mockReturnValue(true);
  });

  const createWrapper = (initialState?: AppState) => {
    return ({ children }: { children: React.ReactNode }) => (
      <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
    );
  };

  it("maps all onboarding steps correctly", () => {
    const stepMappings: Array<{
      onboardingStep: OnboardingState["step"];
      expectedAppStep: string;
    }> = [
      { onboardingStep: "phone-type", expectedAppStep: "phone-type-selection" },
      { onboardingStep: "secure-storage", expectedAppStep: "keychain-explanation" },
      { onboardingStep: "email-connect", expectedAppStep: "email-onboarding" },
      { onboardingStep: "permissions", expectedAppStep: "permissions" },
      { onboardingStep: "apple-driver", expectedAppStep: "apple-driver-setup" },
      { onboardingStep: "android-coming-soon", expectedAppStep: "android-coming-soon" },
    ];

    stepMappings.forEach(({ onboardingStep, expectedAppStep }) => {
      const state: OnboardingState = {
        status: "onboarding",
        step: onboardingStep,
        user: { id: "test-user", email: "test@example.com" },
        platform: { isMacOS: true, isWindows: false, hasIPhone: true },
        completedSteps: [],
      };

      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(state),
      });

      expect(result.current.currentStep).toBe(expectedAppStep);
    });
  });

  it("maps all status types correctly", () => {
    const statusMappings: Array<{
      state: AppState;
      expectedAppStep: string;
      description: string;
    }> = [
      {
        state: loadingCheckingStorage,
        expectedAppStep: "loading",
        description: "loading -> loading",
      },
      {
        state: unauthenticatedState,
        expectedAppStep: "login",
        description: "unauthenticated -> login",
      },
      {
        state: readyState,
        expectedAppStep: "dashboard",
        description: "ready -> dashboard",
      },
      {
        state: errorState,
        expectedAppStep: "error",
        description: "error -> error",
      },
    ];

    statusMappings.forEach(({ state, expectedAppStep, description }) => {
      const { result } = renderHook(() => useNavigationFlow(defaultOptions), {
        wrapper: createWrapper(state),
      });

      expect(result.current.currentStep).toBe(expectedAppStep);
    });
  });
});
