/**
 * State Machine Reducer Tests
 *
 * Comprehensive tests for the app state machine reducer.
 * Tests all state transitions, edge cases, and error recovery.
 *
 * @module appCore/state/machine/reducer.test
 */

import { appStateReducer, getNextOnboardingStep } from "./reducer";
import { INITIAL_APP_STATE } from "./types";
import type {
  AppState,
  AppAction,
  LoadingState,
  OnboardingState,
  ReadyState,
  ErrorState,
  OnboardingStep,
  PlatformInfo,
  User,
  UserData,
} from "./types";

// ============================================
// TEST FIXTURES
// ============================================

const mockUser: User = {
  id: "user-123",
  email: "test@example.com",
  displayName: "Test User",
};

const mockMacOSPlatform: PlatformInfo = {
  isMacOS: true,
  isWindows: false,
  hasIPhone: true,
};

const mockWindowsPlatform: PlatformInfo = {
  isMacOS: false,
  isWindows: true,
  hasIPhone: true,
};

const mockWindowsAndroidPlatform: PlatformInfo = {
  isMacOS: false,
  isWindows: true,
  hasIPhone: false,
};

const mockCompleteUserData: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  hasPermissions: true,
};

const mockIncompleteUserData: UserData = {
  phoneType: null,
  hasCompletedEmailOnboarding: false,
  hasEmailConnected: false,
  needsDriverSetup: true,
  hasPermissions: false,
};

// ============================================
// getNextOnboardingStep TESTS
// ============================================

describe("getNextOnboardingStep", () => {
  describe("macOS platform", () => {
    it("returns phone-type as first step for new user", () => {
      const result = getNextOnboardingStep([], mockMacOSPlatform, mockIncompleteUserData);
      expect(result).toBe("phone-type");
    });

    it("returns secure-storage after phone-type on macOS", () => {
      const result = getNextOnboardingStep(
        ["phone-type"],
        mockMacOSPlatform,
        mockIncompleteUserData
      );
      expect(result).toBe("secure-storage");
    });

    it("returns email-connect after secure-storage", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "secure-storage"],
        mockMacOSPlatform,
        mockIncompleteUserData
      );
      expect(result).toBe("email-connect");
    });

    it("returns permissions after email-connect if not granted", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "secure-storage", "email-connect"],
        mockMacOSPlatform,
        { ...mockIncompleteUserData, hasPermissions: false }
      );
      expect(result).toBe("permissions");
    });

    it("returns null when all macOS steps complete", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "secure-storage", "email-connect", "permissions"],
        mockMacOSPlatform,
        { ...mockIncompleteUserData, hasPermissions: true }
      );
      expect(result).toBeNull();
    });

    it("skips permissions if already granted", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "secure-storage", "email-connect"],
        mockMacOSPlatform,
        { ...mockIncompleteUserData, hasPermissions: true }
      );
      expect(result).toBeNull();
    });
  });

  describe("Windows + iPhone platform", () => {
    it("returns phone-type as first step", () => {
      const result = getNextOnboardingStep([], mockWindowsPlatform, mockIncompleteUserData);
      expect(result).toBe("phone-type");
    });

    it("skips secure-storage on Windows", () => {
      const result = getNextOnboardingStep(
        ["phone-type"],
        mockWindowsPlatform,
        mockIncompleteUserData
      );
      expect(result).toBe("email-connect");
    });

    it("returns apple-driver after email-connect if needed", () => {
      // Must include phoneType: "iphone" because getNextOnboardingStep now
      // checks userData.phoneType instead of platform.hasIPhone (TASK-1180 fix)
      const result = getNextOnboardingStep(
        ["phone-type", "email-connect"],
        mockWindowsPlatform,
        { ...mockIncompleteUserData, phoneType: "iphone", needsDriverSetup: true }
      );
      expect(result).toBe("apple-driver");
    });

    it("skips apple-driver if not needed", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "email-connect"],
        mockWindowsPlatform,
        { ...mockIncompleteUserData, needsDriverSetup: false }
      );
      expect(result).toBeNull();
    });

    it("returns null when all Windows+iPhone steps complete", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "email-connect", "apple-driver"],
        mockWindowsPlatform,
        { ...mockIncompleteUserData, needsDriverSetup: false }
      );
      expect(result).toBeNull();
    });
  });

  describe("Windows + Android platform", () => {
    it("skips apple-driver for Android users", () => {
      const result = getNextOnboardingStep(
        ["phone-type", "email-connect"],
        mockWindowsAndroidPlatform,
        mockIncompleteUserData
      );
      expect(result).toBeNull();
    });
  });
});

