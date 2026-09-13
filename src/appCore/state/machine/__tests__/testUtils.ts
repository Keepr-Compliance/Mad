/**
 * Integration Test Utilities
 *
 * Shared test utilities for state machine integration tests.
 * Provides mock API setup, render helpers, and state verification utilities.
 *
 * @module appCore/state/machine/__tests__/testUtils
 */

import React from "react";
import { render, waitFor, type RenderResult } from "@testing-library/react";
import { renderHook, type RenderHookResult } from "@testing-library/react";
import { AppStateProvider } from "../AppStateContext";
import { LoadingOrchestrator } from "../LoadingOrchestrator";
import { useAppState } from "../useAppState";
import { AuthProvider } from "../../../../contexts";
import type {
  AppState,
  AppStateContextValue,
  User,
  PlatformInfo,
  UserData,
} from "../types";

// ============================================
// MOCK API TYPES
// ============================================

export interface MockApiResult<T> {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface MockSystemApi {
  hasEncryptionKeyStore: jest.Mock<
    Promise<{ success: boolean; hasKeyStore: boolean }>
  >;
  initializeSecureStorage: jest.Mock<
    Promise<{ success: boolean; available: boolean; error?: string }>
  >;
}

export interface MockAuthApi {
  getCurrentUser: jest.Mock<
    Promise<{
      success: boolean;
      user?: {
        id: string;
        email: string;
        display_name?: string;
        avatar_url?: string;
      };
      isNewUser?: boolean;
    }>
  >;
}

export interface MockApi {
  system: MockSystemApi;
  auth: MockAuthApi;
}

// ============================================
// MOCK API FACTORY
// ============================================

/**
 * Creates a fresh mock API object with all methods as jest.fn().
 * Call this in beforeEach to ensure test isolation.
 */
export function createMockApi(): MockApi {
  return {
    system: {
      hasEncryptionKeyStore: jest.fn(),
      initializeSecureStorage: jest.fn(),
    },
    auth: {
      getCurrentUser: jest.fn(),
    },
  };
}

/**
 * Global mock API instance.
 * Reset via resetMockApi() in beforeEach.
 *
 * IMPORTANT: We use a persistent object and just reset the mock functions
 * to ensure all references to `mockApi` stay valid.
 */
export const mockApi: MockApi = {
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
  },
  auth: {
    getCurrentUser: jest.fn(),
  },
};

/**
 * Resets the mock API to a fresh state.
 * Call in beforeEach to ensure test isolation.
 *
 * Note: We reset the existing mock functions rather than replacing the object
 * to ensure all imported references to mockApi stay valid.
 */
export function resetMockApi(): void {
  mockApi.system.hasEncryptionKeyStore.mockReset();
  mockApi.system.initializeSecureStorage.mockReset();
  mockApi.auth.getCurrentUser.mockReset();
  (window as unknown as { api: MockApi }).api = mockApi;
}

/**
 * Installs the mock API on window.
 * Call in beforeAll.
 */
export function installMockApi(): void {
  (window as unknown as { api: MockApi }).api = mockApi;
}

/**
 * Removes the mock API from window.
 * Call in afterAll.
 */
export function uninstallMockApi(): void {
  delete (window as unknown as { api?: MockApi }).api;
}

// ============================================
// PLATFORM MOCKING
// ============================================

/**
 * Sets the navigator.platform for platform-specific tests.
 */
export function setPlatform(platform: "mac" | "windows" | "linux"): void {
  const platformStrings: Record<string, string> = {
    mac: "MacIntel",
    windows: "Win32",
    linux: "Linux x86_64",
  };

  Object.defineProperty(window.navigator, "platform", {
    value: platformStrings[platform],
    configurable: true,
  });
}

// ============================================
// TEST FIXTURES
// ============================================

