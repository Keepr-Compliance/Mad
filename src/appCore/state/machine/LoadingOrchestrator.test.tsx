/**
 * Loading Orchestrator Tests
 *
 * Tests for the LoadingOrchestrator component that coordinates
 * the app initialization sequence.
 *
 * @module appCore/state/machine/LoadingOrchestrator.test
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { LoadingScreen } from "./components/LoadingScreen";
import { AppStateProvider } from "./AppStateContext";

import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState } from "./types";

// ============================================
// MOCK SETUP
// ============================================

// Mock Sentry (BACKLOG-1382: LoadingOrchestrator now imports Sentry for init stage breadcrumbs)
jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// BACKLOG-1629: Mock SupportWidget since ErrorScreen now includes it
// and PlatformProvider is not available in the test wrapper
jest.mock("../../../components/support/SupportWidget", () => ({
  SupportWidget: () => null,
}));

jest.mock("../../../contexts/NetworkContext", () => ({
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

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
  },
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
    onInitStage: jest.fn(),
    getInitStage: jest.fn(),
  },
};

// Setup global window.api mock
beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});

afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset platform mock
  Object.defineProperty(window.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  // Default to never-resolving promises to prevent unintended transitions
  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  // Default onInitStage returns a cleanup function (BACKLOG-1382)
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockReturnValue(new Promise(() => {}));
});

// ============================================
// HELPER COMPONENTS
// ============================================

/**
 * Wrapper for testing with provider.
 * SPRINT-066: Added AuthProvider wrapper since LoadingOrchestrator uses useAuth
 */
function TestWrapper({
  children,
  initialState,
}: {
  children: React.ReactNode;
  initialState?: AppState;
}) {
  return (
    <AuthProvider>
      <AppStateProvider initialState={initialState}>
        <LoadingOrchestrator>{children}</LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );
}

// ============================================
// STATIC STATE TESTS (no async transitions)
// ============================================

