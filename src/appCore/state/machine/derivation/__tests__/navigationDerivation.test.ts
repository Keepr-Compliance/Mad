/**
 * Navigation Derivation Tests
 *
 * Unit tests for navigation derivation pure functions.
 * Tests cover all state types and edge cases.
 */

import {
  deriveNavigationTarget,
  deriveScreen,
  deriveAppStep,
  shouldShowOnboarding,
  isAppReady,
  isLoading,
  isError,
  isAuthenticated,
  isUnauthenticated,
  needsNavigation,
} from "../navigationDerivation";
import type {
  AppState,
  LoadingState,
  UnauthenticatedState,
  OnboardingState,
  ReadyState,
  ErrorState,
  PlatformInfo,
} from "../../types";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const createPlatform = (): PlatformInfo => ({
  isMacOS: true,
  isWindows: false,
  hasIPhone: true,
});

const createLoadingState = (
  phase: LoadingState["phase"] = "checking-storage",
  progress?: number
): LoadingState => ({
  status: "loading",
  phase,
  progress,
});

const createUnauthenticatedState = (): UnauthenticatedState => ({
  status: "unauthenticated",
});

const createOnboardingState = (): OnboardingState => ({
  status: "onboarding",
  step: "phone-type",
  user: { id: "user-1", email: "test@example.com" },
  platform: createPlatform(),
  completedSteps: [],
});

const createReadyState = (): ReadyState => ({
  status: "ready",
  user: { id: "user-1", email: "test@example.com" },
  platform: createPlatform(),
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    fda: "granted",
  },
});

const createErrorState = (recoverable = true): ErrorState => ({
  status: "error",
  error: { code: "UNKNOWN_ERROR", message: "Test error" },
  recoverable,
});

// =============================================================================
// deriveNavigationTarget TESTS
// =============================================================================

describe("deriveNavigationTarget", () => {
  describe("loading state", () => {
    it("should return loading screen with phase", () => {
      const state = createLoadingState("checking-storage");
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("loading");
      expect(target.params?.phase).toBe("checking-storage");
    });

    it("should include progress when available", () => {
      const state = createLoadingState("initializing-db", 50);
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("loading");
      expect(target.params?.phase).toBe("initializing-db");
      expect(target.params?.progress).toBe(50);
    });

    it("should handle all loading phases", () => {
      const phases: LoadingState["phase"][] = [
        "checking-storage",
        "initializing-db",
        "loading-auth",
        "loading-user-data",
      ];

      phases.forEach((phase) => {
        const state = createLoadingState(phase);
        const target = deriveNavigationTarget(state);
        expect(target.screen).toBe("loading");
        expect(target.params?.phase).toBe(phase);
      });
    });
  });

  describe("unauthenticated state", () => {
    it("should return login screen without params", () => {
      const state = createUnauthenticatedState();
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("login");
      expect(target.params).toBeUndefined();
    });
  });

  describe("onboarding state", () => {
    it("should return onboarding screen with step", () => {
      const state = createOnboardingState();
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("onboarding");
      expect(target.params?.step).toBe("phone-type");
    });

    it("should include different steps", () => {
      const state: OnboardingState = {
        ...createOnboardingState(),
        step: "email-connect",
      };
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("onboarding");
      expect(target.params?.step).toBe("email-connect");
    });
  });

  describe("ready state", () => {
    it("should return dashboard screen without params", () => {
      const state = createReadyState();
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("dashboard");
      expect(target.params).toBeUndefined();
    });
  });

  describe("error state", () => {
    it("should return error screen with error details", () => {
      const state = createErrorState(true);
      const target = deriveNavigationTarget(state);

      expect(target.screen).toBe("error");
      expect(target.params?.error).toEqual({
        code: "UNKNOWN_ERROR",
        message: "Test error",
      });
      expect(target.params?.recoverable).toBe(true);
    });

    it("should include recoverable flag correctly", () => {
      const recoverableState = createErrorState(true);
      const nonRecoverableState = createErrorState(false);

      expect(deriveNavigationTarget(recoverableState).params?.recoverable).toBe(
        true
      );
      expect(
        deriveNavigationTarget(nonRecoverableState).params?.recoverable
      ).toBe(false);
    });
  });
});

// =============================================================================
// deriveScreen TESTS
// =============================================================================

describe("deriveScreen", () => {
  it("should return loading for loading state", () => {
    expect(deriveScreen(createLoadingState())).toBe("loading");
  });

  it("should return login for unauthenticated state", () => {
    expect(deriveScreen(createUnauthenticatedState())).toBe("login");
  });

  it("should return onboarding for onboarding state", () => {
    expect(deriveScreen(createOnboardingState())).toBe("onboarding");
  });

  it("should return dashboard for ready state", () => {
    expect(deriveScreen(createReadyState())).toBe("dashboard");
  });

  it("should return error for error state", () => {
    expect(deriveScreen(createErrorState())).toBe("error");
  });
});

// =============================================================================
// shouldShowOnboarding TESTS
// =============================================================================

