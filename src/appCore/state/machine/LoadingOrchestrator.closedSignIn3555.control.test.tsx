/**
 * BACKLOG-3555 control P-ORCH: on the closed-database pre-auth route, a fresh
 * sign-in opens the database exactly once, only after the sign-in, and carries
 * the signed-in user to user-data loading (Phase 3 never re-reads the session
 * file). A renderer reload does not open a second time; a failed open lands on
 * the recoverable DB_INIT_FAILED error.
 *
 * Harness copied from LoadingOrchestrator.databaseProbe.test.tsx (BACKLOG-3321
 * C7). Fixture provenance:
 * - preValidateSession results: electron/handlers/preAuthValidationHandler.ts
 *   :184 `{ valid: false, reason: "session_clear_failed" }` and :255
 *   `{ valid: false, reason: "offline_grace_expired" }`.
 * - isDatabaseInitialized result: systemHandlers.ts returns
 *   `{ success: true, initialized: databaseService.isInitialized() }`; a
 *   rejected call is read as "unknown" (LoadingOrchestrator.tsx probeDatabase
 *   :75-84). `initialized: true` on this route is a renderer reload.
 * - initializeSecureStorage failure: systemHandlers.ts:744-750 catch return.
 * - LOGIN_SUCCESS: src/appCore/state/flows/auth/useLoginHandlers.ts:44-46
 *   (hasIPhone false, isNewUser present).
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

const CLOSED = [
  { valid: false, reason: "offline_grace_expired" },
  { valid: false, reason: "session_clear_failed" },
] as const;

let opensAtSignIn = -1;
async function signInRecordingOpens(platform: PlatformInfo): Promise<void> {
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
            dispatch({ type: "LOGIN_SUCCESS", user, platform, isNewUser: false } as AppAction);
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

const win: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };
const PROBE_ANSWERS = [
  { label: "closed", answer: () => mockApi.system.isDatabaseInitialized.mockResolvedValue({ success: true, initialized: false }) },
  { label: "probe fails", answer: () => mockApi.system.isDatabaseInitialized.mockRejectedValue(new Error("ipc down")) },
];
const ORCH: Array<[string, (typeof CLOSED)[number], (typeof PROBE_ANSWERS)[number], PlatformInfo]> = [];
for (const r of CLOSED) for (const a of PROBE_ANSWERS) for (const [pn, p] of [["mac", mac], ["win", win]] as const)
  ORCH.push([`${r.reason}/${a.label}/${pn}`, r, a, p]);

describe("BACKLOG-3555 P-ORCH: closed-route sign-in opens the DB once, after sign-in, as the signed-in user", () => {
  it.each(ORCH)("%s", async (_l, rejected, a, p) => {
    mockApi.auth.preValidateSession.mockResolvedValue(rejected);
    a.answer();
    await signInRecordingOpens(p);
    expect(opensAtSignIn).toBe(0); // CC6.1: never opened before a fresh sign-in
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(1);
    // Phase 3 (session-file identity) never runs: AuthContext also calls getCurrentUser on mount, so count AUTH_LOADED instead.
    expect([...seenActions].filter((x) => x.type === "AUTH_LOADED")).toHaveLength(0);
    expect(latest).toMatchObject({ status: "loading", phase: "loading-user-data", user, platform: p, database: "initialized" });
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });

  it("renderer reload (main reports open): no second open", async () => {
    mockApi.auth.preValidateSession.mockResolvedValue(CLOSED[0]);
    mockApi.system.isDatabaseInitialized.mockResolvedValue({ success: true, initialized: true });
    await signInRecordingOpens(mac);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(0);
    expect(latest).toMatchObject({ status: "loading", phase: "loading-user-data", user });
  });

  it("open fails -> recoverable error screen, not a spinner", async () => {
    mockApi.auth.preValidateSession.mockResolvedValue(CLOSED[0]);
    mockApi.system.isDatabaseInitialized.mockResolvedValue({ success: true, initialized: false });
    // systemHandlers.ts:744-750 catch return.
    mockApi.system.initializeSecureStorage.mockResolvedValue({
      success: false,
      available: false,
      platform: "darwin",
      guidance: "To enable secure storage on macOS:", // first line of getSecureStorageGuidance("darwin")
      error: "keychain denied",
    });
    await signInRecordingOpens(mac);
    expect(opensAtSignIn).toBe(0);
    expect(latest).toMatchObject({ status: "error", recoverable: true, error: { code: "DB_INIT_FAILED" } });
  });
});
