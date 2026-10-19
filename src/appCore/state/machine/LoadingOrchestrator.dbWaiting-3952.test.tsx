/**
 * BACKLOG-3952 — Phase 4 (loading-user-data) waits for a database the main
 * process is still retrying. While getInitStage reports "db-waiting" the
 * orchestrator must hold the gated reads past its normal 10 s bound, and run
 * them once the stage reaches "db-ready" -- no fallback read, no restart.
 *
 * FIXTURE PROVENANCE: getInitStage resolves { stage } as broadcast by
 * electron/services/initializationBroadcaster.ts ("db-waiting" is an InitStage
 * since BACKLOG-3952); other window.api shapes as in
 * LoadingOrchestrator.emailProviders-3888.test.tsx.
 */
import React from "react";
import { render, act } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState } from "./types";

jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../../components/support/SupportWidget", () => ({ SupportWidget: () => null }));
jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true, isChecking: false, lastOnlineAt: null, lastOfflineAt: null,
    connectionError: null, checkConnection: jest.fn(), clearError: jest.fn(), setConnectionError: jest.fn(),
  }),
}));

const NOT_CONNECTED = {
  connected: false,
  error: { type: "NOT_CONNECTED", userMessage: "not connected" },
};

const mockApi = {
  auth: { getCurrentUser: jest.fn(), preValidateSession: jest.fn() },
  system: {
    hasEncryptionKeyStore: jest.fn(), initializeSecureStorage: jest.fn(), onInitStage: jest.fn(),
    getInitStage: jest.fn(), checkAllConnections: jest.fn(), checkPermissions: jest.fn(),
  },
  user: {
    getPhoneType: jest.fn(),
    syncPhoneTypeFromCloud: jest.fn(async () => ({ success: true })),
    getPhoneTypeCloud: jest.fn(async () => ({ success: true })),
    getAccountSetup: jest.fn(),
  },
  preferences: { get: jest.fn() },
  drivers: { checkApple: jest.fn() },
};

beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});

const platform = { isMacOS: false, isWindows: true, hasIPhone: false };
const baseUser = { id: "user-3952", email: "user@example.com" };

describe("BACKLOG-3952 — Phase 4 waits through db-waiting", () => {
  let stage: string;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    stage = "db-waiting";
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    mockApi.drivers.checkApple.mockResolvedValue({ isInstalled: true });
    mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
    mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
    mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
    mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
    mockApi.system.onInitStage.mockReturnValue(jest.fn());
    mockApi.system.getInitStage.mockImplementation(async () => ({ stage }));
    mockApi.user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
    mockApi.system.checkAllConnections.mockResolvedValue({
      success: true, google: NOT_CONNECTED, microsoft: NOT_CONNECTED,
    });
    mockApi.system.checkPermissions.mockResolvedValue({ hasPermission: false, fullDiskAccess: false });
    mockApi.user.getAccountSetup.mockResolvedValue({
      success: true, setup: "finished", emailStepAnswered: true, contactSourceAnswered: true,
      emailProviders: [],
    });
    mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("holds the gated reads past 10 s of db-waiting, and runs them after db-ready", async () => {
    render(
      <AuthProvider>
        <AppStateProvider
          initialState={{ status: "loading", phase: "loading-user-data", user: baseUser, platform } as AppState}
        >
          <LoadingOrchestrator>
            <div />
          </LoadingOrchestrator>
        </AppStateProvider>
      </AuthProvider>,
    );

    // PRECONDITION: Phase 4 is polling the stage, not reading yet.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(mockApi.system.getInitStage).toHaveBeenCalled();
    expect(mockApi.user.getAccountSetup).not.toHaveBeenCalled();

    // Past the normal 10 s bound, still db-waiting: the reads must still wait.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mockApi.user.getAccountSetup).not.toHaveBeenCalled();
    expect(mockApi.user.getPhoneType).not.toHaveBeenCalled();
    expect(mockApi.system.checkAllConnections).not.toHaveBeenCalled();

    // The database becomes ready: the reads run.
    stage = "db-ready";
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(mockApi.user.getAccountSetup).toHaveBeenCalled();
  });
});
