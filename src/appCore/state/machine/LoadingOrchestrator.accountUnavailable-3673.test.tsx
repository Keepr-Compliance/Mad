/**
 * BACKLOG-3673 — when the account's setup record cannot be read, the app shows
 * "Couldn't load your account settings" with Retry and Sign out. It never
 * routes to setup and never to the dashboard.
 *
 * Real AuthProvider + real AppStateProvider/reducer + real LoadingOrchestrator
 * + real ErrorScreen. Only `window.api` is stubbed. IPC results are transcribed
 * from the producers:
 *   - user:get-account-setup -> accountSetupHandlers.getAccountSetup's return
 *     (`{ success, setup, emailStepAnswered, contactSourceAnswered }`)
 *   - auth:get-current-user (relaunch) -> sessionHandlers.handleGetCurrentUser:
 *     the success shape `{ success, user, sessionToken, subscription, provider,
 *     isNewUser }`, and the Supabase-session fallback (`:1093-1106`), which
 *     returns `{ success, user: { id, email, display_name } }` with NO
 *     sessionToken
 *   - auth:deep-link-callback (sign-in) -> driven through the real
 *     useLoginHandlers.handleDeepLinkAuthSuccess
 * No real values.
 *
 * Controls:
 *   R1/R2  server "unknown", bridge missing, IPC rejects, success:false
 *          -> the screen, Retry + Sign out, no Reset App Data, never setup
 *   R3     Retry re-reads: unknown then finished -> dashboard (sign-in path)
 *   R3-relaunch  the same on the relaunch path, and Retry re-runs Phase 4
 *          only (Phases 1-3 are not repeated)
 *   R4     Retry fails twice -> the same screen each time, never setup
 *   R5     Retry then not-finished -> setup (Retry does not force the dashboard)
 *   R6     Sign out with a session token -> auth.logout(token), sign-in screen
 *   R6b    Sign out with NO session token (relaunch fallback) -> auth.forceLogout,
 *          sign-in screen
 *   R7     Phase 4 itself throws (loadUserData rejects) -> the screen, never setup
 *   R8     a recoverable error with another code keeps Try Again + Reset App
 *          Data and has no Sign out
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { useAppState } from "./useAppState";
import { AuthProvider, useAuth } from "../../../contexts/AuthContext";
import { useLoginHandlers } from "../flows/auth/useLoginHandlers";
import type { AppState } from "./types";
import type { DeepLinkAuthData } from "../../../components/Login";

jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../../components/support/SupportWidget", () => ({ SupportWidget: () => null }));
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

const USER = { id: "user-3673", email: "user@example.com" };
const PLATFORM = { isMacOS: true, isWindows: false, hasIPhone: false };

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
    logout: jest.fn(),
    forceLogout: jest.fn(),
  },
  system: {
    hasEncryptionKeyStore: jest.fn(),
    initializeSecureStorage: jest.fn(),
    onInitStage: jest.fn(),
    getInitStage: jest.fn(),
    checkAllConnections: jest.fn(),
    checkPermissions: jest.fn(),
  },
  user: {
    getPhoneType: jest.fn() as jest.Mock | undefined,
    getAccountSetup: jest.fn() as jest.Mock | undefined,
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

const ok = (setup: "finished" | "not-finished" | "unknown") => ({
  success: true,
  setup,
  emailStepAnswered: false,
  contactSourceAnswered: false,
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  mockApi.user.getAccountSetup = jest.fn();
  mockApi.user.getPhoneType = jest.fn().mockResolvedValue({ success: true, phoneType: "iphone" });
  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.logout.mockResolvedValue({ success: true });
  mockApi.auth.forceLogout.mockResolvedValue({ success: true });
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockResolvedValue({ stage: "complete" });
  mockApi.system.checkAllConnections.mockResolvedValue({
    success: true,
    google: { connected: true },
    microsoft: { connected: false },
  });
  mockApi.system.checkPermissions.mockResolvedValue({ hasPermission: false, fullDiskAccess: false });
  mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
  mockApi.drivers.checkApple.mockResolvedValue({ isInstalled: false });
});

/** Relaunch: Phases 1-3 resolve (shapes as in accountRecord-3673 C6). */
function arrangeRelaunch(currentUser: Record<string, unknown>) {
  mockApi.system.hasEncryptionKeyStore.mockResolvedValue({ success: true, hasKeyStore: true });
  mockApi.auth.preValidateSession.mockResolvedValue({ valid: true });
  mockApi.system.initializeSecureStorage.mockResolvedValue({ success: true, available: true });
  mockApi.auth.getCurrentUser.mockResolvedValue(currentUser);
}

