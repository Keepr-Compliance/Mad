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
} from "./databaseSelectors";

describe("databaseSelectors", () => {
  // Test states
  const loadingCheckingStorage: LoadingState = {
    status: "loading",
    database: "unknown",
    phase: "checking-storage",
  };

  const loadingInitializingDb: LoadingState = {
    status: "loading",
    database: "unknown",
    phase: "initializing-db",
  };

  const loadingAuth: LoadingState = {
    status: "loading",
    database: "initialized",
    phase: "loading-auth",
  };

  const loadingUserData: LoadingState = {
    status: "loading",
    database: "initialized",
    phase: "loading-user-data",
  };

  const readyState: ReadyState = {
    status: "ready",
    database: "initialized",
    user: { id: "test", email: "test@example.com" },
    platform: { isMacOS: true, isWindows: false, hasIPhone: true },
    userData: {
      phoneType: "iphone",
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: true,
      needsDriverSetup: false,
      fda: "granted",
      setup: "finished",
    },
  };

  const onboardingState: OnboardingState = {
    status: "onboarding",
    database: "initialized",
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
    database: "initialized",
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

    // BACKLOG-3321: the answer is the recorded fact, not the phase.
    it("returns false when loading user data on the closed pre-auth route", () => {
      const state: LoadingState = {
        status: "loading",
        phase: "loading-user-data",
        database: "not-initialized",
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

    it("returns false when onboarding with the database not opened", () => {
      const state: OnboardingState = {
        ...onboardingState,
        database: "not-initialized",
      };
      expect(selectIsDatabaseInitialized(state)).toBe(false);
    });

    it("returns false when onboarding with the database unknown", () => {
      const state: OnboardingState = {
        ...onboardingState,
        database: "unknown",
      };
      expect(selectIsDatabaseInitialized(state)).toBe(false);
    });

    it("returns false when error with no previous state", () => {
      expect(selectIsDatabaseInitialized(errorState)).toBe(false);
    });

    it("answers an error with the state it was raised from (nested)", () => {
      const nested: ErrorState = {
        ...errorState,
        previousState: { ...errorState, previousState: readyState },
      };
      expect(selectIsDatabaseInitialized(nested)).toBe(true);
    });

    // BACKLOG-3321: Login after a normal start has the database open; Login on
    // the closed pre-auth route does not.
    it("returns the recorded fact when unauthenticated", () => {
      expect(selectIsDatabaseInitialized(unauthenticatedState)).toBe(true);
      const closed: UnauthenticatedState = {
        status: "unauthenticated",
        database: "not-initialized",
      };
      expect(selectIsDatabaseInitialized(closed)).toBe(false);
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