// ============================================
// LOADING PHASE TRANSITIONS
// ============================================

describe("appStateReducer - Loading Phase Transitions", () => {
  describe("STORAGE_CHECKED", () => {
    it("transitions from checking-storage to validating-auth when hasKeyStore is true (TASK-2086)", () => {
      const state = INITIAL_APP_STATE;
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "validating-auth",
      });
    });

    it("transitions to validating-auth when hasKeyStore is false on Windows (TASK-2086)", () => {
      const state = INITIAL_APP_STATE;
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: false, isMacOS: false };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "validating-auth",
      });
    });

    it("defers DB init for first-time macOS users (no key store + isMacOS)", () => {
      const state = INITIAL_APP_STATE;
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: false, isMacOS: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "loading-auth",
        deferredDbInit: true,
      });
    });

    it("transitions to validating-auth for returning macOS users (has key store) (TASK-2086)", () => {
      const state = INITIAL_APP_STATE;
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: true, isMacOS: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "validating-auth",
      });
    });

    it("returns current state if not in checking-storage phase", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("returns current state if not in loading status", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  // ============================================
  // TASK-2086: AUTH_PRE_VALIDATED transitions
  // ============================================

  describe("AUTH_PRE_VALIDATED (TASK-2086)", () => {
    it("transitions from validating-auth to initializing-db when valid is true", () => {
      const state: LoadingState = { status: "loading", phase: "validating-auth" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "initializing-db",
      });
    });

    it("transitions from validating-auth to initializing-db when noSession is true", () => {
      const state: LoadingState = { status: "loading", phase: "validating-auth" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: true, noSession: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "initializing-db",
      });
    });

    it("transitions to unauthenticated when valid is false", () => {
      const state: LoadingState = { status: "loading", phase: "validating-auth" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: false, reason: "session_revoked" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("unauthenticated");
    });

    it("transitions to unauthenticated with default reason when reason is omitted", () => {
      const state: LoadingState = { status: "loading", phase: "validating-auth" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: false };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("unauthenticated");
    });

    it("returns current state if not in validating-auth phase", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("returns current state if not in loading status", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "AUTH_PRE_VALIDATED", valid: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("DB_INIT_STARTED", () => {
    it("sets progress to 0 in initializing-db phase", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = { type: "DB_INIT_STARTED" };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "initializing-db",
        progress: 0,
      });
    });

    it("returns current state if not in initializing-db phase", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action: AppAction = { type: "DB_INIT_STARTED" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("DB_INIT_COMPLETE", () => {
    it("transitions to loading-auth on success", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "loading-auth",
      });
    });

    it("transitions to error state on failure", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = {
        type: "DB_INIT_COMPLETE",
        success: false,
        error: "Keychain access denied",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("DB_INIT_FAILED");
        expect(result.error.message).toBe("Keychain access denied");
        expect(result.recoverable).toBe(true);
        expect(result.previousState).toEqual(state);
      }
    });

    it("uses default error message when none provided", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = { type: "DB_INIT_COMPLETE", success: false };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toBe("Failed to initialize database");
      }
    });

    it("returns current state if not in initializing-db phase", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("clears deferredDbInit during onboarding on success", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "secure-storage",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type"],
        deferredDbInit: true,
      };
      const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.deferredDbInit).toBe(false);
      }
    });

    it("transitions to error during onboarding on failure", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "secure-storage",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type"],
        deferredDbInit: true,
      };
      const action: AppAction = {
        type: "DB_INIT_COMPLETE",
        success: false,
        error: "Keychain access denied",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("DB_INIT_FAILED");
        expect(result.recoverable).toBe(true);
      }
    });

    it("ignores during onboarding if deferredDbInit is not set", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "secure-storage",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type"],
        // deferredDbInit not set
      };
      const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("AUTH_LOADED", () => {
    it("transitions to unauthenticated when no user", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: null,
        isNewUser: false,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("unauthenticated");
    });

    it("preserves deferredDbInit when transitioning to unauthenticated", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-auth",
        deferredDbInit: true,
      };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: null,
        isNewUser: false,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("unauthenticated");
      if (result.status === "unauthenticated") {
        expect(result.deferredDbInit).toBe(true);
      }
    });

    it("transitions new user directly to onboarding", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: mockUser,
        isNewUser: true,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.step).toBe("phone-type");
        expect(result.completedSteps).toEqual([]);
      }
    });

    it("preserves deferredDbInit when transitioning new user to onboarding", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-auth",
        deferredDbInit: true,
      };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: mockUser,
        isNewUser: true,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.deferredDbInit).toBe(true);
      }
    });

    it("transitions returning user to loading-user-data", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: mockUser,
        isNewUser: false,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result).toEqual({
        status: "loading",
        phase: "loading-user-data",
      });
    });

    it("returns current state if not in loading-auth phase", () => {
      const state: LoadingState = { status: "loading", phase: "checking-storage" };
      const action: AppAction = {
        type: "AUTH_LOADED",
        user: mockUser,
        isNewUser: false,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("USER_DATA_LOADED", () => {
    it("transitions to ready state when onboarding complete", () => {
      const state: LoadingState = { status: "loading", phase: "loading-user-data" };
      // Extended action with user and platform context
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockCompleteUserData,
        user: mockUser,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.userData).toEqual(mockCompleteUserData);
      }
    });

    it("transitions to onboarding when onboarding incomplete", () => {
      const state: LoadingState = { status: "loading", phase: "loading-user-data" };
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockIncompleteUserData,
        user: mockUser,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.step).toBe("phone-type");
      }
    });

    it("correctly determines completed steps from userData", () => {
      const state: LoadingState = { status: "loading", phase: "loading-user-data" };
      const partialUserData: UserData = {
        phoneType: "iphone",
        hasCompletedEmailOnboarding: true,
        hasEmailConnected: false,
        needsDriverSetup: false,
        hasPermissions: false, // Still needs permissions on macOS
      };
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: partialUserData,
        user: mockUser,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.completedSteps).toContain("phone-type");
        expect(result.completedSteps).toContain("email-connect");
        expect(result.step).toBe("secure-storage"); // Next step after phone-type on macOS
      }
    });

    it("transitions to error when user context missing", () => {
      const state: LoadingState = { status: "loading", phase: "loading-user-data" };
      // Missing user and platform - simulating incorrect orchestrator usage
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockCompleteUserData,
        user: undefined as unknown as User,
        platform: undefined as unknown as PlatformInfo,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("USER_DATA_FAILED");
        expect(result.recoverable).toBe(true);
      }
    });

    it("returns current state if not in loading-user-data phase", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockCompleteUserData,
        user: mockUser,
        platform: mockMacOSPlatform,
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });
});