describe("shouldShowOnboarding", () => {
  it("should return true for onboarding state", () => {
    expect(shouldShowOnboarding(createOnboardingState())).toBe(true);
  });

  it("should return false for loading state", () => {
    expect(shouldShowOnboarding(createLoadingState())).toBe(false);
  });

  it("should return false for unauthenticated state", () => {
    expect(shouldShowOnboarding(createUnauthenticatedState())).toBe(false);
  });

  it("should return false for ready state", () => {
    expect(shouldShowOnboarding(createReadyState())).toBe(false);
  });

  it("should return false for error state", () => {
    expect(shouldShowOnboarding(createErrorState())).toBe(false);
  });
});

// =============================================================================
// isAppReady TESTS
// =============================================================================

describe("isAppReady", () => {
  it("should return true for ready state", () => {
    expect(isAppReady(createReadyState())).toBe(true);
  });

  it("should return false for all other states", () => {
    expect(isAppReady(createLoadingState())).toBe(false);
    expect(isAppReady(createUnauthenticatedState())).toBe(false);
    expect(isAppReady(createOnboardingState())).toBe(false);
    expect(isAppReady(createErrorState())).toBe(false);
  });
});

// =============================================================================
// isLoading TESTS
// =============================================================================

describe("isLoading", () => {
  it("should return true for loading state", () => {
    expect(isLoading(createLoadingState())).toBe(true);
  });

  it("should return false for all other states", () => {
    expect(isLoading(createUnauthenticatedState())).toBe(false);
    expect(isLoading(createOnboardingState())).toBe(false);
    expect(isLoading(createReadyState())).toBe(false);
    expect(isLoading(createErrorState())).toBe(false);
  });
});

// =============================================================================
// isError TESTS
// =============================================================================

describe("isError", () => {
  it("should return true for error state", () => {
    expect(isError(createErrorState())).toBe(true);
  });

  it("should return false for all other states", () => {
    expect(isError(createLoadingState())).toBe(false);
    expect(isError(createUnauthenticatedState())).toBe(false);
    expect(isError(createOnboardingState())).toBe(false);
    expect(isError(createReadyState())).toBe(false);
  });
});

// =============================================================================
// isAuthenticated TESTS
// =============================================================================

describe("isAuthenticated", () => {
  it("should return true for onboarding state", () => {
    expect(isAuthenticated(createOnboardingState())).toBe(true);
  });

  it("should return true for ready state", () => {
    expect(isAuthenticated(createReadyState())).toBe(true);
  });

  it("should return false for loading state", () => {
    expect(isAuthenticated(createLoadingState())).toBe(false);
  });

  it("should return false for unauthenticated state", () => {
    expect(isAuthenticated(createUnauthenticatedState())).toBe(false);
  });

  it("should return false for error state", () => {
    expect(isAuthenticated(createErrorState())).toBe(false);
  });
});

// =============================================================================
// isUnauthenticated TESTS
// =============================================================================

describe("isUnauthenticated", () => {
  it("should return true for unauthenticated state", () => {
    expect(isUnauthenticated(createUnauthenticatedState())).toBe(true);
  });

  it("should return false for all other states", () => {
    expect(isUnauthenticated(createLoadingState())).toBe(false);
    expect(isUnauthenticated(createOnboardingState())).toBe(false);
    expect(isUnauthenticated(createReadyState())).toBe(false);
    expect(isUnauthenticated(createErrorState())).toBe(false);
  });
});

// =============================================================================
// needsNavigation TESTS
// =============================================================================

describe("needsNavigation", () => {
  it("should return true when screens are different", () => {
    expect(needsNavigation("loading", "login")).toBe(true);
    expect(needsNavigation("login", "onboarding")).toBe(true);
    expect(needsNavigation("onboarding", "dashboard")).toBe(true);
    expect(needsNavigation("dashboard", "error")).toBe(true);
  });

  it("should return false when screens are the same", () => {
    expect(needsNavigation("loading", "loading")).toBe(false);
    expect(needsNavigation("login", "login")).toBe(false);
    expect(needsNavigation("onboarding", "onboarding")).toBe(false);
    expect(needsNavigation("dashboard", "dashboard")).toBe(false);
    expect(needsNavigation("error", "error")).toBe(false);
  });
});

// =============================================================================
// deriveAppStep TESTS (TASK-2278)
// =============================================================================

describe("deriveAppStep", () => {
  it("should return 'loading' for loading state", () => {
    expect(deriveAppStep(createLoadingState())).toBe("loading");
  });

  it("should return 'login' for unauthenticated state", () => {
    expect(deriveAppStep(createUnauthenticatedState())).toBe("login");
  });

  it("should return 'dashboard' for ready state", () => {
    expect(deriveAppStep(createReadyState())).toBe("dashboard");
  });

  // TASK-2278: Error state should return 'error', not 'loading'
  it("should return 'error' for error state (not 'loading')", () => {
    expect(deriveAppStep(createErrorState(true))).toBe("error");
    expect(deriveAppStep(createErrorState(false))).toBe("error");
  });

  it("should return 'phone-type-selection' for onboarding phone-type step", () => {
    expect(deriveAppStep(createOnboardingState())).toBe("phone-type-selection");
  });
});
