/**
 * Step Derivation Tests
 *
 * Unit tests for step derivation pure functions.
 * Tests cover all state types, platform combinations, and edge cases.
 */

import {
  deriveCurrentStep,
  deriveNextStep,
  deriveFirstStep,
  shouldSkipStep,
  isStepComplete,
  getTotalSteps,
  getCurrentStepNumber,
  isLastStep,
  STEP_ORDER,
} from "../stepDerivation";
import type {
  AppState,
  LoadingState,
  UnauthenticatedState,
  OnboardingState,
  ReadyState,
  ErrorState,
  PlatformInfo,
  OnboardingStep,
} from "../../types";

// =============================================================================
// TEST FIXTURES
// =============================================================================

const createMacOSPlatform = (): PlatformInfo => ({
  isMacOS: true,
  isWindows: false,
  hasIPhone: false,
});

const createWindowsPlatform = (): PlatformInfo => ({
  isMacOS: false,
  isWindows: true,
  hasIPhone: false,
});

const createLoadingState = (): LoadingState => ({
  status: "loading",
  phase: "checking-storage",
});

const createUnauthenticatedState = (): UnauthenticatedState => ({
  status: "unauthenticated",
});

const createOnboardingState = (
  step: OnboardingStep,
  platform: PlatformInfo = createMacOSPlatform(),
  completedSteps: OnboardingStep[] = []
): OnboardingState => ({
  status: "onboarding",
  step,
  user: { id: "user-1", email: "test@example.com" },
  platform,
  completedSteps,
});

const createReadyState = (
  platform: PlatformInfo = createMacOSPlatform()
): ReadyState => ({
  status: "ready",
  user: { id: "user-1", email: "test@example.com" },
  platform,
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: false,
    fda: "granted",
  },
});

const createErrorState = (): ErrorState => ({
  status: "error",
  error: { code: "UNKNOWN_ERROR", message: "Test error" },
  recoverable: true,
});

// =============================================================================
// STEP_ORDER TESTS
// =============================================================================

describe("STEP_ORDER", () => {
  it("should contain all expected steps", () => {
    expect(STEP_ORDER).toEqual([
      "phone-type",
      "secure-storage",
      "account-verification",
      "contact-source",
      "email-connect",
      "data-sync",
      "permissions",
      "apple-driver",
      "android-coming-soon",
    ]);
  });

  it("should start with phone-type", () => {
    expect(STEP_ORDER[0]).toBe("phone-type");
  });
});

// =============================================================================
// deriveCurrentStep TESTS
// =============================================================================

describe("deriveCurrentStep", () => {
  it("should return step when in onboarding state", () => {
    const state = createOnboardingState("phone-type");
    expect(deriveCurrentStep(state)).toBe("phone-type");
  });

  it("should return different steps correctly", () => {
    expect(deriveCurrentStep(createOnboardingState("email-connect"))).toBe(
      "email-connect"
    );
    expect(deriveCurrentStep(createOnboardingState("permissions"))).toBe(
      "permissions"
    );
    expect(deriveCurrentStep(createOnboardingState("apple-driver"))).toBe(
      "apple-driver"
    );
  });

  it("should return null for loading state", () => {
    expect(deriveCurrentStep(createLoadingState())).toBeNull();
  });

  it("should return null for unauthenticated state", () => {
    expect(deriveCurrentStep(createUnauthenticatedState())).toBeNull();
  });

  it("should return null for ready state", () => {
    expect(deriveCurrentStep(createReadyState())).toBeNull();
  });

  it("should return null for error state", () => {
    expect(deriveCurrentStep(createErrorState())).toBeNull();
  });
});

// =============================================================================
// shouldSkipStep TESTS
// =============================================================================

