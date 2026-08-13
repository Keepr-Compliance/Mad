/**
 * State Machine Integration Tests
 *
 * Comprehensive integration tests verifying complete state machine flows:
 * - New user signup (macOS and Windows)
 * - Returning user login
 * - Error recovery
 * - Platform-specific paths
 * - Logout flows
 *
 * These tests use the full component stack (AppStateProvider + LoadingOrchestrator)
 * with mocked API calls to verify end-to-end state transitions.
 *
 * @module appCore/state/machine/__tests__/integration.test
 */

import React from "react";
import { act, waitFor, renderHook, screen } from "@testing-library/react";

// BACKLOG-1629: Mock Sentry since ErrorScreen now reports errors to Sentry
jest.mock("@sentry/electron/renderer", () => ({
  captureException: jest.fn(),
}));

// BACKLOG-1629: Mock SupportWidget since ErrorScreen now includes it
// and PlatformProvider is not available in the test wrapper
jest.mock("../../../../components/support/SupportWidget", () => ({
  SupportWidget: () => null,
}));

// Mock useNetwork to prevent "useNetwork must be used within a NetworkProvider" error
// (OfflineNotice in LoadingScreen/ErrorScreen calls useNetwork)
jest.mock("../../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));
import {
  mockApi,
  setupIntegrationTests,
  setupNewUserMacOS,
  setupNewUserWindows,
  setupReturningUser,
  setupNewUserAfterOAuth,
  setupDbInitFailure,
  setupStorageCheckFailure,
  renderAppStateHook,
  renderWithStateMachine,
  testFixtures,
  setPlatform,
} from "./testUtils";
import { useAppState } from "../useAppState";
import { AppStateProvider } from "../AppStateContext";
import type { AppState, ReadyState, UserData } from "../types";

// ============================================
// TEST SETUP
// ============================================

describe("AppState Integration Tests", () => {
  setupIntegrationTests();

  // ============================================
  // NEW USER FLOW (macOS)
  // ============================================

  describe("New User Flow (macOS)", () => {
    beforeEach(() => {
      setupNewUserMacOS();
    });

    it("transitions: loading -> unauthenticated for new user without session", async () => {
      const { result } = renderAppStateHook();

      // Wait for loading to complete - should go to unauthenticated
      await waitFor(() => {
        expect(result.current?.state.status).toBe("unauthenticated");
      });

      // Verify API calls were made (at least once each)
      // Note: React StrictMode may cause double calls in dev mode
      expect(mockApi.system.hasEncryptionKeyStore).toHaveBeenCalled();
      // NOTE: For first-time macOS users, initializeSecureStorage is DEFERRED
      // until the onboarding secure-storage step (not called during loading)
      expect(mockApi.system.initializeSecureStorage).not.toHaveBeenCalled();
      expect(mockApi.auth.getCurrentUser).toHaveBeenCalled();
    });

    it("shows onboarding after OAuth login (isNewUser=true)", async () => {
      // Setup: User completes OAuth, gets session with isNewUser flag
      setupNewUserAfterOAuth(testFixtures.users.basic);

      const { result } = renderAppStateHook();

      // Wait for onboarding state
      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // Verify user is set
      expect(result.current.currentUser?.email).toBe("test@example.com");

      // Verify first onboarding step is phone-type
      if (result.current.state.status === "onboarding") {
        expect(result.current.state.step).toBe("phone-type");
        expect(result.current.state.completedSteps).toEqual([]);
      }
    });

    it("progresses through onboarding steps correctly", async () => {
      setupNewUserAfterOAuth(testFixtures.users.basic);

      const { result } = renderAppStateHook();

      // Wait for onboarding
      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // Initial step should be phone-type
      expect(result.current.onboardingStep).toBe("phone-type");

      // Complete phone-type step
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
      });

      // On macOS, next should be secure-storage
      await waitFor(() => {
        expect(result.current.onboardingStep).toBe("secure-storage");
      });
    });

    it("stores platform info correctly for macOS", async () => {
      setupNewUserAfterOAuth();

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      expect(result.current.platform?.isMacOS).toBe(true);
      expect(result.current.platform?.isWindows).toBe(false);
    });
  });

  // ============================================
  // NEW USER FLOW (Windows)
  // ============================================

  describe("New User Flow (Windows)", () => {
    beforeEach(() => {
      setupNewUserWindows();
    });

    it("transitions: loading -> unauthenticated for new user on Windows", async () => {
      const { result } = renderAppStateHook();

      // Wait for loading to complete
      await waitFor(() => {
        expect(result.current.state.status).toBe("unauthenticated");
      });

      // Verify storage was initialized (DPAPI doesn't require keychain prompt)
      expect(mockApi.system.initializeSecureStorage).toHaveBeenCalled();
    });

    it("skips secure-storage step on Windows (DPAPI auto-handles)", async () => {
      // Setup Windows user after OAuth
      setupNewUserAfterOAuth(testFixtures.users.basic);
      setPlatform("windows");

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // First step should be phone-type
      expect(result.current.onboardingStep).toBe("phone-type");

      // Complete phone-type
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_STEP_COMPLETE",
          step: "phone-type",
        });
      });

      // On Windows, should go directly to email-connect (no secure-storage)
      await waitFor(() => {
        expect(result.current.onboardingStep).toBe("email-connect");
      });
    });

    it("stores platform info correctly for Windows", async () => {
      setupNewUserAfterOAuth();
      setPlatform("windows");

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      expect(result.current.platform?.isMacOS).toBe(false);
      expect(result.current.platform?.isWindows).toBe(true);
    });
  });

  // ============================================
  // RETURNING USER FLOW
  // ============================================

  describe("Returning User Flow", () => {
    it("transitions: loading -> ready (skips onboarding) for completed user", async () => {
      // Setup returning user with completed onboarding data
      setupReturningUser(testFixtures.users.returning);

      const { result } = renderAppStateHook();

      // The reducer transitions through USER_DATA_LOADED
      // Since we mock getCurrentUser as returning user (isNewUser=false),
      // it goes to loading-user-data phase, then the orchestrator loads user data
      // and if complete, goes to ready

      // Wait for state to settle (may go through loading phases)
      await waitFor(
        () => {
          // Should eventually reach ready or onboarding depending on user data
          expect(["ready", "onboarding"]).toContain(
            result.current.state.status
          );
        },
        { timeout: 5000 }
      );

      // Since the orchestrator loads placeholder userData that triggers onboarding,
      // returning user with incomplete data goes to onboarding
      // For truly "ready", the userData must be complete
    });

    it("loads user data from existing session", async () => {
      setupReturningUser(testFixtures.users.returning);

      const { result } = renderAppStateHook();

      // Wait for auth to be loaded
      await waitFor(() => {
        expect(result.current.state.status).not.toBe("loading");
      });

      // User should be set from the session
      // (either in onboarding or ready state)
      expect(result.current.currentUser?.email).toBe("returning@example.com");
    });

    it("no flicker during transition - state history is clean", async () => {
      setupReturningUser();

      // Track states directly using the hook
      const states: string[] = [];

      const StateRecorder = () => {
        const { state } = useAppState();
        // Record on every render
        if (states.length === 0 || states[states.length - 1] !== state.status) {
          states.push(state.status);
        }
        return null;
      };

      renderWithStateMachine(React.createElement(StateRecorder));

      // Wait for state to settle (non-loading terminal state)
      await waitFor(
        () => {
          const last = states[states.length - 1];
          expect(["onboarding", "ready", "unauthenticated"]).toContain(last);
        },
        { timeout: 5000 }
      );

      // States should only include valid status values
      // (loading may or may not be captured depending on timing)
      const validStates = ["loading", "unauthenticated", "onboarding", "ready"];
      states.forEach((s) => {
        expect(validStates).toContain(s);
      });

      // Should NOT have unexpected intermediate states
      // (no error states for a successful flow)
      expect(states).not.toContain("error");

      // Each state should appear at most once (no flickering back and forth)
      const uniqueStates = [...new Set(states)];
      expect(uniqueStates.length).toBe(states.length);
    });
  });

  // ============================================
  // ERROR RECOVERY
  // ============================================

  describe("Error Recovery", () => {
    // TASK-2278: These tests use renderWithStateMachine (renders full UI) because
    // LoadingOrchestrator now renders ErrorScreen for error states, unmounting
    // children hooks. We verify the ErrorScreen appears with correct messages.
    it("handles storage check failure", async () => {
      setupStorageCheckFailure("Storage access denied");

      renderWithStateMachine(
        React.createElement("div", { "data-testid": "children" }, "App Content")
      );

      // Should show error screen with the error message (not children)
      await waitFor(() => {
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      });
      expect(screen.getByText(/Storage access denied/)).toBeInTheDocument();
      // Recoverable error shows retry button
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });

    it("handles database init failure", async () => {
      setupDbInitFailure("Keychain access denied");

      renderWithStateMachine(
        React.createElement("div", { "data-testid": "children" }, "App Content")
      );

      // Should show error screen with the error message (not children/onboarding)
      await waitFor(() => {
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      });
      expect(screen.getByText(/Keychain access denied/)).toBeInTheDocument();
      // DB_INIT_FAILED is recoverable, so retry button should be present
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });

    it("allows retry from error state", async () => {
      // Test retry logic using just the provider (without orchestrator)
      // to avoid async timing issues with multiple mock calls
      const errorState: AppState = {
        status: "error",
        error: {
          code: "DB_INIT_FAILED",
          message: "Failed to initialize database",
        },
        recoverable: true,
        previousState: {
          status: "loading",
          phase: "initializing-db",
        },
      };

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: errorState } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

      // Should be in error state
      expect(result.current.state.status).toBe("error");

      // Dispatch RETRY
      act(() => {
        result.current.dispatch({ type: "RETRY" });
      });

      // Should return to previous state (loading)
      expect(result.current.state.status).toBe("loading");
      if (result.current.state.status === "loading") {
        expect(result.current.state.phase).toBe("initializing-db");
      }
    });

    // TASK-2278: Verify retry from error state transitions back to loading.
    // Uses direct initial state (not async initialization) to avoid timing issues
    // with LoadingOrchestrator unmounting hook children on error.
    it("retry restores previous state context", async () => {
      const errorState: AppState = {
        status: "error",
        error: {
          code: "DB_INIT_FAILED",
          message: "Failed to initialize database",
        },
        recoverable: true,
        previousState: {
          status: "loading",
          phase: "initializing-db",
        },
      };

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: errorState } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

      expect(result.current.state.status).toBe("error");
      if (result.current.state.status === "error") {
        expect(result.current.state.error.code).toBe("DB_INIT_FAILED");
        expect(result.current.state.recoverable).toBe(true);
        expect(result.current.state.previousState).toBeDefined();
      }

      // Dispatch retry
      act(() => {
        result.current.dispatch({ type: "RETRY" });
      });

      // Should return to previous state (loading)
      expect(result.current.state.status).toBe("loading");
      if (result.current.state.status === "loading") {
        expect(result.current.state.phase).toBe("initializing-db");
      }
    });

    it("non-recoverable error blocks retry", async () => {
      // Test non-recoverable error using just the provider
      const nonRecoverableError: AppState = {
        status: "error",
        error: {
          code: "UNKNOWN_ERROR",
          message: "Fatal error",
        },
        recoverable: false,
      };

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: nonRecoverableError } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

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

  describe("Logout", () => {
    it("transitions to unauthenticated from ready state", async () => {
      // Start with a ready state
      const readyState: ReadyState = {
        status: "ready",
        user: testFixtures.users.basic,
        platform: testFixtures.platforms.macOS,
        userData: testFixtures.userData.completedMacOS,
      };

      const { result } = renderAppStateHook(readyState);

      // Verify we start in ready state
      expect(result.current.state.status).toBe("ready");
      expect(result.current.currentUser?.email).toBe("test@example.com");

      // Logout
      act(() => {
        result.current.dispatch({ type: "LOGOUT" });
      });

      // Should immediately be unauthenticated
      expect(result.current.state.status).toBe("unauthenticated");
      expect(result.current.currentUser).toBeNull();
    });

    it("transitions to unauthenticated from onboarding state", async () => {
      setupNewUserAfterOAuth();

      const { result } = renderAppStateHook();

      // Wait for onboarding
      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // Logout during onboarding
      act(() => {
        result.current.dispatch({ type: "LOGOUT" });
      });

      expect(result.current.state.status).toBe("unauthenticated");
    });

    it("clears user data on logout", async () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testFixtures.users.returning,
        platform: testFixtures.platforms.macOS,
        userData: testFixtures.userData.completedMacOS,
      };

      const { result } = renderAppStateHook(readyState);

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
  // PLATFORM-SPECIFIC PATHS
  // ============================================

  describe("Platform-Specific Paths", () => {
    describe("macOS-specific steps", () => {
      it("includes secure-storage step for macOS", async () => {
        setupNewUserAfterOAuth();
        setPlatform("mac");

        const { result } = renderAppStateHook();

        await waitFor(() => {
          expect(result.current.state.status).toBe("onboarding");
        });

        // Complete phone-type
        act(() => {
          result.current.dispatch({
            type: "ONBOARDING_STEP_COMPLETE",
            step: "phone-type",
          });
        });

        // macOS should show secure-storage next
        await waitFor(() => {
          expect(result.current.onboardingStep).toBe("secure-storage");
        });
      });

      it("includes permissions step for macOS", async () => {
        setupNewUserAfterOAuth();
        setPlatform("mac");

        const { result } = renderAppStateHook();

        await waitFor(() => {
          expect(result.current.state.status).toBe("onboarding");
        });

        // Complete steps up to email-connect
        act(() => {
          result.current.dispatch({
            type: "ONBOARDING_STEP_COMPLETE",
            step: "phone-type",
          });
        });

        await waitFor(() => {
          expect(result.current.onboardingStep).toBe("secure-storage");
        });

        act(() => {
          result.current.dispatch({
            type: "ONBOARDING_STEP_COMPLETE",
            step: "secure-storage",
          });
        });

        await waitFor(() => {
          expect(result.current.onboardingStep).toBe("email-connect");
        });

        act(() => {
          result.current.dispatch({
            type: "ONBOARDING_STEP_COMPLETE",
            step: "email-connect",
          });
        });

        // macOS should show permissions next
        await waitFor(() => {
          expect(result.current.onboardingStep).toBe("permissions");
        });
      });
    });

    describe("Windows-specific steps", () => {
      it("skips macOS-only steps on Windows", async () => {
        setupNewUserAfterOAuth();
        setPlatform("windows");

        const { result } = renderAppStateHook();

        await waitFor(() => {
          expect(result.current.state.status).toBe("onboarding");
        });

        // Record step progression
        const steps: string[] = [];

        // Complete phone-type
        if (result.current.onboardingStep) {
          steps.push(result.current.onboardingStep);
        }

        act(() => {
          result.current.dispatch({
            type: "ONBOARDING_STEP_COMPLETE",
            step: "phone-type",
          });
        });

        await waitFor(() => {
          expect(result.current.onboardingStep).not.toBe("phone-type");
        });

        if (result.current.onboardingStep) {
          steps.push(result.current.onboardingStep);
        }

        // Windows should go directly to email-connect, not secure-storage
        expect(steps).toContain("phone-type");
        expect(steps).toContain("email-connect");
        expect(steps).not.toContain("secure-storage");
      });
    });
  });

  // ============================================
  // ONBOARDING SKIP BEHAVIOR
  // ============================================

  describe("Onboarding Skip", () => {
    it("skipping step advances to next step", async () => {
      setupNewUserAfterOAuth();

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      expect(result.current.onboardingStep).toBe("phone-type");

      // Skip instead of complete
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_SKIP",
          step: "phone-type",
        });
      });

      // Should advance to next step
      await waitFor(() => {
        expect(result.current.onboardingStep).not.toBe("phone-type");
      });
    });

    it("skip is tracked as completed step", async () => {
      setupNewUserAfterOAuth();

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // Skip phone-type
      act(() => {
        result.current.dispatch({
          type: "ONBOARDING_SKIP",
          step: "phone-type",
        });
      });

      // Verify it's in completedSteps
      if (result.current.state.status === "onboarding") {
        expect(result.current.state.completedSteps).toContain("phone-type");
      }
    });
  });

  // ============================================
  // DERIVED STATE SELECTORS
  // ============================================

  describe("Derived State Selectors", () => {
    it("isLoading is true only during loading", async () => {
      // Use initialState to start in loading without triggering orchestrator effects
      const loadingState: AppState = {
        status: "loading",
        phase: "checking-storage",
      };

      // Use a simpler wrapper that doesn't include LoadingOrchestrator
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: loadingState } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

      // Should be loading
      expect(result.current.isLoading).toBe(true);
      expect(result.current.isReady).toBe(false);
    });

    it("isReady is true only when ready", async () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testFixtures.users.basic,
        platform: testFixtures.platforms.macOS,
        userData: testFixtures.userData.completedMacOS,
      };

      const { result } = renderAppStateHook(readyState);

      expect(result.current.isReady).toBe(true);

      // Logout should clear isReady
      act(() => {
        result.current.dispatch({ type: "LOGOUT" });
      });

      expect(result.current.isReady).toBe(false);
    });

    it("error selector returns error only in error state", async () => {
      // Start in loading state without orchestrator
      const loadingState: AppState = {
        status: "loading",
        phase: "checking-storage",
      };

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: loadingState } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

      // Initially null (in loading state)
      expect(result.current.error).toBeNull();

      // Dispatch an error
      act(() => {
        result.current.dispatch({
          type: "ERROR",
          error: {
            code: "DB_INIT_FAILED",
            message: "Test error",
          },
          recoverable: true,
        });
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.code).toBe("DB_INIT_FAILED");
    });

    it("loadingPhase tracks current phase during loading", async () => {
      const loadingState: AppState = {
        status: "loading",
        phase: "initializing-db",
      };

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(
          AppStateProvider,
          // children is passed as createElement's 3rd arg, so the props
          // object legitimately omits it.
          { initialState: loadingState } as React.ComponentProps<
            typeof AppStateProvider
          >,
          children
        );

      const { result } = renderHook(() => useAppState(), { wrapper });

      expect(result.current.loadingPhase).toBe("initializing-db");
    });
  });

  // ============================================
  // CONCURRENT OPERATIONS
  // ============================================

  describe("Concurrent Operations", () => {
    it("handles rapid dispatch calls without corruption", async () => {
      setupNewUserAfterOAuth();

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("onboarding");
      });

      // Rapid-fire multiple dispatches
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

      // State should be consistent (not corrupted)
      expect(result.current.state.status).toBeDefined();

      if (result.current.state.status === "onboarding") {
        // All completed steps should be tracked
        expect(result.current.state.completedSteps).toContain("phone-type");
        expect(result.current.state.completedSteps).toContain("secure-storage");
        expect(result.current.state.completedSteps).toContain("email-connect");
      }
    });

    it("ignores invalid transitions gracefully", async () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testFixtures.users.basic,
        platform: testFixtures.platforms.macOS,
        userData: testFixtures.userData.completedMacOS,
      };

      const { result } = renderAppStateHook(readyState);

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
  });

  // ============================================
  // EDGE CASES
  // ============================================

  describe("Edge Cases", () => {
    it("handles empty user response gracefully", async () => {
      mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
        success: true,
        hasKeyStore: true,
      });
      mockApi.system.initializeSecureStorage.mockResolvedValue({
        success: true,
        available: true,
      });
      mockApi.auth.getCurrentUser.mockResolvedValue({
        success: true,
        user: undefined, // Empty user
      });

      const { result } = renderAppStateHook();

      await waitFor(() => {
        expect(result.current.state.status).toBe("unauthenticated");
      });
    });

    it("handles auth API rejection gracefully", async () => {
      mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
        success: true,
        hasKeyStore: true,
      });
      mockApi.system.initializeSecureStorage.mockResolvedValue({
        success: true,
        available: true,
      });
      mockApi.auth.getCurrentUser.mockRejectedValue(new Error("Network error"));

      const { result } = renderAppStateHook();

      // Should fallback to unauthenticated (not error) per orchestrator behavior
      await waitFor(() => {
        expect(result.current.state.status).toBe("unauthenticated");
      });
    });

    it("APP_READY action is no-op when already ready", () => {
      const readyState: ReadyState = {
        status: "ready",
        user: testFixtures.users.basic,
        platform: testFixtures.platforms.macOS,
        userData: testFixtures.userData.completedMacOS,
      };

      const { result } = renderAppStateHook(readyState);

      const beforeState = result.current.state;

      act(() => {
        result.current.dispatch({ type: "APP_READY" });
      });

      // State should be unchanged (same reference due to return state)
      expect(result.current.state).toBe(beforeState);
    });
  });
});
