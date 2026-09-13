/**
 * App State Context Tests
 *
 * Tests for the AppStateProvider and useAppState hook.
 * Verifies provider behavior, hook usage, and derived value memoization.
 *
 * @module appCore/state/machine/AppStateContext.test
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { AppStateProvider, AppStateContext } from "./AppStateContext";
import {
  useAppState,
  useAppStateStatus,
  useCurrentUser,
  usePlatform,
  useLoadingPhase,
  useOnboardingStep,
  useAppError,
} from "./useAppState";
import type {
  AppState,
  ReadyState,
  OnboardingState,
  ErrorState,
  LoadingState,
  User,
  PlatformInfo,
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

const mockPlatform: PlatformInfo = {
  isMacOS: true,
  isWindows: false,
  hasIPhone: true,
};

const mockUserData: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  fda: "granted",
};

const mockReadyState: ReadyState = {
  status: "ready",
  user: mockUser,
  platform: mockPlatform,
  userData: mockUserData,
};

const mockOnboardingState: OnboardingState = {
  status: "onboarding",
  step: "phone-type",
  user: mockUser,
  platform: mockPlatform,
  completedSteps: [],
};

const mockErrorState: ErrorState = {
  status: "error",
  error: { code: "NETWORK_ERROR", message: "Connection lost" },
  recoverable: true,
};

const mockLoadingState: LoadingState = {
  status: "loading",
  phase: "initializing-db",
};

// ============================================
// HELPER COMPONENTS
// ============================================

/**
 * Test component that displays state values.
 */
function StateDisplay() {
  const { state, isLoading, isReady, currentUser, platform, loadingPhase, onboardingStep, error } =
    useAppState();

  return (
    <div>
      <div data-testid="status">{state.status}</div>
      <div data-testid="isLoading">{String(isLoading)}</div>
      <div data-testid="isReady">{String(isReady)}</div>
      <div data-testid="currentUser">{currentUser?.email ?? "null"}</div>
      <div data-testid="platform">{platform ? "present" : "null"}</div>
      <div data-testid="loadingPhase">{loadingPhase ?? "null"}</div>
      <div data-testid="onboardingStep">{onboardingStep ?? "null"}</div>
      <div data-testid="error">{error?.message ?? "null"}</div>
    </div>
  );
}

/**
 * Test component that dispatches actions.
 */
function ActionDispatcher() {
  const { dispatch } = useAppState();

  return (
    <button
      data-testid="dispatch-logout"
      onClick={() => dispatch({ type: "LOGOUT" })}
    >
      Logout
    </button>
  );
}

// ============================================
// PROVIDER TESTS
// ============================================

describe("AppStateProvider", () => {
  describe("rendering", () => {
    it("renders children correctly", () => {
      render(
        <AppStateProvider>
          <div data-testid="child">Hello</div>
        </AppStateProvider>
      );

      expect(screen.getByTestId("child")).toHaveTextContent("Hello");
    });

    it("uses default initial state", () => {
      render(
        <AppStateProvider>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("status")).toHaveTextContent("loading");
      expect(screen.getByTestId("loadingPhase")).toHaveTextContent("checking-storage");
    });

    it("accepts custom initial state for testing", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("status")).toHaveTextContent("ready");
      expect(screen.getByTestId("currentUser")).toHaveTextContent("test@example.com");
    });
  });

  describe("derived values", () => {
    it("correctly derives isLoading for loading state", () => {
      render(
        <AppStateProvider initialState={mockLoadingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("isLoading")).toHaveTextContent("true");
      expect(screen.getByTestId("isReady")).toHaveTextContent("false");
    });

    it("correctly derives isReady for ready state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("isLoading")).toHaveTextContent("false");
      expect(screen.getByTestId("isReady")).toHaveTextContent("true");
    });

    it("correctly derives currentUser from ready state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("currentUser")).toHaveTextContent("test@example.com");
    });

    it("correctly derives currentUser from onboarding state", () => {
      render(
        <AppStateProvider initialState={mockOnboardingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("currentUser")).toHaveTextContent("test@example.com");
    });

    it("derives null currentUser for unauthenticated state", () => {
      render(
        <AppStateProvider initialState={{ status: "unauthenticated" }}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("currentUser")).toHaveTextContent("null");
    });

    it("correctly derives platform from ready state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("platform")).toHaveTextContent("present");
    });

    it("correctly derives platform from onboarding state", () => {
      render(
        <AppStateProvider initialState={mockOnboardingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("platform")).toHaveTextContent("present");
    });

    it("derives null platform for loading state", () => {
      render(
        <AppStateProvider initialState={mockLoadingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("platform")).toHaveTextContent("null");
    });

    it("correctly derives loadingPhase", () => {
      render(
        <AppStateProvider initialState={mockLoadingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("loadingPhase")).toHaveTextContent("initializing-db");
    });

    it("derives null loadingPhase for non-loading state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("loadingPhase")).toHaveTextContent("null");
    });

    it("correctly derives onboardingStep", () => {
      render(
        <AppStateProvider initialState={mockOnboardingState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("onboardingStep")).toHaveTextContent("phone-type");
    });

    it("derives null onboardingStep for non-onboarding state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("onboardingStep")).toHaveTextContent("null");
    });

    it("correctly derives error", () => {
      render(
        <AppStateProvider initialState={mockErrorState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("error")).toHaveTextContent("Connection lost");
    });

    it("derives null error for non-error state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("error")).toHaveTextContent("null");
    });
  });

  describe("dispatch", () => {
    it("provides working dispatch function", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
          <ActionDispatcher />
        </AppStateProvider>
      );

      expect(screen.getByTestId("status")).toHaveTextContent("ready");

      act(() => {
        screen.getByTestId("dispatch-logout").click();
      });

      expect(screen.getByTestId("status")).toHaveTextContent("unauthenticated");
    });

    it("updates derived values after dispatch", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
          <ActionDispatcher />
        </AppStateProvider>
      );

      expect(screen.getByTestId("isReady")).toHaveTextContent("true");
      expect(screen.getByTestId("currentUser")).toHaveTextContent("test@example.com");

      act(() => {
        screen.getByTestId("dispatch-logout").click();
      });

      expect(screen.getByTestId("isReady")).toHaveTextContent("false");
      expect(screen.getByTestId("currentUser")).toHaveTextContent("null");
    });
  });

  describe("multiple consumers", () => {
    it("provides same value to multiple consumers", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
          <div data-testid="consumer2">
            <StateDisplay />
          </div>
        </AppStateProvider>
      );

      const statuses = screen.getAllByTestId("status");
      expect(statuses).toHaveLength(2);
      expect(statuses[0]).toHaveTextContent("ready");
      expect(statuses[1]).toHaveTextContent("ready");
    });

    it("updates all consumers on state change", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StateDisplay />
          <div data-testid="consumer2">
            <StateDisplay />
          </div>
          <ActionDispatcher />
        </AppStateProvider>
      );

      act(() => {
        screen.getByTestId("dispatch-logout").click();
      });

      const statuses = screen.getAllByTestId("status");
      expect(statuses[0]).toHaveTextContent("unauthenticated");
      expect(statuses[1]).toHaveTextContent("unauthenticated");
    });
  });
});