// ============================================
// LOGIN_SUCCESS TRANSITIONS
// ============================================

describe("appStateReducer - LOGIN_SUCCESS Transitions", () => {
  describe("LOGIN_SUCCESS from unauthenticated", () => {
    it("transitions new user directly to onboarding", () => {
      const state: AppState = { status: "unauthenticated" };
      const action = {
        type: "LOGIN_SUCCESS" as const,
        user: mockUser,
        platform: mockMacOSPlatform,
        isNewUser: true,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.step).toBe("phone-type");
        expect(result.completedSteps).toEqual([]);
      }
    });

    it("transitions returning user to loading-user-data with user/platform stored in state", () => {
      const state: AppState = { status: "unauthenticated" };
      const action = {
        type: "LOGIN_SUCCESS" as const,
        user: mockUser,
        platform: mockMacOSPlatform,
        isNewUser: false,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("loading");
      if (result.status === "loading") {
        expect(result.phase).toBe("loading-user-data");
        expect(result.progress).toBe(75); // Skip phases 1-3
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
      }
    });

    it("returns current state if not in unauthenticated status", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action = {
        type: "LOGIN_SUCCESS" as const,
        user: mockUser,
        platform: mockMacOSPlatform,
        isNewUser: false,
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("returns current state if already in loading status", () => {
      const state: LoadingState = { status: "loading", phase: "loading-auth" };
      const action = {
        type: "LOGIN_SUCCESS" as const,
        user: mockUser,
        platform: mockMacOSPlatform,
        isNewUser: false,
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("USER_DATA_LOADED after LOGIN_SUCCESS", () => {
    it("uses user and platform from state (LOGIN_SUCCESS flow) when action has undefined values", () => {
      // After LOGIN_SUCCESS, state has user/platform but action might not
      const state: LoadingState = {
        status: "loading",
        phase: "loading-user-data",
        user: mockUser,
        platform: mockMacOSPlatform,
      };
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockCompleteUserData,
        // user and platform undefined - simulating fresh login flow
        // where LoadingOrchestrator may not have set authDataRef
        user: undefined as unknown as User,
        platform: undefined as unknown as PlatformInfo,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.userData).toEqual(mockCompleteUserData);
      }
    });

    it("transitions to onboarding when user data is incomplete (LOGIN_SUCCESS flow)", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-user-data",
        user: mockUser,
        platform: mockMacOSPlatform,
      };
      const action = {
        type: "USER_DATA_LOADED" as const,
        data: mockIncompleteUserData,
        user: undefined as unknown as User,
        platform: undefined as unknown as PlatformInfo,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.user).toEqual(mockUser);
        expect(result.step).toBe("phone-type");
      }
    });
  });
});

// ============================================
// ONBOARDING TRANSITIONS
// ============================================

describe("appStateReducer - Onboarding Transitions", () => {
  const baseOnboardingState: OnboardingState = {
    status: "onboarding",
    step: "phone-type",
    user: mockUser,
    platform: mockMacOSPlatform,
    completedSteps: [],
  };

  describe("ONBOARDING_STEP_COMPLETE", () => {
    it("advances to next step when step completed", () => {
      const state = baseOnboardingState;
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "phone-type",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.completedSteps).toContain("phone-type");
        expect(result.step).toBe("secure-storage"); // Next step on macOS
      }
    });

    it("transitions to ready when all steps complete", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "permissions",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type", "secure-storage", "email-connect"],
      };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "permissions",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        expect(result.userData.hasPermissions).toBe(true);
      }
    });

    it("does not duplicate step in completedSteps", () => {
      const state: OnboardingState = {
        ...baseOnboardingState,
        completedSteps: ["phone-type"],
      };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "phone-type",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        const phoneTypeCount = result.completedSteps.filter(
          (s) => s === "phone-type"
        ).length;
        expect(phoneTypeCount).toBe(1);
      }
    });

    it("returns current state if not in onboarding status", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "phone-type",
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("correctly handles Windows+iPhone apple-driver completion", () => {
      const windowsState: OnboardingState = {
        status: "onboarding",
        step: "apple-driver",
        user: mockUser,
        platform: mockWindowsPlatform,
        completedSteps: ["phone-type", "email-connect"],
        selectedPhoneType: "iphone", // TASK-1180: must have explicit phone type for apple-driver
      };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "apple-driver",
      };

      const result = appStateReducer(windowsState, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.userData.needsDriverSetup).toBe(false);
      }
    });

    // TASK-1180: Test for phone type selection with explicit phoneType in action
    it("uses phoneType from action when completing phone-type step", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "phone-type",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: [],
      };
      // Explicitly pass phoneType: "android" even though platform.hasIPhone is true
      const action = {
        type: "ONBOARDING_STEP_COMPLETE" as const,
        step: "phone-type" as const,
        phoneType: "android" as const,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.selectedPhoneType).toBe("android");
        expect(result.step).toBe("secure-storage"); // Next step on macOS
      }
    });

    it("preserves selectedPhoneType in state after phone-type step is complete", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "secure-storage",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type"],
        selectedPhoneType: "iphone", // Set from previous phone-type step completion
      };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "secure-storage",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.selectedPhoneType).toBe("iphone"); // Should be preserved
        expect(result.step).toBe("email-connect"); // Next step
      }
    });

    it("uses selectedPhoneType in userData when transitioning to ready", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "permissions",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type", "secure-storage", "email-connect"],
        selectedPhoneType: "android", // Explicitly selected android
      };
      const action: AppAction = {
        type: "ONBOARDING_STEP_COMPLETE",
        step: "permissions",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.userData.phoneType).toBe("android");
      }
    });
  });

  // BACKLOG-1842 (resume-at-step fix round): applied once, early in
  // onboarding, when the cloud resume marker was consumed on this launch
  // (i.e. this process just came up from the FDA-grant relaunch).
  describe("RESUME_MARKER_APPLIED", () => {
    it("seeds selectedPhoneType and marks phone-type complete", () => {
      const state: OnboardingState = {
        ...baseOnboardingState,
        step: "permissions",
        completedSteps: [],
      };
      const action: AppAction = {
        type: "RESUME_MARKER_APPLIED",
        phoneType: "iphone",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.selectedPhoneType).toBe("iphone");
        expect(result.completedSteps).toContain("phone-type");
        // Step position itself is owned by the queue (useOnboardingQueue),
        // not this legacy `step` field — RESUME_MARKER_APPLIED must not
        // clobber it.
        expect(result.step).toBe("permissions");
      }
    });

    it("does not duplicate phone-type in completedSteps if already present", () => {
      const state: OnboardingState = {
        ...baseOnboardingState,
        completedSteps: ["phone-type"],
      };
      const action: AppAction = {
        type: "RESUME_MARKER_APPLIED",
        phoneType: "android",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        const phoneTypeCount = result.completedSteps.filter(
          (s) => s === "phone-type"
        ).length;
        expect(phoneTypeCount).toBe(1);
        // Still updates selectedPhoneType even if completedSteps already had it.
        expect(result.selectedPhoneType).toBe("android");
      }
    });

    it("is a no-op when phoneType is null (nothing to seed)", () => {
      const state = baseOnboardingState;
      const action: AppAction = {
        type: "RESUME_MARKER_APPLIED",
        phoneType: null,
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("returns current state if not in onboarding status", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = {
        type: "RESUME_MARKER_APPLIED",
        phoneType: "iphone",
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("ONBOARDING_SKIP", () => {
    it("treats skip the same as complete", () => {
      const state = baseOnboardingState;
      const action: AppAction = {
        type: "ONBOARDING_SKIP",
        step: "phone-type",
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.completedSteps).toContain("phone-type");
        expect(result.step).toBe("secure-storage");
      }
    });

    it("returns current state if not in onboarding status", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = {
        type: "ONBOARDING_SKIP",
        step: "email-connect",
      };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });
});

// ============================================
// READY STATE TRANSITIONS
// ============================================

describe("appStateReducer - Ready State Transitions", () => {
  describe("APP_READY", () => {
    it("returns same state if already ready", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = { type: "APP_READY" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("does not transition from other states", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "APP_READY" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("START_EMAIL_SETUP", () => {
    it("transitions from ready to onboarding with email-connect step", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = { type: "START_EMAIL_SETUP" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.step).toBe("email-connect");
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockMacOSPlatform);
        // Previous steps should be marked complete
        expect(result.completedSteps).toContain("phone-type");
      }
    });

    it("includes secure-storage in completed steps for macOS", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = { type: "START_EMAIL_SETUP" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.completedSteps).toContain("secure-storage");
      }
    });

    it("does not include secure-storage in completed steps for Windows", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockWindowsPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = { type: "START_EMAIL_SETUP" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.completedSteps).not.toContain("secure-storage");
      }
    });

    it("preserves hasEmailConnected from userData", () => {
      const userDataWithEmail = { ...mockCompleteUserData, hasEmailConnected: true };
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: userDataWithEmail,
      };
      const action: AppAction = { type: "START_EMAIL_SETUP" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.hasEmailConnected).toBe(true);
      }
    });

    it("does not transition from non-ready states", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "START_EMAIL_SETUP" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  describe("EMAIL_CONNECTED", () => {
    it("updates userData.hasEmailConnected when in ready state", () => {
      // User with email not connected (dashboard shows setup banner)
      const userDataNoEmail = { ...mockCompleteUserData, hasEmailConnected: false };
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: userDataNoEmail,
      };
      const action: AppAction = { type: "EMAIL_CONNECTED" };

      const result = appStateReducer(state, action);

      // Should update hasEmailConnected so banner disappears
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.userData.hasEmailConnected).toBe(true);
        // Other userData should be preserved
        expect(result.userData.phoneType).toBe(userDataNoEmail.phoneType);
        expect(result.userData.hasPermissions).toBe(userDataNoEmail.hasPermissions);
      }
    });

    it("preserves other state properties when updating hasEmailConnected", () => {
      const userDataNoEmail = { ...mockCompleteUserData, hasEmailConnected: false };
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockWindowsPlatform,
        userData: userDataNoEmail,
      };
      const action: AppAction = { type: "EMAIL_CONNECTED" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockWindowsPlatform);
      }
    });

    it("updates hasEmailConnected in onboarding state", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "email-connect",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type", "secure-storage"],
      };
      const action: AppAction = { type: "EMAIL_CONNECTED" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("onboarding");
      if (result.status === "onboarding") {
        expect(result.hasEmailConnected).toBe(true);
      }
    });

    it("returns current state for invalid states", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "EMAIL_CONNECTED" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });

  // TASK-1730: Tests for EMAIL_DISCONNECTED action
  describe("EMAIL_DISCONNECTED", () => {
    it("updates userData.hasEmailConnected to false when in ready state", () => {
      // User with email connected (banner hidden)
      const userDataWithEmail = { ...mockCompleteUserData, hasEmailConnected: true };
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: userDataWithEmail,
      };
      const action: AppAction = { type: "EMAIL_DISCONNECTED", provider: "google" };

      const result = appStateReducer(state, action);

      // Should update hasEmailConnected so banner reappears
      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.userData.hasEmailConnected).toBe(false);
        // Other userData should be preserved
        expect(result.userData.phoneType).toBe(userDataWithEmail.phoneType);
        expect(result.userData.hasPermissions).toBe(userDataWithEmail.hasPermissions);
      }
    });

    it("preserves other state properties when updating hasEmailConnected to false", () => {
      const userDataWithEmail = { ...mockCompleteUserData, hasEmailConnected: true };
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockWindowsPlatform,
        userData: userDataWithEmail,
      };
      const action: AppAction = { type: "EMAIL_DISCONNECTED", provider: "microsoft" };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("ready");
      if (result.status === "ready") {
        expect(result.user).toEqual(mockUser);
        expect(result.platform).toEqual(mockWindowsPlatform);
        expect(result.userData.hasEmailConnected).toBe(false);
      }
    });

    it("returns current state for onboarding state (disconnect unexpected)", () => {
      const state: OnboardingState = {
        status: "onboarding",
        step: "email-connect",
        user: mockUser,
        platform: mockMacOSPlatform,
        completedSteps: ["phone-type", "secure-storage"],
        hasEmailConnected: true,
      };
      const action: AppAction = { type: "EMAIL_DISCONNECTED", provider: "google" };

      const result = appStateReducer(state, action);

      // Disconnect during onboarding should be ignored
      expect(result).toBe(state);
    });

    it("returns current state for unauthenticated state", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = { type: "EMAIL_DISCONNECTED", provider: "google" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });
});