/** handleGetCurrentUser success shape. */
const CURRENT_USER_OK = {
  success: true,
  user: { id: USER.id, email: USER.email },
  sessionToken: "session-token-3673",
  subscription: undefined,
  provider: "google",
  isNewUser: false,
};
/** handleGetCurrentUser Supabase-session fallback: no sessionToken. */
const CURRENT_USER_FALLBACK = {
  success: true,
  user: { id: USER.id, email: USER.email, display_name: USER.email },
};

let latest: AppState | null = null;
/** Every status the Probe rendered (it unmounts while the error screen shows). */
const history: string[] = [];
beforeEach(() => {
  history.length = 0;
  latest = null;
});
function Probe() {
  const { state } = useAppState();
  latest = state;
  history.push(state.status);
  return <div data-testid="status">{state.status}</div>;
}

let signIn: ((data: DeepLinkAuthData) => void) | null = null;
function SignInDriver() {
  const { login } = useAuth();
  const { dispatch } = useAppState();
  const { handleDeepLinkAuthSuccess } = useLoginHandlers({
    login,
    stateMachineDispatch: dispatch,
    platform: { isMacOS: true, isWindows: false },
    onSetCurrentStep: () => {},
    setIsNewUserFlow: () => {},
    setPendingOAuthData: () => {},
  });
  signIn = handleDeepLinkAuthSuccess;
  return null;
}

function tree(initial: AppState, withSignIn = false) {
  return (
    <AuthProvider>
      <AppStateProvider initialState={initial}>
        {withSignIn && <SignInDriver />}
        <LoadingOrchestrator>
          <Probe />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );
}

const loadingUserData = (): AppState =>
  ({ status: "loading", phase: "loading-user-data", user: USER, platform: PLATFORM }) as AppState;
const relaunch = (): AppState => ({ status: "loading", phase: "checking-storage" }) as AppState;

const TITLE = "Couldn't load your account settings";
const findTitle = () => screen.findByText(TITLE, undefined, { timeout: 3000 });

