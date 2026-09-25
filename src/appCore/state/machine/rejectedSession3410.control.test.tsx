/**
 * BACKLOG-3410 controls.
 *
 * Route under test: a stored session the server rejects. preAuthValidationHandler
 * deletes it and returns { valid: false, reason: "token_invalid" } (setSession
 * failed) or { valid: false, reason: "session_revoked" } (getUser failed). The
 * user then signs in again. The local database must be opened on that route,
 * and nothing may report it open before it is.
 *
 * Control 3 is the other half: for reasons where the session is still on disk
 * (offline_grace_expired, session_clear_failed, missing/unknown), the DB must
 * stay closed (SOC 2 CC6.1, TASK-2086).
 */
import React, { useContext, useEffect } from "react";
import { render, waitFor, act } from "@testing-library/react";
import { appStateReducer } from "./reducer";
import { selectIsDatabaseInitialized } from "./selectors/databaseSelectors";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider, AppStateContext } from "./AppStateContext";
import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState, AppAction, PlatformInfo, User } from "./types";

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
const mac: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: true };
const win: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };

// Shapes returned over IPC by handlePreAuthValidation (preAuthValidationHandler.ts)
// after the rejected session was deleted. token_invalid is what the desktop gets
// for the server's "Invalid Refresh Token: Refresh Token Not Found" (auth-js
// AuthApiError, code refresh_token_not_found — see pre-auth-validation.test.ts).
const TOKEN_INVALID = { valid: false, reason: "token_invalid" } as const;
const SESSION_REVOKED = { valid: false, reason: "session_revoked" } as const;
type Rejected = typeof TOKEN_INVALID | typeof SESSION_REVOKED;

function run(actions: AppAction[]): AppState[] {
  let s: AppState = { status: "loading", phase: "validating-auth" } as AppState;
  const seen: AppState[] = [];
  for (const a of actions) {
    s = appStateReducer(s, a as never);
    seen.push(s);
  }
  return seen;
}

describe("BACKLOG-3410 control 1 (reducer invariant): no DB-open claim before a successful DB init", () => {
  const cases: Array<[string, Rejected, PlatformInfo, boolean]> = [];
  for (const rej of [TOKEN_INVALID, SESSION_REVOKED]) {
    cases.push(
      [`${rej.reason}, returning user, macOS`, rej, mac, false],
      [`${rej.reason}, new user, macOS`, rej, mac, true],
      [`${rej.reason}, returning user, Windows`, rej, win, false],
      [`${rej.reason}, new user, Windows`, rej, win, true],
    );
  }
  it.each(cases)("%s", (_label, rejected, platform, isNewUser) => {
    const states = run([
      { type: "AUTH_PRE_VALIDATED", ...rejected } as AppAction,
      { type: "LOGIN_SUCCESS", user, platform, isNewUser } as AppAction,
    ]);
    // Nothing on this route has dispatched DB_INIT_COMPLETE(success), so no
    // state along it may claim the database is open.
    const claims = states.map((s) => selectIsDatabaseInitialized(s));
    expect(claims).toEqual([false, false]);
  });
});

// ----- control 2: the orchestrator actually asks main to open the DB -----

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
    checkEmailOnboarding: jest.fn(),
  },
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
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
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({ success: true, hasKeyStore: true });
  mockApi.auth.preValidateSession.mockResolvedValue(TOKEN_INVALID);
  mockApi.system.initializeSecureStorage.mockResolvedValue({ success: true, available: true, platform: "darwin" });
  mockApi.auth.getCurrentUser.mockResolvedValue({ success: false });
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockReturnValue(new Promise(() => {}));
  mockApi.user.getPhoneType.mockReturnValue(new Promise(() => {}));
  mockApi.auth.checkEmailOnboarding.mockReturnValue(new Promise(() => {}));
  mockApi.system.checkAllConnections.mockReturnValue(new Promise(() => {}));
  mockApi.system.checkPermissions.mockReturnValue(new Promise(() => {}));
});

let latest: AppState | null = null;
function Probe({ onUnauth }: { onUnauth: (d: (a: AppAction) => void) => void }) {
  const ctx = useContext(AppStateContext) as unknown as { state: AppState; dispatch: (a: AppAction) => void };
  latest = ctx.state;
  useEffect(() => {
    if (ctx.state.status === "unauthenticated") onUnauth(ctx.dispatch);
  }, [ctx.state.status]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

describe("BACKLOG-3410 control 2 (orchestrator): rejected session then sign-in opens the DB exactly once", () => {
  const cases: Array<[string, Rejected, string, PlatformInfo, boolean]> = [];
  for (const rej of [TOKEN_INVALID, SESSION_REVOKED]) {
    cases.push(
      [`${rej.reason}, macOS, returning user`, rej, "MacIntel", mac, false],
      [`${rej.reason}, macOS, new user`, rej, "MacIntel", mac, true],
      [`${rej.reason}, Windows, returning user`, rej, "Win32", win, false],
      [`${rej.reason}, Windows, new user`, rej, "Win32", win, true],
    );
  }
  it.each(cases)("%s", async (_label, rejected, navPlatform, platform, isNewUser) => {
    Object.defineProperty(window.navigator, "platform", { value: navPlatform, configurable: true });
    mockApi.auth.preValidateSession.mockResolvedValue(rejected);
    latest = null;
    let signedIn = false;
    render(
      <AuthProvider>
        <AppStateProvider>
          <Probe
              onUnauth={(dispatch) => {
                if (signedIn) return;
                signedIn = true;
                // What useAuthFlow dispatches on the deep-link success event.
                dispatch({ type: "LOGIN_SUCCESS", user, platform, isNewUser } as AppAction);
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
    expect(mockApi.auth.preValidateSession).toHaveBeenCalledTimes(1);
    expect(mockApi.system.initializeSecureStorage).toHaveBeenCalledTimes(1);
    expect(latest && selectIsDatabaseInitialized(latest)).toBe(true);
  });
});

// ----- control 3: a rejection that leaves the session on disk keeps the DB closed -----
// offline_grace_expired: preAuthValidationHandler does not clear the session.
// session_clear_failed: the delete failed. Missing / unknown: fail closed.
// Routing any of these to initializing-db would let Phase 3 load the stale
// session with the DB decrypted (SOC 2 CC6.1, TASK-2086).
describe("BACKLOG-3410 control 3 (reducer): only rejections with the session cleared open the DB", () => {
  const closedCases: Array<[string, AppAction]> = [
    ["offline_grace_expired", { type: "AUTH_PRE_VALIDATED", valid: false, reason: "offline_grace_expired" } as AppAction],
    ["session_clear_failed", { type: "AUTH_PRE_VALIDATED", valid: false, reason: "session_clear_failed" } as AppAction],
    ["reason omitted", { type: "AUTH_PRE_VALIDATED", valid: false } as AppAction],
    ["unknown reason", { type: "AUTH_PRE_VALIDATED", valid: false, reason: "something_new" } as AppAction],
  ];
  it.each(closedCases)("%s stays unauthenticated with the DB closed", (_label, action) => {
    const [s1] = run([action]);
    expect(s1.status).toBe("unauthenticated");
    expect(selectIsDatabaseInitialized(s1)).toBe(false);
  });

  it.each([[TOKEN_INVALID], [SESSION_REVOKED]])("%o proceeds to initializing-db", (rejected) => {
    const [s1] = run([{ type: "AUTH_PRE_VALIDATED", ...rejected } as AppAction]);
    expect(s1).toEqual({ status: "loading", phase: "initializing-db" });
  });
});