// ============================================
// LOGOUT TRANSITIONS
// ============================================

describe("appStateReducer - Logout", () => {
  it("transitions from ready to unauthenticated", () => {
    const state: ReadyState = {
      status: "ready",
      user: mockUser,
      platform: mockMacOSPlatform,
      userData: mockCompleteUserData,
    };
    const action: AppAction = { type: "LOGOUT" };

    const result = appStateReducer(state, action);

    expect(result).toEqual({ status: "unauthenticated" });
  });

  it("transitions from onboarding to unauthenticated", () => {
    const state: OnboardingState = {
      status: "onboarding",
      step: "phone-type",
      user: mockUser,
      platform: mockMacOSPlatform,
      completedSteps: [],
    };
    const action: AppAction = { type: "LOGOUT" };

    const result = appStateReducer(state, action);

    expect(result).toEqual({ status: "unauthenticated" });
  });

  it("transitions from loading to unauthenticated", () => {
    const state: LoadingState = { status: "loading", phase: "initializing-db" };
    const action: AppAction = { type: "LOGOUT" };

    const result = appStateReducer(state, action);

    expect(result).toEqual({ status: "unauthenticated" });
  });

  it("transitions from error to unauthenticated", () => {
    const state: ErrorState = {
      status: "error",
      error: { code: "UNKNOWN_ERROR", message: "test" },
      recoverable: false,
    };
    const action: AppAction = { type: "LOGOUT" };

    const result = appStateReducer(state, action);

    expect(result).toEqual({ status: "unauthenticated" });
  });
});