export const testFixtures = {
  users: {
    basic: {
      id: "user-123",
      email: "test@example.com",
    } as User,

    withDisplayName: {
      id: "user-456",
      email: "user@example.com",
      displayName: "Test User",
      avatarUrl: "https://example.com/avatar.png",
    } as User,

    returning: {
      id: "returning-user",
      email: "returning@example.com",
      displayName: "Returning User",
    } as User,
  },

  platforms: {
    macOS: {
      isMacOS: true,
      isWindows: false,
      hasIPhone: false,
    } as PlatformInfo,

    macOSWithIPhone: {
      isMacOS: true,
      isWindows: false,
      hasIPhone: true,
    } as PlatformInfo,

    windows: {
      isMacOS: false,
      isWindows: true,
      hasIPhone: false,
    } as PlatformInfo,

    windowsWithIPhone: {
      isMacOS: false,
      isWindows: true,
      hasIPhone: true,
    } as PlatformInfo,
  },

  userData: {
    newUser: {
      phoneType: null,
      hasCompletedEmailOnboarding: false,
      hasEmailConnected: false,
      needsDriverSetup: false,
      fda: "not-asked",
    } as UserData,

    completedMacOS: {
      phoneType: "iphone" as const,
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: true,
      needsDriverSetup: false,
      fda: "granted",
    } as UserData,

    completedWindows: {
      phoneType: "iphone" as const,
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: true,
      // BACKLOG-3275: Full Disk Access is not a concept on Windows.
      needsDriverSetup: false,
      fda: "not-applicable",
    } as UserData,

    needsOnboarding: {
      phoneType: null,
      hasCompletedEmailOnboarding: false,
      hasEmailConnected: false,
      needsDriverSetup: true,
      fda: "not-asked",
    } as UserData,
  },
};

// ============================================
// MOCK API PRESETS
// ============================================

/**
 * Configures mock API for a new user on macOS.
 * - No keystore initially
 * - DB init succeeds
 * - No existing session
 */
export function setupNewUserMacOS(): void {
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
    success: true,
    hasKeyStore: false,
  });
  mockApi.system.initializeSecureStorage.mockResolvedValue({
    success: true,
    available: true,
  });
  mockApi.auth.getCurrentUser.mockResolvedValue({
    success: false,
  });
  setPlatform("mac");
}

/**
 * Configures mock API for a new user on Windows.
 * - No keystore initially
 * - DB init succeeds
 * - No existing session
 *
 * BACKLOG-3253: this used to report `hasKeyStore: true` with the reason
 * "Windows DPAPI doesn't need keychain". That is a state the producer cannot
 * emit on a first run — `hasEncryptionKeyStore()` is `fs.existsSync()` on a
 * file under userData (databaseEncryptionService.ts `hasKeyStore()`), so a
 * genuine first run reports false on EVERY platform. The outcome was unchanged
 * either way, which is why the drift stayed latent.
 */
export function setupNewUserWindows(): void {
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
    success: true,
    hasKeyStore: false,
  });
  mockApi.system.initializeSecureStorage.mockResolvedValue({
    success: true,
    available: true,
  });
  mockApi.auth.getCurrentUser.mockResolvedValue({
    success: false,
  });
  setPlatform("windows");
}

/**
 * Configures mock API for a returning user.
 * - Keystore exists
 * - DB init succeeds
 * - Has existing session
 */
export function setupReturningUser(user: User = testFixtures.users.returning): void {
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
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
    },
    isNewUser: false,
  });
}

/**
 * Configures mock API for a new user after OAuth login.
 * - Keystore exists (created during login)
 * - DB init succeeds
 * - Has session with isNewUser=true
 */
export function setupNewUserAfterOAuth(user: User = testFixtures.users.basic): void {
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
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      avatar_url: user.avatarUrl,
    },
    isNewUser: true,
  });
}

/**
 * Configures mock API for database initialization failure.
 */
export function setupDbInitFailure(errorMessage = "Keychain access denied"): void {
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
    success: true,
    hasKeyStore: true,
  });
  mockApi.system.initializeSecureStorage.mockResolvedValue({
    success: false,
    available: false,
    error: errorMessage,
  });
}

/**
 * Configures mock API for storage check failure.
 */
export function setupStorageCheckFailure(
  errorMessage = "Storage check failed"
): void {
  mockApi.system.hasEncryptionKeyStore.mockRejectedValue(
    new Error(errorMessage)
  );
}

// ============================================
// RENDER HELPERS
// ============================================

interface TestWrapperProps {
  children: React.ReactNode;
  initialState?: AppState;
}

/**
 * Test wrapper component that provides AuthProvider, AppStateProvider and LoadingOrchestrator.
 */