describe("shouldSkipStep", () => {
  describe("phone-type step", () => {
    it("should never be skipped on macOS", () => {
      expect(shouldSkipStep("phone-type", createMacOSPlatform(), null)).toBe(
        false
      );
    });

    it("should never be skipped on Windows", () => {
      expect(shouldSkipStep("phone-type", createWindowsPlatform(), null)).toBe(
        false
      );
    });
  });

  describe("secure-storage step", () => {
    it("should not be skipped on macOS", () => {
      expect(
        shouldSkipStep("secure-storage", createMacOSPlatform(), "iphone")
      ).toBe(false);
    });

    it("should be skipped on Windows", () => {
      expect(
        shouldSkipStep("secure-storage", createWindowsPlatform(), "iphone")
      ).toBe(true);
    });
  });

  describe("email-connect step", () => {
    it("should never be skipped on macOS", () => {
      expect(
        shouldSkipStep("email-connect", createMacOSPlatform(), "iphone")
      ).toBe(false);
    });

    it("should never be skipped on Windows", () => {
      expect(
        shouldSkipStep("email-connect", createWindowsPlatform(), "iphone")
      ).toBe(false);
    });
  });

  describe("permissions step", () => {
    it("should not be skipped on macOS", () => {
      expect(
        shouldSkipStep("permissions", createMacOSPlatform(), "iphone")
      ).toBe(false);
    });

    it("should be skipped on Windows", () => {
      expect(
        shouldSkipStep("permissions", createWindowsPlatform(), "iphone")
      ).toBe(true);
    });
  });

  describe("apple-driver step", () => {
    it("should be skipped on macOS", () => {
      expect(
        shouldSkipStep("apple-driver", createMacOSPlatform(), "iphone")
      ).toBe(true);
    });

    it("should not be skipped on Windows with iPhone", () => {
      expect(
        shouldSkipStep("apple-driver", createWindowsPlatform(), "iphone")
      ).toBe(false);
    });

    it("should be skipped on Windows with Android", () => {
      expect(
        shouldSkipStep("apple-driver", createWindowsPlatform(), "android")
      ).toBe(true);
    });

    it("should be skipped on Windows with null phone type", () => {
      expect(
        shouldSkipStep("apple-driver", createWindowsPlatform(), null)
      ).toBe(true);
    });
  });

  describe("account-verification step", () => {
    it("should never be skipped on macOS", () => {
      expect(shouldSkipStep("account-verification", createMacOSPlatform(), "iphone")).toBe(
        false
      );
    });

    it("should never be skipped on Windows", () => {
      expect(shouldSkipStep("account-verification", createWindowsPlatform(), "iphone")).toBe(
        false
      );
    });
  });

  describe("contact-source step", () => {
    it("should never be skipped on macOS", () => {
      expect(shouldSkipStep("contact-source", createMacOSPlatform(), "iphone")).toBe(
        false
      );
    });

    it("should never be skipped on Windows", () => {
      expect(shouldSkipStep("contact-source", createWindowsPlatform(), "iphone")).toBe(
        false
      );
    });
  });

  describe("data-sync step", () => {
    it("should never be skipped on macOS", () => {
      expect(shouldSkipStep("data-sync", createMacOSPlatform(), "iphone")).toBe(
        false
      );
    });

    it("should never be skipped on Windows", () => {
      expect(shouldSkipStep("data-sync", createWindowsPlatform(), "iphone")).toBe(
        false
      );
    });
  });

  describe("android-coming-soon step", () => {
    it("should be skipped when phone type is iphone", () => {
      expect(
        shouldSkipStep("android-coming-soon", createMacOSPlatform(), "iphone")
      ).toBe(true);
    });

    it("should not be skipped when phone type is android", () => {
      expect(
        shouldSkipStep("android-coming-soon", createMacOSPlatform(), "android")
      ).toBe(false);
    });

    it("should be skipped when phone type is null", () => {
      expect(
        shouldSkipStep("android-coming-soon", createWindowsPlatform(), null)
      ).toBe(true);
    });
  });
});

// =============================================================================
// deriveNextStep TESTS
// =============================================================================