// ============================================
// ERROR HANDLING
// ============================================

describe("appStateReducer - Error Handling", () => {
  describe("ERROR", () => {
    it("transitions any state to error", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = {
        type: "ERROR",
        error: { code: "NETWORK_ERROR", message: "Connection lost" },
        recoverable: true,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("NETWORK_ERROR");
        expect(result.error.message).toBe("Connection lost");
        expect(result.recoverable).toBe(true);
        expect(result.previousState).toEqual(state);
      }
    });

    it("defaults recoverable to false", () => {
      const state: AppState = { status: "unauthenticated" };
      const action: AppAction = {
        type: "ERROR",
        error: { code: "UNKNOWN_ERROR", message: "Something went wrong" },
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.recoverable).toBe(false);
      }
    });

    it("preserves previous state for recovery", () => {
      const state: LoadingState = { status: "loading", phase: "initializing-db" };
      const action: AppAction = {
        type: "ERROR",
        error: { code: "DB_INIT_FAILED", message: "Test error" },
        recoverable: true,
      };

      const result = appStateReducer(state, action);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.previousState).toEqual(state);
      }
    });
  });

  describe("RETRY", () => {
    it("returns to previous state if recoverable", () => {
      const previousState: LoadingState = {
        status: "loading",
        phase: "initializing-db",
      };
      const state: ErrorState = {
        status: "error",
        error: { code: "DB_INIT_FAILED", message: "Test error" },
        recoverable: true,
        previousState,
      };
      const action: AppAction = { type: "RETRY" };

      const result = appStateReducer(state, action);

      expect(result).toEqual(previousState);
    });

    it("returns to INITIAL_APP_STATE if no previous state", () => {
      const state: ErrorState = {
        status: "error",
        error: { code: "UNKNOWN_ERROR", message: "Test error" },
        recoverable: true,
      };
      const action: AppAction = { type: "RETRY" };

      const result = appStateReducer(state, action);

      expect(result).toEqual(INITIAL_APP_STATE);
    });

    it("returns current state if not recoverable", () => {
      const state: ErrorState = {
        status: "error",
        error: { code: "UNKNOWN_ERROR", message: "Fatal error" },
        recoverable: false,
      };
      const action: AppAction = { type: "RETRY" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });

    it("returns current state if not in error status", () => {
      const state: ReadyState = {
        status: "ready",
        user: mockUser,
        platform: mockMacOSPlatform,
        userData: mockCompleteUserData,
      };
      const action: AppAction = { type: "RETRY" };

      const result = appStateReducer(state, action);

      expect(result).toBe(state);
    });
  });
});