export function TestWrapper({
  children,
  initialState,
}: TestWrapperProps): React.ReactElement {
  return React.createElement(
    AuthProvider,
    null,
    React.createElement(
      AppStateProvider,
      { initialState, children: React.createElement(LoadingOrchestrator, { children }) }
    )
  );
}

/**
 * Creates a wrapper function for renderHook.
 * Includes AuthProvider, AppStateProvider and LoadingOrchestrator.
 */
export function createHookWrapper(initialState?: AppState) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      AuthProvider,
      null,
      React.createElement(
        AppStateProvider,
        { initialState, children: React.createElement(LoadingOrchestrator, { children }) }
      )
    );
  };
}

/**
 * Renders a component with the full state machine context.
 */
export function renderWithStateMachine(
  ui: React.ReactElement,
  initialState?: AppState
): RenderResult {
  return render(
    React.createElement(TestWrapper, { initialState, children: ui })
  );
}

/**
 * Renders the useAppState hook with full context.
 */
export function renderAppStateHook(
  initialState?: AppState
): RenderHookResult<AppStateContextValue, unknown> {
  return renderHook(() => useAppState(), {
    wrapper: createHookWrapper(initialState),
  });
}

// ============================================
// STATE VERIFICATION HELPERS
// ============================================

/**
 * Waits for the state to reach a specific status.
 * Throws if timeout is exceeded.
 */
export async function waitForStatus(
  getState: () => { status: string },
  expectedStatus: string,
  timeout = 5000
): Promise<void> {
  await waitFor(
    () => {
      expect(getState().status).toBe(expectedStatus);
    },
    { timeout }
  );
}

/**
 * Waits for the state to NOT be a specific status.
 * Useful for waiting for a state to change.
 */
export async function waitForStatusNot(
  getState: () => { status: string },
  unexpectedStatus: string,
  timeout = 5000
): Promise<void> {
  await waitFor(
    () => {
      expect(getState().status).not.toBe(unexpectedStatus);
    },
    { timeout }
  );
}

/**
 * Waits for loading to complete (status is not 'loading').
 */
export async function waitForLoadingComplete(
  getState: () => { status: string },
  timeout = 5000
): Promise<void> {
  await waitForStatusNot(getState, "loading", timeout);
}

// ============================================
// STATE HISTORY TRACKING
// ============================================

/**
 * Creates a state history tracker for verifying state transitions.
 * Returns a React component that records state changes and the history array.
 */
export function createStateHistoryTracker(): {
  StateHistoryRecorder: React.FC;
  getHistory: () => string[];
  clearHistory: () => void;
} {
  const history: string[] = [];

  const StateHistoryRecorder: React.FC = () => {
    const { state } = useAppState();

    // Record on every render (not just effect) to catch initial state
    // Only record if status changed from last recorded state
    if (history.length === 0 || history[history.length - 1] !== state.status) {
      history.push(state.status);
    }

    return null;
  };

  return {
    StateHistoryRecorder,
    getHistory: () => [...history],
    clearHistory: () => {
      history.length = 0;
    },
  };
}

// ============================================
// JEST LIFECYCLE HELPERS
// ============================================

/**
 * Sets up default mock implementations that prevent crashes.
 * Tests can override these with specific mock setups.
 */
export function setupDefaultMocks(): void {
  // Default implementations that prevent crashes during effect execution
  // Tests should override these with their specific setup functions
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({
    success: true,
    hasKeyStore: true,
  });
  mockApi.system.initializeSecureStorage.mockResolvedValue({
    success: true,
    available: true,
  });
  mockApi.auth.getCurrentUser.mockResolvedValue({
    success: false,
  });
}

/**
 * Standard setup for integration tests.
 * Call this at the top of your test file.
 *
 * @example
 * ```ts
 * describe('MyTests', () => {
 *   setupIntegrationTests();
 *
 *   it('my test', () => {
 *     // mockApi is ready to use
 *   });
 * });
 * ```
 */
export function setupIntegrationTests(): void {
  beforeAll(() => {
    installMockApi();
  });

  afterAll(() => {
    uninstallMockApi();
  });

  beforeEach(() => {
    resetMockApi();
    setPlatform("mac"); // Default to macOS
    jest.clearAllMocks();
    // Set default mocks to prevent crashes - tests can override with specific setups
    setupDefaultMocks();
  });
}