describe("BACKLOG-3673 — the record could not be read: Retry / Sign out, never setup", () => {
  it.each([
    ["server unknown", () => mockApi.user.getAccountSetup!.mockResolvedValue(ok("unknown"))],
    ["bridge missing", () => { mockApi.user.getAccountSetup = undefined; }],
    ["IPC rejects", () => mockApi.user.getAccountSetup!.mockRejectedValue(new Error("ipc down"))],
    ["success:false", () => mockApi.user.getAccountSetup!.mockResolvedValue({ success: false })],
  ])("R1/R2 %s -> the screen with Retry and Sign out; never setup", async (_n, arrange) => {
    arrange();
    render(tree(loadingUserData()));
    expect(await findTitle()).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keepr couldn't reach the server to check your account. Check your internet connection, then try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contact Support" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset App Data/ })).toBeNull();
    expect(history).not.toContain("onboarding");
    expect(history).not.toContain("ready");
  });

  it("R3 Retry re-reads: unknown then finished -> dashboard", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValueOnce(ok("unknown")).mockResolvedValueOnce(ok("finished"));
    render(tree(loadingUserData()));
    await findTitle();
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(latest?.status).toBe("ready"), { timeout: 3000 });
    expect(mockApi.user.getAccountSetup).toHaveBeenCalledTimes(2);
    expect(history).not.toContain("onboarding");
  });

  it("R3-relaunch Retry re-reads on the relaunch path and re-runs Phase 4 only", async () => {
    arrangeRelaunch(CURRENT_USER_OK);
    mockApi.user.getAccountSetup!.mockResolvedValueOnce(ok("unknown")).mockResolvedValueOnce(ok("finished"));
    render(tree(relaunch()));
    await findTitle();
    // Phase 3 may read the user more than once on the way in; what matters is
    // that Retry adds no read.
    const userReadsBeforeRetry = mockApi.auth.getCurrentUser.mock.calls.length;
    expect(userReadsBeforeRetry).toBeGreaterThan(0);
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(latest?.status).toBe("ready"), { timeout: 3000 });
    expect(mockApi.user.getAccountSetup).toHaveBeenCalledTimes(2);
    // Retry returns to Phase 4 with the user context; it does not restart the app.
    expect(mockApi.auth.getCurrentUser).toHaveBeenCalledTimes(userReadsBeforeRetry);
    expect(history).not.toContain("onboarding");
  });

  it("R4 Retry fails again -> the same screen, still never setup", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(ok("unknown"));
    render(tree(loadingUserData()));
    await findTitle();
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(mockApi.user.getAccountSetup).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(await findTitle()).toBeInTheDocument();
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(mockApi.user.getAccountSetup).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(await findTitle()).toBeInTheDocument();
    expect(history).not.toContain("onboarding");
  });

  it("R5 Retry then not-finished -> setup (Retry re-reads; it does not force the dashboard)", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValueOnce(ok("unknown")).mockResolvedValueOnce(ok("not-finished"));
    render(tree(loadingUserData()));
    await findTitle();
    act(() => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(latest?.status).toBe("onboarding"), { timeout: 3000 });
  });

  it("R6 Sign out with a session token -> auth.logout(token), then the sign-in screen", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(ok("unknown"));
    render(tree({ status: "unauthenticated" } as AppState, true));
    await act(async () => {
      signIn!({
        accessToken: "tok-3673",
        refreshToken: "r",
        userId: USER.id,
        user: { id: USER.id, email: USER.email, name: "T" },
        provider: "google",
        isNewUser: false,
      } as unknown as DeepLinkAuthData);
    });
    await findTitle();
    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });
    await waitFor(() => expect(latest?.status).toBe("unauthenticated"), { timeout: 3000 });
    expect(mockApi.auth.logout).toHaveBeenCalledWith("tok-3673");
    expect(mockApi.auth.forceLogout).not.toHaveBeenCalled();
    expect(history).not.toContain("onboarding");
  });

  it("R6b Sign out with NO session token (relaunch fallback) -> auth.forceLogout, then the sign-in screen", async () => {
    arrangeRelaunch(CURRENT_USER_FALLBACK);
    mockApi.user.getAccountSetup!.mockResolvedValue(ok("unknown"));
    render(tree(relaunch()));
    await findTitle();
    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });
    await waitFor(() => expect(latest?.status).toBe("unauthenticated"), { timeout: 3000 });
    expect(mockApi.auth.forceLogout).toHaveBeenCalledTimes(1);
    expect(mockApi.auth.logout).not.toHaveBeenCalled();
    expect(history).not.toContain("onboarding");
  });

  it("R7 Phase 4 itself throws (getPhoneType bridge missing) -> the screen, never setup", async () => {
    // Synchronous TypeError inside the Promise.all array -> loadUserData
    // rejects -> the catch fallback.
    mockApi.user.getPhoneType = undefined;
    mockApi.user.getAccountSetup!.mockResolvedValue(ok("not-finished"));
    render(tree(loadingUserData()));
    expect(await findTitle()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(history).not.toContain("onboarding");
  });

  it("R8 a recoverable error with another code keeps Try Again and Reset App Data, no Sign out", async () => {
    render(
      tree({
        status: "error",
        error: { code: "DB_INIT_FAILED", message: "db init failed" },
        recoverable: true,
        previousState: { status: "loading", phase: "checking-storage" },
      } as AppState),
    );
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset App Data" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});