// ============================================
// INVALID TRANSITIONS
// ============================================

describe("appStateReducer - Invalid Transitions", () => {
  it("returns current state for action in wrong status", () => {
    const state: AppState = { status: "unauthenticated" };
    const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

    const result = appStateReducer(state, action);

    expect(result).toBe(state);
  });

  it("returns current state for action in wrong phase", () => {
    const state: LoadingState = { status: "loading", phase: "checking-storage" };
    const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

    const result = appStateReducer(state, action);

    expect(result).toBe(state);
  });

  it("handles double-dispatch of same action", () => {
    const state = INITIAL_APP_STATE;
    const action: AppAction = { type: "STORAGE_CHECKED", hasKeyStore: true };

    const firstResult = appStateReducer(state, action);
    const secondResult = appStateReducer(firstResult, action);

    // Second dispatch should be a no-op (already in initializing-db)
    expect(secondResult).toBe(firstResult);
  });
});

// ============================================
// STATE IMMUTABILITY
// ============================================

describe("appStateReducer - Immutability", () => {
  it("does not mutate input state", () => {
    const state: OnboardingState = {
      status: "onboarding",
      step: "phone-type",
      user: mockUser,
      platform: mockMacOSPlatform,
      completedSteps: [],
    };
    const originalState = JSON.parse(JSON.stringify(state));
    const action: AppAction = {
      type: "ONBOARDING_STEP_COMPLETE",
      step: "phone-type",
    };

    appStateReducer(state, action);

    expect(state).toEqual(originalState);
  });

  it("returns same reference for no-op transitions", () => {
    const state: AppState = { status: "unauthenticated" };
    const action: AppAction = { type: "DB_INIT_COMPLETE", success: true };

    const result = appStateReducer(state, action);

    expect(result).toBe(state);
  });
});