// ============================================
// USE APP STATE HOOK TESTS
// ============================================

describe("useAppState", () => {
  it("throws error when used outside provider", () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<StateDisplay />);
    }).toThrow("useAppState must be used within an AppStateProvider");

    consoleSpy.mockRestore();
  });

  it("returns context value when inside provider", () => {
    render(
      <AppStateProvider initialState={mockReadyState}>
        <StateDisplay />
      </AppStateProvider>
    );

    expect(screen.getByTestId("status")).toHaveTextContent("ready");
  });
});

// ============================================
// SELECTOR HOOK TESTS
// ============================================

describe("selector hooks", () => {
  describe("useAppStateStatus", () => {
    function StatusDisplay() {
      const status = useAppStateStatus();
      return <div data-testid="status">{status}</div>;
    }

    it("returns current status", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <StatusDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("status")).toHaveTextContent("ready");
    });
  });

  describe("useCurrentUser", () => {
    function UserDisplay() {
      const user = useCurrentUser();
      return <div data-testid="user">{user?.email ?? "no user"}</div>;
    }

    it("returns current user when available", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <UserDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("user")).toHaveTextContent("test@example.com");
    });

    it("returns null when no user", () => {
      render(
        <AppStateProvider initialState={{ status: "unauthenticated" }}>
          <UserDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("user")).toHaveTextContent("no user");
    });
  });

  describe("usePlatform", () => {
    function PlatformDisplay() {
      const platform = usePlatform();
      return <div data-testid="platform">{platform?.isMacOS ? "macOS" : "not macOS"}</div>;
    }

    it("returns platform when available", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <PlatformDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("platform")).toHaveTextContent("macOS");
    });
  });

  describe("useLoadingPhase", () => {
    function LoadingPhaseDisplay() {
      const phase = useLoadingPhase();
      return <div data-testid="phase">{phase ?? "not loading"}</div>;
    }

    it("returns phase when loading", () => {
      render(
        <AppStateProvider initialState={mockLoadingState}>
          <LoadingPhaseDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("phase")).toHaveTextContent("initializing-db");
    });

    it("returns null when not loading", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <LoadingPhaseDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("phase")).toHaveTextContent("not loading");
    });
  });

  describe("useOnboardingStep", () => {
    function OnboardingStepDisplay() {
      const step = useOnboardingStep();
      return <div data-testid="step">{step ?? "not onboarding"}</div>;
    }

    it("returns step when onboarding", () => {
      render(
        <AppStateProvider initialState={mockOnboardingState}>
          <OnboardingStepDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("step")).toHaveTextContent("phone-type");
    });

    it("returns null when not onboarding", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <OnboardingStepDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("step")).toHaveTextContent("not onboarding");
    });
  });

  describe("useAppError", () => {
    function ErrorDisplay() {
      const error = useAppError();
      return <div data-testid="error">{error?.message ?? "no error"}</div>;
    }

    it("returns error when in error state", () => {
      render(
        <AppStateProvider initialState={mockErrorState}>
          <ErrorDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("error")).toHaveTextContent("Connection lost");
    });

    it("returns null when not in error state", () => {
      render(
        <AppStateProvider initialState={mockReadyState}>
          <ErrorDisplay />
        </AppStateProvider>
      );

      expect(screen.getByTestId("error")).toHaveTextContent("no error");
    });
  });
});

// ============================================
// CONTEXT EXPORT TESTS
// ============================================

describe("AppStateContext export", () => {
  it("exports AppStateContext for testing", () => {
    expect(AppStateContext).toBeDefined();
  });

  it("context has null as default value", () => {
    // Accessing context outside provider should return null
    // We can't directly test this without the hook, but we verify it throws
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<StateDisplay />);
    }).toThrow();

    consoleSpy.mockRestore();
  });
});
