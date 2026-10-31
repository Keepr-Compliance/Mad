/**
 * BACKLOG-3321 control C7: on a pre-auth rejection that keeps the database
 * closed, the orchestrator asks main whether the database is open
 * (`system:is-database-initialized`) and records the answer. It never opens
 * the database before a fresh sign-in on that route; BACKLOG-3555: the sign-in
 * then opens it exactly once.
 *
 * Harness copied from rejectedSession3410.control.test.tsx control 2.
 * Fixture provenance:
 * - preValidateSession results: preAuthValidationHandler.ts returns
 *   `{ valid: false, reason: "offline_grace_expired" }` and
 *   `{ valid: false, reason: "session_clear_failed" }`.
 * - isDatabaseInitialized result: systemHandlers.ts returns
 *   `{ success: true, initialized: databaseService.isInitialized() }`.
 *   `initialized: true` on this route is a renderer reload (main kept the DB
 *   open while the renderer restarted).
 * - LOGIN_SUCCESS: useLoginHandlers.ts dispatchLoginSuccess (hasIPhone false,
 *   isNewUser present).
 * Phase 4 hangs on getPhoneType (never resolves), so the final state is
 * loading/loading-user-data.
 */
import React, { useContext, useEffect } from "react";
import { render, waitFor, act } from "@testing-library/react";
import { selectIsDatabaseInitialized } from "./selectors/databaseSelectors";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider, AppStateContext } from "./AppStateContext";
import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState, AppAction, PlatformInfo, User } from "./types";

// Every action the provider's reducer sees, by identity (React may run the
// reducer more than once per action; a dispatch creates one action object).
const seenActions = new Set<{ type: string }>();
jest.mock("./reducer", () => {
  const actual = jest.requireActual("./reducer");
  return {
    ...actual,
    appStateReducer: (state: unknown, action: { type: string }) => {
      seenActions.add(action);
      return actual.appStateReducer(state, action);
    },
  };
});
jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../../components/support/SupportWidget", () => ({
  SupportWidget: () => null,
}));
jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true, isChecking: false, lastOnlineAt: null, lastOfflineAt: null,
    connectionError: null, checkConnection: jest.fn(), clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

const user: User = { id: "user-123", email: "test@example.com", displayName: "Test User" };
const mac: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
  },
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
    isDatabaseInitialized: jest.fn(),
    onInitStage: jest.fn(),
    getInitStage: jest.fn(),
    checkAllConnections: jest.fn(),
    checkPermissions: jest.fn(),
  },
  user: { getPhoneType: jest.fn() },
};

beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});
beforeEach(() => {
  jest.clearAllMocks();
  seenActions.clear();
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({ success: true, hasKeyStore: true });
  mockApi.system.initializeSecureStorage.mockResolvedValue({ success: true, available: true, platform: "darwin" });
  mockApi.auth.getCurrentUser.mockResolvedValue({ success: false });
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockReturnValue(new Promise(() => {}));
  mockApi.user.getPhoneType.mockReturnValue(new Promise(() => {}));
  mockApi.system.checkAllConnections.mockReturnValue(new Promise(() => {}));
  mockApi.system.checkPermissions.mockReturnValue(new Promise(() => {}));
});

let latest: AppState | null = null;
function Probe({ onUnauth }: { onUnauth: (d: (a: AppAction) => void) => void }) {
  const ctx = useContext(AppStateContext) as unknown as { state: AppState; dispatch: (a: AppAction) => void };
  latest = ctx.state;
  useEffect(() => {
    if (ctx.state.status === "unauthenticated") onUnauth(ctx.dispatch);
  }, [ctx.state.status]);
  return null;
}

// initializeSecureStorage calls counted at the moment of sign-in (BACKLOG-3555).
let opensAtSignIn = -1;

async function signInAfterRejection(): Promise<void> {
  latest = null;
  opensAtSignIn = -1;
  let signedIn = false;
  render(
    <AuthProvider>
      <AppStateProvider>
        <Probe
          onUnauth={(dispatch) => {
            if (signedIn) return;
            signedIn = true;
            opensAtSignIn = mockApi.system.initializeSecureStorage.mock.calls.length;
            dispatch({ type: "LOGIN_SUCCESS", user, platform: mac, isNewUser: false } as AppAction);
          }}
        />
        <LoadingOrchestrator>
          <div />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>,
  );
  await waitFor(() => expect(signedIn).toBe(true), { timeout: 2000 });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function preValidatedActions(): Array<{ type: string; database?: string }> {
  return [...seenActions].filter((a) => a.type === "AUTH_PRE_VALIDATED");
}

const CLOSED = [
  { valid: false, reason: "offline_grace_expired" },
  { valid: false, reason: "session_clear_failed" },
] as const;

describe("BACKLOG-3321 C7: closed pre-auth route records main's database answer", () => {
  it.each(CLOSED)("$reason, main reports closed -> not opened before sign-in, opened once after", async (rejected) => {
    mockApi.auth.preValidateSession.mockResolvedValue(rejected);
    mockApi.system.isDatabaseInitialized.mockResolvedValue({ success: true, initialized: false });

    await signInAfterRejection();

    expect(mockApi.system.isDatabaseInitialized).toHaveBeenCalledTimes(1);
    expect(opensAtSignIn).toBe(0);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(1);
    expect(preValidatedActions()).toHaveLength(1);
    expect(preValidatedActions()[0].database).toBe("not-initialized");
    expect(latest).toMatchObject({ status: "loading", phase: "loading-user-data", user });
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });

  it.each(CLOSED)("$reason, main reports open (renderer reload) -> reads open", async (rejected) => {
    mockApi.auth.preValidateSession.mockResolvedValue(rejected);
    mockApi.system.isDatabaseInitialized.mockResolvedValue({ success: true, initialized: true });

    await signInAfterRejection();

    expect(mockApi.system.isDatabaseInitialized).toHaveBeenCalledTimes(1);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(0);
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });

  // R6: a failing probe must still dispatch exactly once (never leave the
  // LoadingScreen up) and must never fall through to an optimistic open.
  it.each(CLOSED)("$reason, the probe itself rejects -> unknown, dispatched once, opened only after sign-in", async (rejected) => {
    mockApi.auth.preValidateSession.mockResolvedValue(rejected);
    mockApi.system.isDatabaseInitialized.mockRejectedValue(new Error("ipc down"));

    await signInAfterRejection();

    expect(mockApi.system.isDatabaseInitialized).toHaveBeenCalledTimes(1);
    expect(preValidatedActions()).toHaveLength(1);
    expect(preValidatedActions()[0]).toMatchObject({ valid: false, database: "unknown" });
    expect(opensAtSignIn).toBe(0);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ status: "loading", phase: "loading-user-data", user });
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });

  it("a rejection that cleared the session (token_invalid) does not probe; it opens the DB", async () => {
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: false, reason: "token_invalid" });

    await signInAfterRejection();

    expect(mockApi.system.isDatabaseInitialized).toHaveBeenCalledTimes(0);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(1);
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });
});