describe("deriveNextStep", () => {
  describe("macOS with iPhone", () => {
    const platform = createMacOSPlatform();
    const phoneType = "iphone" as const;

    it("should go from phone-type to secure-storage", () => {
      expect(deriveNextStep("phone-type", platform, phoneType)).toBe(
        "secure-storage"
      );
    });

    it("should go from secure-storage to account-verification", () => {
      expect(deriveNextStep("secure-storage", platform, phoneType)).toBe(
        "account-verification"
      );
    });

    it("should go from account-verification to contact-source", () => {
      expect(deriveNextStep("account-verification", platform, phoneType)).toBe(
        "contact-source"
      );
    });

    it("should go from contact-source to email-connect", () => {
      expect(deriveNextStep("contact-source", platform, phoneType)).toBe(
        "email-connect"
      );
    });

    it("should go from email-connect to data-sync", () => {
      expect(deriveNextStep("email-connect", platform, phoneType)).toBe(
        "data-sync"
      );
    });

    it("should go from data-sync to permissions", () => {
      expect(deriveNextStep("data-sync", platform, phoneType)).toBe(
        "permissions"
      );
    });

    it("should return null after permissions (last step)", () => {
      expect(deriveNextStep("permissions", platform, phoneType)).toBeNull();
    });
  });

  describe("macOS with Android", () => {
    const platform = createMacOSPlatform();
    const phoneType = "android" as const;

    it("should go from phone-type to secure-storage", () => {
      expect(deriveNextStep("phone-type", platform, phoneType)).toBe(
        "secure-storage"
      );
    });

    it("should eventually reach android-coming-soon", () => {
      // After permissions (which is not skipped on macOS)
      expect(deriveNextStep("permissions", platform, phoneType)).toBe(
        "android-coming-soon"
      );
    });

    it("should return null after android-coming-soon", () => {
      expect(
        deriveNextStep("android-coming-soon", platform, phoneType)
      ).toBeNull();
    });
  });

  describe("Windows with iPhone", () => {
    const platform = createWindowsPlatform();
    const phoneType = "iphone" as const;

    it("should skip secure-storage and go from phone-type to account-verification", () => {
      expect(deriveNextStep("phone-type", platform, phoneType)).toBe(
        "account-verification"
      );
    });

    it("should go from account-verification to contact-source", () => {
      expect(deriveNextStep("account-verification", platform, phoneType)).toBe(
        "contact-source"
      );
    });

    it("should go from contact-source to email-connect", () => {
      expect(deriveNextStep("contact-source", platform, phoneType)).toBe(
        "email-connect"
      );
    });

    it("should go from email-connect to data-sync", () => {
      expect(deriveNextStep("email-connect", platform, phoneType)).toBe(
        "data-sync"
      );
    });

    it("should skip permissions and go from data-sync to apple-driver", () => {
      expect(deriveNextStep("data-sync", platform, phoneType)).toBe(
        "apple-driver"
      );
    });

    it("should return null after apple-driver (last step for Windows+iPhone)", () => {
      expect(deriveNextStep("apple-driver", platform, phoneType)).toBeNull();
    });
  });

  describe("Windows with Android", () => {
    const platform = createWindowsPlatform();
    const phoneType = "android" as const;

    it("should go from phone-type to account-verification", () => {
      expect(deriveNextStep("phone-type", platform, phoneType)).toBe(
        "account-verification"
      );
    });

    it("should skip apple-driver and go from data-sync to android-coming-soon", () => {
      expect(deriveNextStep("data-sync", platform, phoneType)).toBe(
        "android-coming-soon"
      );
    });

    it("should return null after android-coming-soon", () => {
      expect(
        deriveNextStep("android-coming-soon", platform, phoneType)
      ).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("should return null for invalid step", () => {
      // Force an invalid step (TypeScript would normally prevent this)
      const invalidStep = "invalid-step" as OnboardingStep;
      expect(
        deriveNextStep(invalidStep, createMacOSPlatform(), "iphone")
      ).toBeNull();
    });

    it("should handle null phone type", () => {
      // phone-type step before phone is selected
      expect(
        deriveNextStep("phone-type", createMacOSPlatform(), null)
      ).toBe("secure-storage");
    });
  });
});

// =============================================================================
// deriveFirstStep TESTS
// =============================================================================

describe("deriveFirstStep", () => {
  it("should always return phone-type for macOS", () => {
    expect(deriveFirstStep(createMacOSPlatform())).toBe("phone-type");
  });

  it("should always return phone-type for Windows", () => {
    expect(deriveFirstStep(createWindowsPlatform())).toBe("phone-type");
  });
});

// =============================================================================
// isStepComplete TESTS
// =============================================================================

describe("isStepComplete", () => {
  describe("ready state", () => {
    it("should return true for all steps", () => {
      const state = createReadyState();
      expect(isStepComplete("phone-type", state)).toBe(true);
      expect(isStepComplete("secure-storage", state)).toBe(true);
      expect(isStepComplete("email-connect", state)).toBe(true);
      expect(isStepComplete("permissions", state)).toBe(true);
      expect(isStepComplete("apple-driver", state)).toBe(true);
      expect(isStepComplete("android-coming-soon", state)).toBe(true);
    });
  });

  describe("loading state", () => {
    it("should return false for all steps", () => {
      const state = createLoadingState();
      expect(isStepComplete("phone-type", state)).toBe(false);
      expect(isStepComplete("email-connect", state)).toBe(false);
    });
  });

  describe("error state", () => {
    it("should return false for all steps", () => {
      const state = createErrorState();
      expect(isStepComplete("phone-type", state)).toBe(false);
    });
  });

  describe("onboarding state", () => {
    it("should return true for steps before current step", () => {
      const state = createOnboardingState("email-connect");
      expect(isStepComplete("phone-type", state)).toBe(true);
      expect(isStepComplete("secure-storage", state)).toBe(true);
    });

    it("should return false for current step", () => {
      const state = createOnboardingState("email-connect");
      expect(isStepComplete("email-connect", state)).toBe(false);
    });

    it("should return false for steps after current step", () => {
      const state = createOnboardingState("email-connect");
      expect(isStepComplete("permissions", state)).toBe(false);
      expect(isStepComplete("apple-driver", state)).toBe(false);
    });

    it("should return true for steps in completedSteps array", () => {
      const state = createOnboardingState("permissions", createMacOSPlatform(), [
        "phone-type",
        "secure-storage",
        "email-connect",
      ]);
      expect(isStepComplete("phone-type", state)).toBe(true);
      expect(isStepComplete("secure-storage", state)).toBe(true);
      expect(isStepComplete("email-connect", state)).toBe(true);
    });
  });
});

// =============================================================================
// getTotalSteps TESTS
// =============================================================================

describe("getTotalSteps", () => {
  describe("macOS with iPhone", () => {
    it("should return 7 steps", () => {
      // phone-type, secure-storage, account-verification, contact-source, email-connect, data-sync, permissions
      expect(getTotalSteps(createMacOSPlatform(), "iphone")).toBe(7);
    });
  });

  describe("macOS with Android", () => {
    it("should return 8 steps", () => {
      // phone-type, secure-storage, account-verification, contact-source, email-connect, data-sync, permissions, android-coming-soon
      expect(getTotalSteps(createMacOSPlatform(), "android")).toBe(8);
    });
  });

  describe("Windows with iPhone", () => {
    it("should return 6 steps", () => {
      // phone-type, account-verification, contact-source, email-connect, data-sync, apple-driver
      expect(getTotalSteps(createWindowsPlatform(), "iphone")).toBe(6);
    });
  });

  describe("Windows with Android", () => {
    it("should return 6 steps", () => {
      // phone-type, account-verification, contact-source, email-connect, data-sync, android-coming-soon
      expect(getTotalSteps(createWindowsPlatform(), "android")).toBe(6);
    });
  });

  describe("null phone type", () => {
    it("should return 7 for macOS (no android-coming-soon, no apple-driver)", () => {
      // phone-type, secure-storage, account-verification, contact-source, email-connect, data-sync, permissions
      expect(getTotalSteps(createMacOSPlatform(), null)).toBe(7);
    });

    it("should return 5 for Windows (no platform-specific steps)", () => {
      // phone-type, account-verification, contact-source, email-connect, data-sync
      expect(getTotalSteps(createWindowsPlatform(), null)).toBe(5);
    });
  });
});

// =============================================================================
// getCurrentStepNumber TESTS
// =============================================================================

describe("getCurrentStepNumber", () => {
  describe("macOS with iPhone", () => {
    const platform = createMacOSPlatform();
    const phoneType = "iphone" as const;

    it("should return 1 for phone-type", () => {
      expect(getCurrentStepNumber("phone-type", platform, phoneType)).toBe(1);
    });

    it("should return 2 for secure-storage", () => {
      expect(getCurrentStepNumber("secure-storage", platform, phoneType)).toBe(
        2
      );
    });

    it("should return 3 for account-verification", () => {
      expect(getCurrentStepNumber("account-verification", platform, phoneType)).toBe(
        3
      );
    });

    it("should return 5 for email-connect", () => {
      expect(getCurrentStepNumber("email-connect", platform, phoneType)).toBe(
        5
      );
    });

    it("should return 7 for permissions", () => {
      expect(getCurrentStepNumber("permissions", platform, phoneType)).toBe(7);
    });
  });

  describe("Windows with iPhone", () => {
    const platform = createWindowsPlatform();
    const phoneType = "iphone" as const;

    it("should return 1 for phone-type", () => {
      expect(getCurrentStepNumber("phone-type", platform, phoneType)).toBe(1);
    });

    it("should return 2 for account-verification", () => {
      expect(getCurrentStepNumber("account-verification", platform, phoneType)).toBe(
        2
      );
    });

    it("should return 4 for email-connect (secure-storage skipped)", () => {
      expect(getCurrentStepNumber("email-connect", platform, phoneType)).toBe(
        4
      );
    });

    it("should return 6 for apple-driver", () => {
      expect(getCurrentStepNumber("apple-driver", platform, phoneType)).toBe(6);
    });

    it("should return 0 for secure-storage (skipped step)", () => {
      expect(getCurrentStepNumber("secure-storage", platform, phoneType)).toBe(
        0
      );
    });
  });
});

// =============================================================================
// isLastStep TESTS
// =============================================================================

describe("isLastStep", () => {
  describe("macOS with iPhone", () => {
    const platform = createMacOSPlatform();
    const phoneType = "iphone" as const;

    it("should return false for phone-type", () => {
      expect(isLastStep("phone-type", platform, phoneType)).toBe(false);
    });

    it("should return false for email-connect", () => {
      expect(isLastStep("email-connect", platform, phoneType)).toBe(false);
    });

    it("should return true for permissions", () => {
      expect(isLastStep("permissions", platform, phoneType)).toBe(true);
    });
  });

  describe("Windows with iPhone", () => {
    const platform = createWindowsPlatform();
    const phoneType = "iphone" as const;

    it("should return true for apple-driver", () => {
      expect(isLastStep("apple-driver", platform, phoneType)).toBe(true);
    });
  });

  describe("with Android", () => {
    it("should return true for android-coming-soon on macOS", () => {
      expect(
        isLastStep("android-coming-soon", createMacOSPlatform(), "android")
      ).toBe(true);
    });

    it("should return true for android-coming-soon on Windows", () => {
      expect(
        isLastStep("android-coming-soon", createWindowsPlatform(), "android")
      ).toBe(true);
    });
  });
});