// ============================================
// INIT_STAGE_RECEIVED TESTS (BACKLOG-1382)
// ============================================

describe("INIT_STAGE_RECEIVED", () => {
  it("updates initStage on loading state", () => {
    const state: LoadingState = {
      status: "loading",
      phase: "initializing-db",
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "db-opening", message: "Opening database..." },
    });

    expect(result).toEqual({
      status: "loading",
      phase: "initializing-db",
      initStage: "db-opening",
      initMessage: "Opening database...",
      migrationProgress: undefined,
    });
  });

  it("updates migrationProgress when stage is migrating", () => {
    const state: LoadingState = {
      status: "loading",
      phase: "initializing-db",
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "migrating", progress: 50, message: "Running migrations..." },
    });

    expect(result).toEqual({
      status: "loading",
      phase: "initializing-db",
      initStage: "migrating",
      migrationProgress: 50,
      initMessage: "Running migrations...",
    });
  });

  it("preserves existing loading state fields", () => {
    const state: LoadingState = {
      status: "loading",
      phase: "initializing-db",
      progress: 25,
      deferredDbInit: false,
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "db-ready" },
    });

    const resultLoading = result as LoadingState;
    expect(resultLoading.status).toBe("loading");
    expect(resultLoading.phase).toBe("initializing-db");
    expect(resultLoading.progress).toBe(25);
    expect(resultLoading.deferredDbInit).toBe(false);
    expect(resultLoading.initStage).toBe("db-ready");
  });

  it("is ignored when not in loading state (onboarding)", () => {
    const state: AppState = {
      status: "onboarding",
      step: "phone-type",
      user: mockUser,
      platform: mockMacOSPlatform,
      completedSteps: [],
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "db-opening" },
    });

    expect(result).toBe(state);
  });

  it("is ignored when in unauthenticated state", () => {
    const state: AppState = { status: "unauthenticated" };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "db-opening" },
    });

    expect(result).toBe(state);
  });

  it("is ignored when in ready state", () => {
    const state: ReadyState = {
      status: "ready",
      user: mockUser,
      platform: mockMacOSPlatform,
      userData: mockCompleteUserData,
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "complete" },
    });

    expect(result).toBe(state);
  });

  it("handles error payload without affecting state transitions", () => {
    const state: LoadingState = {
      status: "loading",
      phase: "initializing-db",
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: {
        stage: "error",
        error: { message: "Migration failed", retryable: true },
      },
    });

    const resultLoading = result as LoadingState;
    expect(resultLoading.initStage).toBe("error");
    // Error in payload is metadata only — does NOT change state machine status
    expect(resultLoading.status).toBe("loading");
    expect(resultLoading.phase).toBe("initializing-db");
  });

  it("works during any loading phase, not just initializing-db", () => {
    const state: LoadingState = {
      status: "loading",
      phase: "checking-storage",
    };

    const result = appStateReducer(state, {
      type: "INIT_STAGE_RECEIVED",
      payload: { stage: "idle" },
    });

    const resultLoading = result as LoadingState;
    expect(resultLoading.initStage).toBe("idle");
    expect(resultLoading.phase).toBe("checking-storage");
  });
});
