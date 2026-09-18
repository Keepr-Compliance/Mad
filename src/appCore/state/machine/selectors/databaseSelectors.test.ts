/**
 * Database Selectors Tests
 *
 * Tests for database-related state selectors.
 */

import type { AppState, LoadingState, ReadyState, OnboardingState, ErrorState, UnauthenticatedState } from "../types";
import {
  selectIsDatabaseInitialized,
  selectIsCheckingSecureStorage,
  selectIsInitializingDatabase,
  selectIsLoadingAuth,
  selectIsLoadingUserData,
  selectIsDeferredDbInit,
} from "./databaseSelectors";

describe("databaseSelectors", () => {
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
      fda: "granted",
    },
  };

  const onboardingState: OnboardingState = {
    status: "onboarding",
    step: "phone-type",
    user: { id: "test", email: "test@example.com" },
    platform: { isMacOS: true, isWindows: false, hasIPhone: false },
    completedSteps: [],
  };

  const errorState: ErrorState = {
    status: "error",
    error: { code: "UNKNOWN_ERROR", message: "Test error" },
    recoverable: true,
  };

  const unauthenticatedState: UnauthenticatedState = {
    status: "unauthenticated",
  };

  describe("selectIsDatabaseInitialized", () => {
    it("returns false when checking storage", () => {
      expect(selectIsDatabaseInitialized(loadingCheckingStorage)).toBe(false);
    });

    it("returns false when initializing database", () => {
      expect(selectIsDatabaseInitialized(loadingInitializingDb)).toBe(false);
    });

    it("returns true when loading auth (past db init)", () => {
      expect(selectIsDatabaseInitialized(loadingAuth)).toBe(true);
    });

    it("returns false when loading auth with deferredDbInit", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-auth",
        deferredDbInit: true,
      };
      expect(selectIsDatabaseInitialized(state)).toBe(false);
    });

    it("returns true when loading user data (past db init)", () => {
      expect(selectIsDatabaseInitialized(loadingUserData)).toBe(true);
    });

    it("returns true when ready", () => {
      expect(selectIsDatabaseInitialized(readyState)).toBe(true);
    });

    it("returns true when onboarding", () => {
      expect(selectIsDatabaseInitialized(onboardingState)).toBe(true);
    });

    it("returns false when onboarding with deferredDbInit", () => {
      const state: OnboardingState = {
        ...onboardingState,
        deferredDbInit: true,
      };
      expect(selectIsDatabaseInitialized(state)).toBe(false);
    });

    it("returns false when error", () => {
      expect(selectIsDatabaseInitialized(errorState)).toBe(false);
    });

    it("returns false when unauthenticated", () => {
      expect(selectIsDatabaseInitialized(unauthenticatedState)).toBe(false);
    });

    it("returns false when unauthenticated with deferredDbInit", () => {
      const state: UnauthenticatedState = {
        status: "unauthenticated",
        deferredDbInit: true,
      };
      expect(selectIsDatabaseInitialized(state)).toBe(false);
    });
  });

  describe("selectIsDeferredDbInit", () => {
    it("returns true when loading with deferredDbInit", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-auth",
        deferredDbInit: true,
      };
      expect(selectIsDeferredDbInit(state)).toBe(true);
    });

    it("returns false when loading without deferredDbInit", () => {
      expect(selectIsDeferredDbInit(loadingAuth)).toBe(false);
    });

    it("returns true when unauthenticated with deferredDbInit", () => {
      const state: UnauthenticatedState = {
        status: "unauthenticated",
        deferredDbInit: true,
      };
      expect(selectIsDeferredDbInit(state)).toBe(true);
    });

    it("returns false when unauthenticated without deferredDbInit", () => {
      expect(selectIsDeferredDbInit(unauthenticatedState)).toBe(false);
    });

    it("returns true when onboarding with deferredDbInit", () => {
      const state: OnboardingState = {
        ...onboardingState,
        deferredDbInit: true,
      };
      expect(selectIsDeferredDbInit(state)).toBe(true);
    });

    it("returns false when onboarding without deferredDbInit", () => {
      expect(selectIsDeferredDbInit(onboardingState)).toBe(false);
    });

    it("returns false when ready", () => {
      expect(selectIsDeferredDbInit(readyState)).toBe(false);
    });

    it("returns false when error", () => {
      expect(selectIsDeferredDbInit(errorState)).toBe(false);
    });
  });

  describe("selectIsCheckingSecureStorage", () => {
    it("returns true only when loading and checking-storage", () => {
      expect(selectIsCheckingSecureStorage(loadingCheckingStorage)).toBe(true);
      expect(selectIsCheckingSecureStorage(loadingInitializingDb)).toBe(false);
      expect(selectIsCheckingSecureStorage(loadingAuth)).toBe(false);
      expect(selectIsCheckingSecureStorage(loadingUserData)).toBe(false);
      expect(selectIsCheckingSecureStorage(readyState)).toBe(false);
      expect(selectIsCheckingSecureStorage(onboardingState)).toBe(false);
      expect(selectIsCheckingSecureStorage(errorState)).toBe(false);
      expect(selectIsCheckingSecureStorage(unauthenticatedState)).toBe(false);
    });
  });

  describe("selectIsInitializingDatabase", () => {
    it("returns true only when loading and initializing-db", () => {
      expect(selectIsInitializingDatabase(loadingCheckingStorage)).toBe(false);
      expect(selectIsInitializingDatabase(loadingInitializingDb)).toBe(true);
      expect(selectIsInitializingDatabase(loadingAuth)).toBe(false);
      expect(selectIsInitializingDatabase(loadingUserData)).toBe(false);
      expect(selectIsInitializingDatabase(readyState)).toBe(false);
      expect(selectIsInitializingDatabase(onboardingState)).toBe(false);
      expect(selectIsInitializingDatabase(errorState)).toBe(false);
      expect(selectIsInitializingDatabase(unauthenticatedState)).toBe(false);
    });
  });

  describe("selectIsLoadingAuth", () => {
    it("returns true only when loading and loading-auth", () => {
      expect(selectIsLoadingAuth(loadingCheckingStorage)).toBe(false);
      expect(selectIsLoadingAuth(loadingInitializingDb)).toBe(false);
      expect(selectIsLoadingAuth(loadingAuth)).toBe(true);
      expect(selectIsLoadingAuth(loadingUserData)).toBe(false);
      expect(selectIsLoadingAuth(readyState)).toBe(false);
      expect(selectIsLoadingAuth(onboardingState)).toBe(false);
      expect(selectIsLoadingAuth(errorState)).toBe(false);
      expect(selectIsLoadingAuth(unauthenticatedState)).toBe(false);
    });
  });

  describe("selectIsLoadingUserData", () => {
    it("returns true only when loading and loading-user-data", () => {
      expect(selectIsLoadingUserData(loadingCheckingStorage)).toBe(false);
      expect(selectIsLoadingUserData(loadingInitializingDb)).toBe(false);
      expect(selectIsLoadingUserData(loadingAuth)).toBe(false);
      expect(selectIsLoadingUserData(loadingUserData)).toBe(true);
      expect(selectIsLoadingUserData(readyState)).toBe(false);
      expect(selectIsLoadingUserData(onboardingState)).toBe(false);
      expect(selectIsLoadingUserData(errorState)).toBe(false);
      expect(selectIsLoadingUserData(unauthenticatedState)).toBe(false);
    });
  });
});