describe("LoadingOrchestrator", () => {
  describe("static rendering", () => {
    it("shows children when in ready state", () => {
      const readyState: AppState = {
        status: "ready",
        user: { id: "1", email: "test@test.com" },
        platform: { isMacOS: true, isWindows: false, hasIPhone: false },
        userData: {
          phoneType: "iphone",
          hasCompletedEmailOnboarding: true,
          hasEmailConnected: true,
          needsDriverSetup: false,
          hasPermissions: true,
        },
      };

      render(
        <TestWrapper initialState={readyState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      expect(screen.getByTestId("children")).toBeInTheDocument();
    });

    it("shows children when in unauthenticated state", () => {
      render(
        <TestWrapper initialState={{ status: "unauthenticated" }}>
          <div data-testid="children">Login Screen</div>
        </TestWrapper>
      );

      expect(screen.getByTestId("children")).toBeInTheDocument();
    });

    it("shows error screen for non-recoverable errors", () => {
      const errorState: AppState = {
        status: "error",
        error: {
          code: "DB_INIT_FAILED",
          message: "Critical failure",
        },
        recoverable: false,
      };

      render(
        <TestWrapper initialState={errorState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Critical failure")).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });

    // TASK-2278: Recoverable errors now show ErrorScreen with retry button
    it("shows error screen with retry button for recoverable errors", () => {
      const errorState: AppState = {
        status: "error",
        error: {
          code: "NETWORK_ERROR",
          message: "Connection lost",
        },
        recoverable: true,
      };

      render(
        <TestWrapper initialState={errorState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Connection lost")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });

    // TASK-2278: Non-recoverable errors show ErrorScreen WITHOUT retry button
    it("shows error screen without retry button for non-recoverable errors", () => {
      const errorState: AppState = {
        status: "error",
        error: {
          code: "DB_INIT_FAILED",
          message: "Critical failure",
        },
        recoverable: false,
      };

      render(
        <TestWrapper initialState={errorState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Critical failure")).toBeInTheDocument();
      // Reset App Data button is always present, but Try Again should NOT be
      expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });

    // TASK-2278: DB_INIT_FAILED specifically shows error screen (the bug scenario)
    it("shows error screen for DB_INIT_FAILED recoverable error instead of onboarding", () => {
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

      render(
        <TestWrapper initialState={errorState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      // Should show error screen, NOT children (which would show onboarding)
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Failed to initialize database")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      expect(screen.queryByTestId("children")).not.toBeInTheDocument();
    });
  });
});

// ============================================
// LOADING SCREEN COMPONENT TESTS
// ============================================

describe("LoadingScreen phases", () => {
  it("displays correct message for checking-storage phase", () => {
    // Never resolve so we stay in this phase
    mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));

    render(
      <TestWrapper>
        <div>Children</div>
      </TestWrapper>
    );

    expect(screen.getByText("Checking secure storage...")).toBeInTheDocument();
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("displays correct message for validating-auth phase (TASK-2086)", () => {
    render(
      <TestWrapper
        initialState={{ status: "loading", phase: "validating-auth" }}
      >
        <div>Children</div>
      </TestWrapper>
    );

    expect(
      screen.getByText("Verifying your account...")
    ).toBeInTheDocument();
  });

  it("displays correct message for initializing-db phase (macOS)", () => {
    // Default mock is MacIntel (set in beforeEach)
    render(
      <TestWrapper
        initialState={{ status: "loading", phase: "initializing-db" }}
      >
        <div>Children</div>
      </TestWrapper>
    );

    // macOS shows Keychain-specific message
    expect(
      screen.getByText("Waiting for Keychain access...")
    ).toBeInTheDocument();
  });

  it("displays correct message for initializing-db phase (Windows)", () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });

    render(
      <TestWrapper initialState={{ status: "loading", phase: "initializing-db" }}>
        <div>Children</div>
      </TestWrapper>
    );

    // Windows shows standard database message
    expect(
      screen.getByText("Initializing secure database...")
    ).toBeInTheDocument();
  });

  it("displays correct message for loading-auth phase", () => {
    render(
      <TestWrapper initialState={{ status: "loading", phase: "loading-auth" }}>
        <div>Children</div>
      </TestWrapper>
    );

    expect(screen.getByText("Loading authentication...")).toBeInTheDocument();
  });

  it("displays correct message for loading-user-data phase", () => {
    // Note: loading-user-data phase triggers the user data effect which will
    // dispatch an ERROR action because there's no auth data in ref.
    // So we just test that the loading screen initially shows the message.
    // For integration testing of this phase, see the full flow tests.
    render(
      <AppStateProvider
        initialState={{ status: "loading", phase: "loading-user-data" }}
      >
        <LoadingScreen phase="loading-user-data" />
      </AppStateProvider>
    );

    expect(screen.getByText("Loading your data...")).toBeInTheDocument();
  });

  it("has accessible loading indicator", () => {
    mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));

    render(
      <TestWrapper>
        <div>Children</div>
      </TestWrapper>
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

// ============================================
// ERROR SCREEN COMPONENT TESTS
// ============================================

describe("ErrorScreen", () => {
  it("displays error message and code", () => {
    const errorState: AppState = {
      status: "error",
      error: {
        code: "DB_INIT_FAILED",
        message: "Database initialization failed",
      },
      recoverable: false,
    };

    render(
      <TestWrapper initialState={errorState}>
        <div>Children</div>
      </TestWrapper>
    );

    expect(
      screen.getByText("Database initialization failed")
    ).toBeInTheDocument();
    expect(screen.getByText("Error code: DB_INIT_FAILED")).toBeInTheDocument();
  });

  // TASK-2278: Non-recoverable errors no longer show retry button
  it("does not show retry button for non-recoverable errors", () => {
    const errorState: AppState = {
      status: "error",
      error: {
        code: "DB_INIT_FAILED",
        message: "Failed",
      },
      recoverable: false,
    };

    render(
      <TestWrapper initialState={errorState}>
        <div>Children</div>
      </TestWrapper>
    );

    // Non-recoverable: no retry button, but Reset App Data is still available
    expect(screen.queryByRole("button", { name: "Try Again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset App Data" })).toBeInTheDocument();
  });
});

// ============================================
// PHASE TRANSITION TESTS
// ============================================

describe("LoadingOrchestrator phase transitions", () => {
  it("transitions from checking-storage through validating-auth to initializing-db (TASK-2086)", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    // Pre-auth validation passes (TASK-2086)
    mockApi.auth.preValidateSession.mockResolvedValue({
      valid: true,
      noSession: true,
    });
    // Never resolve - stay at initializing-db
    mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));

    render(
      <TestWrapper>
        <div>Children</div>
      </TestWrapper>
    );

    // First we see checking-storage message
    expect(screen.getByText("Checking secure storage...")).toBeInTheDocument();

    // TASK-2086: After storage check, we briefly see validating-auth,
    // then after pre-auth validation passes, we see initializing-db
    // (macOS shows "Waiting for Keychain access..." per platform-specific logic)
    await waitFor(
      () => {
        expect(
          screen.getByText("Waiting for Keychain access...")
        ).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it("transitions to error state on storage check failure", async () => {
    mockApi.system.hasEncryptionKeyStore.mockRejectedValue(
      new Error("Storage check failed")
    );

    render(
      <TestWrapper>
        <div data-testid="children">Children</div>
      </TestWrapper>
    );

    // TASK-2278: Storage check failure is a recoverable error and now shows
    // ErrorScreen with retry button (previously fell through to children)
    await waitFor(
      () => {
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it("transitions to error state on DB init failure", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: false,
      error: "Database initialization failed",
    });

    render(
      <TestWrapper>
        <div data-testid="children">Children</div>
      </TestWrapper>
    );

    // TASK-2278: DB init failure is a recoverable error and now shows
    // ErrorScreen with retry button (previously fell through to children/onboarding)
    await waitFor(
      () => {
        expect(screen.getByText("Something went wrong")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it("transitions to unauthenticated when no user session", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: true,
      available: true,
    });
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: false,
    });

    render(
      <TestWrapper>
        <div data-testid="children">Login Screen</div>
      </TestWrapper>
    );

    // Once unauthenticated, the children should be visible
    await waitFor(
      () => {
        expect(screen.getByTestId("children")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  // BACKLOG-1842 (resume-at-step fix round): the founder's FDA-relaunch QA
  // found the Login screen flashing for ~10s post-relaunch before the
  // session restored. Root cause: getCurrentUser() returns
  // { success: false, transient: true, retryable: true } while the local DB
  // is still starting up (BACKLOG-2149's whenDbReady gate on the main-process
  // side), and Phase 3 used to treat that identically to "no session" —
  // dispatching AUTH_LOADED with user: null, which flips state.status to
  // "unauthenticated" and renders Login. The fix retries transient/retryable
  // responses instead of giving up immediately.
  it("does NOT flash unauthenticated on a transient/retryable getCurrentUser response — retries and resolves once the DB comes up", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: true,
      available: true,
    });

    let callCount = 0;
    mockApi.auth.getCurrentUser.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        // First call: DB still starting up.
        return Promise.resolve({ success: false, transient: true, retryable: true });
      }
      // Retry: DB came up, session resolves normally.
      return Promise.resolve({
        success: true,
        user: { id: "user-1", email: "test@test.com" },
        isNewUser: true,
      });
    });

    render(
      <TestWrapper>
        <div data-testid="children">Onboarding Content</div>
      </TestWrapper>
    );

    // While retrying, the loading screen stays up — Login must NEVER appear.
    // (There is no "Login screen" testid in this render tree since children
    // is generic; the meaningful assertion is that children — which only
    // renders once status leaves "loading" — appears via the onboarding
    // path, not by first flashing an intermediate unauthenticated state that
    // a real app would render Login for.)
    await waitFor(
      () => {
        expect(screen.getByTestId("children")).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Retried at least once (transient → retry → success).
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("gives up and goes unauthenticated after repeated transient/retryable responses (bounded retry, not indefinite)", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: true,
      available: true,
    });

    // Always transient — simulates a DB that never comes up.
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: false,
      transient: true,
      retryable: true,
    });

    render(
      <TestWrapper>
        <div data-testid="children">Login Screen</div>
      </TestWrapper>
    );

    // Eventually gives up (bounded retries, ~1s apart) and reaches
    // unauthenticated rather than hanging on the loading screen forever.
    await waitFor(
      () => {
        expect(screen.getByTestId("children")).toBeInTheDocument();
      },
      { timeout: 10000 }
    );
  }, 15000);

  it("transitions to onboarding for new user", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    // TASK-2086: Pre-auth validation passes
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: true,
      available: true,
    });
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: true,
      user: { id: "user-1", email: "test@test.com" },
      isNewUser: true,
    });

    render(
      <TestWrapper>
        <div data-testid="children">Onboarding Content</div>
      </TestWrapper>
    );

    // Once in onboarding, the children should be visible (not loading)
    await waitFor(
      () => {
        expect(screen.getByTestId("children")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });

  it("skips DB init for first-time macOS users (deferredDbInit)", async () => {
    // First-time macOS user: no keystore exists
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: false, // No keystore = first time macOS user
    });
    // initializeSecureStorage should NOT be called - that's what we're testing
    mockApi.system.initializeSecureStorage.mockImplementation(() => {
      throw new Error("initializeSecureStorage should not be called when deferredDbInit is true");
    });
    // Auth should proceed normally
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: false, // No session - goes to unauthenticated
    });

    render(
      <TestWrapper>
        <div data-testid="children">Login Screen</div>
      </TestWrapper>
    );

    // Should skip DB init and go directly to loading-auth, then unauthenticated
    // If initializeSecureStorage was called, the test would fail with an error
    await waitFor(
      () => {
        expect(screen.getByTestId("children")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    // Verify initializeSecureStorage was never called
    expect(mockApi.system.initializeSecureStorage).not.toHaveBeenCalled();
  });
});

// ============================================
// PRELOAD BRIDGE RACE CONDITION TESTS (TASK-2005)
// ============================================

describe("LoadingOrchestrator preload bridge race condition", () => {
  it("does not throw when window.api is undefined at mount time", async () => {
    // Remove window.api to simulate the race condition
    const savedApi = window.api;
    delete (window as unknown as { api?: typeof mockApi }).api;

    // Should not throw - the waitForApi guard prevents the TypeError
    expect(() => {
      render(
        <TestWrapper>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );
    }).not.toThrow();

    // Restore window.api so waitForApi resolves and the component
    // can proceed (prevents act() warnings from dangling promises)
    (window as unknown as { api: typeof mockApi }).api = savedApi;

    // Wait for the component to process the restored API
    await waitFor(
      () => {
        // The loading screen should still be visible (or children if it transitioned)
        expect(document.body.querySelector("[role='status']") ||
          document.body.querySelector("[data-testid='children']")).toBeTruthy();
      },
      { timeout: 2000 }
    );
  });

  it("recovers when window.api becomes available after initial undefined", async () => {
    // Remove window.api to simulate the race condition
    const savedApi = window.api;
    delete (window as unknown as { api?: typeof mockApi }).api;

    // Setup: when API becomes available, storage check succeeds
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
      success: true,
      hasKeyStore: true,
    });
    // TASK-2086: Pre-auth validation passes
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true, noSession: true });
    // Stay at initializing-db phase
    mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));

    render(
      <TestWrapper>
        <div data-testid="children">App Content</div>
      </TestWrapper>
    );

    // Initially showing loading screen (waitForApi is polling)
    expect(screen.getByText("Checking secure storage...")).toBeInTheDocument();

    // Restore window.api after a short delay (simulates preload finishing)
    await new Promise((r) => setTimeout(r, 60));
    (window as unknown as { api: typeof mockApi }).api = savedApi;

    // Should eventually transition past validating-auth to initializing-db phase
    // (macOS shows "Waiting for Keychain access..." per platform-specific logic)
    await waitFor(
      () => {
        expect(
          screen.getByText("Waiting for Keychain access...")
        ).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  // ============================================
  // INIT STAGE SUBSCRIPTION (BACKLOG-1382)
  // ============================================

  describe("init stage subscription", () => {
    it("subscribes to onInitStage during initializing-db phase", async () => {
      const mockCleanup = jest.fn();
      mockApi.system.onInitStage.mockReturnValue(mockCleanup);

      // Start in initializing-db phase
      const initDbState: AppState = {
        status: "loading",
        phase: "initializing-db",
      };

      render(
        <TestWrapper initialState={initDbState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockApi.system.onInitStage).toHaveBeenCalledTimes(1);
        expect(mockApi.system.onInitStage).toHaveBeenCalledWith(expect.any(Function));
      });
    });

    it("does not subscribe when not in initializing-db phase", () => {
      mockApi.system.onInitStage.mockReturnValue(jest.fn());

      // Start in checking-storage phase
      const checkingState: AppState = {
        status: "loading",
        phase: "checking-storage",
      };

      render(
        <TestWrapper initialState={checkingState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      // onInitStage should not be called during checking-storage phase
      expect(mockApi.system.onInitStage).not.toHaveBeenCalled();
    });

    it("calls cleanup when component unmounts", async () => {
      const mockCleanup = jest.fn();
      mockApi.system.onInitStage.mockReturnValue(mockCleanup);

      const initDbState: AppState = {
        status: "loading",
        phase: "initializing-db",
      };

      const { unmount } = render(
        <TestWrapper initialState={initDbState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      await waitFor(() => {
        expect(mockApi.system.onInitStage).toHaveBeenCalledTimes(1);
      });

      unmount();

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it("dispatches INIT_STAGE_RECEIVED when event is received", async () => {
      let capturedCallback: ((event: Record<string, unknown>) => void) | null = null;
      mockApi.system.onInitStage.mockImplementation((cb: (event: Record<string, unknown>) => void) => {
        capturedCallback = cb;
        return jest.fn();
      });

      const initDbState: AppState = {
        status: "loading",
        phase: "initializing-db",
      };

      render(
        <TestWrapper initialState={initDbState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      await waitFor(() => {
        expect(capturedCallback).not.toBeNull();
      });

      // Simulate receiving an init stage event
      capturedCallback!({ stage: "db-opening", message: "Opening database..." });

      // The component should show the stage-specific message
      await waitFor(() => {
        expect(screen.getByText("Checking security...")).toBeInTheDocument();
      });
    });

    it("shows migration progress when migrating stage is received", async () => {
      let capturedCallback: ((event: Record<string, unknown>) => void) | null = null;
      mockApi.system.onInitStage.mockImplementation((cb: (event: Record<string, unknown>) => void) => {
        capturedCallback = cb;
        return jest.fn();
      });

      const initDbState: AppState = {
        status: "loading",
        phase: "initializing-db",
      };

      render(
        <TestWrapper initialState={initDbState}>
          <div data-testid="children">App Content</div>
        </TestWrapper>
      );

      await waitFor(() => {
        expect(capturedCallback).not.toBeNull();
      });

      // Simulate receiving a migration event with progress
      capturedCallback!({ stage: "migrating", progress: 42, message: "Running migrations..." });

      await waitFor(() => {
        expect(screen.getByText("Updating database... 42%")).toBeInTheDocument();
      });
    });
  });
});
