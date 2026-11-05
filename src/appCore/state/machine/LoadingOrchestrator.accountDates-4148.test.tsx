/**
 * BACKLOG-4148 — AuthContext's currentUser (what Account settings renders as
 * "Member since" / "Last login") carries created_at and last_login_at on both
 * ways a user arrives:
 *   R  relaunch: auth:get-current-user -> LoadingOrchestrator -> login()
 *   S  browser sign-in: auth:deep-link-callback -> useLoginHandlers -> login()
 *
 * Harness copied from LoadingOrchestrator.accountRecord-3673 (real AuthProvider,
 * real AppStateProvider/reducer, real LoadingOrchestrator, real useLoginHandlers;
 * only window.api stubbed). Fixtures:
 *   - getCurrentUser result = sessionHandlers.handleGetCurrentUser's return, whose
 *     `user` is the local row (`getUserByIdSync`: SELECT * FROM users_local), so it
 *     carries created_at and last_login_at as SQLite text;
 *   - the deep-link payload = buildDeepLinkAuthPayload's output with `localUser`.
 * No real values.
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { useAppState } from "./useAppState";
import { AuthProvider, useAuth } from "../../../contexts/AuthContext";
import { AppModals } from "../../AppModals";
import { NotificationProvider } from "../../../contexts/NotificationContext";
import { useLoginHandlers } from "../flows/auth/useLoginHandlers";
import type { AppState } from "./types";
import type { AppStateMachine } from "../types";
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
// AppModals' children are mocked so the terms condition is what is observed.
jest.mock("../../../components/WelcomeTerms", () => ({
  __esModule: true,
  default: () => <div data-testid="welcome-terms" />,
}));
jest.mock("../../../components/Settings", () => ({ __esModule: true, default: () => null }));
jest.mock("../../../components/TransactionList", () => ({ __esModule: true, default: () => null }));
jest.mock("../../../components/Contacts", () => ({ __esModule: true, default: () => null }));
jest.mock("../../../components/AuditTransactionModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../../components/MoveAppPrompt", () => ({ __esModule: true, default: () => null }));
jest.mock("../../modals/IPhoneSyncModal", () => ({ IPhoneSyncModal: () => null }));
jest.mock("../../modals/AndroidSyncModal", () => ({ AndroidSyncModal: () => null }));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

const USER = { id: "user-3673", email: "user@example.com" };

const mockApi = {
  auth: {
    getCurrentUser: jest.fn(),
    preValidateSession: jest.fn(),
    // Removed by BACKLOG-3673. Stubbed "completed" ON PURPOSE (C4): a routing
    // copy that still read it would send a not-finished account to the dashboard.
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
  user: {
    getPhoneType: jest.fn(),
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

type Plat = "mac" | "win";
function setPlatform(p: Plat) {
  Object.defineProperty(window.navigator, "platform", {
    value: p === "mac" ? "MacIntel" : "Win32",
    configurable: true,
  });
}
const PLATFORM_INFO = {
  mac: { isMacOS: true, isWindows: false, hasIPhone: false },
  win: { isMacOS: false, isWindows: true, hasIPhone: false },
};

function accountSetup(
  setup: "finished" | "not-finished" | "unknown",
  emailStepAnswered = false,
  contactSourceAnswered = false,
) {
  return { success: true, setup, emailStepAnswered, contactSourceAnswered };
}
function connections(mailbox: boolean) {
  return { success: true, google: { connected: mailbox }, microsoft: { connected: false } };
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform("mac");
  mockApi.user.getAccountSetup = jest.fn();
  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.checkEmailOnboarding.mockResolvedValue({ success: true, completed: true });
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockResolvedValue({ stage: "complete" });
  mockApi.user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
  mockApi.system.checkAllConnections.mockResolvedValue(connections(true));
  mockApi.system.checkPermissions.mockResolvedValue({ hasPermission: false, fullDiskAccess: false });
  mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
  mockApi.drivers.checkApple.mockResolvedValue({ isInstalled: false });
});

let latest: AppState | null = null;
/** Every status the Probe rendered (it unmounts while the error screen shows). */
const history: string[] = [];
beforeEach(() => {
  history.length = 0;
});
function Probe() {
  const { state } = useAppState();
  latest = state;
  history.push(state.status);
  return <div data-testid="status">{state.status}</div>;
}

/** Mirrors useAppStateMachine: AppModals reads terms + user from AuthContext. */
function TermsLayer() {
  const { needsTermsAcceptance, currentUser } = useAuth();
  const base: Record<string, unknown> = {
    needsTermsAcceptance,
    currentUser,
    pendingOAuthData: null,
    isMacOS: true,
    isWindows: false,
    appPath: "/Applications/Keepr.app",
    modalState: {
      showProfile: false,
      showSettings: false,
      showTransactions: false,
      showContacts: false,
      showAuditTransaction: false,
      showVersion: false,
      showMoveAppPrompt: false,
      showTermsModal: false,
      showIPhoneSync: false,
      showAndroidSync: false,
    },
  };
  const app = new Proxy(base, {
    get: (t, k: string) => (k in t ? t[k] : jest.fn()),
  }) as unknown as AppStateMachine;
  // BACKLOG-3594: AppModals now calls useSubmissionStatusNotice, which needs the real
  // NotificationProvider (precedent: AppModals-3594-submission-notice.test.tsx:142).
  return (
    <NotificationProvider>
      <AppModals app={app} />
    </NotificationProvider>
  );
}

/** Sign-in driver: the real useLoginHandlers, fed the main.ts deep-link payload. */
let signIn: ((data: DeepLinkAuthData) => void) | null = null;
function SignInDriver({ plat }: { plat: Plat }) {
  const { login } = useAuth();
  const { dispatch } = useAppState();
  const { handleDeepLinkAuthSuccess } = useLoginHandlers({
    login,
    stateMachineDispatch: dispatch,
    platform: { isMacOS: plat === "mac", isWindows: plat === "win" },
    onSetCurrentStep: () => {},
    setIsNewUserFlow: () => {},
    setPendingOAuthData: () => {},
  });
  signIn = handleDeepLinkAuthSuccess;
  return null;
}

function tree(initial: AppState, plat: Plat = "mac", withSignIn = false) {
  return (
    <AuthProvider>
      <AppStateProvider initialState={initial}>
        {withSignIn && <SignInDriver plat={plat} />}
        <LoadingOrchestrator>
          <Probe />
          <TermsLayer />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );
}

const loadingUserData = (plat: Plat): AppState =>
  ({ status: "loading", phase: "loading-user-data", user: USER, platform: PLATFORM_INFO[plat], database: "initialized" }) as AppState;

async function settle(expected?: string) {
  await waitFor(
    () => {
      expect(screen.getByTestId("status")).toBeInTheDocument();
      if (expected) expect(screen.getByTestId("status").textContent).toBe(expected);
    },
    { timeout: 3000 },
  );
  return screen.getByTestId("status").textContent;
}


const CREATED = "2026-01-02 03:04:05";
const LAST_LOGIN = "2026-11-05 03:30:00";

let seenUser: Record<string, unknown> | null = null;
function UserProbe() {
  const { currentUser } = useAuth();
  seenUser = currentUser as unknown as Record<string, unknown> | null;
  return null;
}
function datesTree(initial: AppState, withSignIn = false) {
  return (
    <AuthProvider>
      <AppStateProvider initialState={initial}>
        {withSignIn && <SignInDriver plat="mac" />}
        <UserProbe />
        <LoadingOrchestrator>
          <Probe />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );
}

describe("BACKLOG-4148 currentUser carries the account dates", () => {
  beforeEach(() => {
    seenUser = null;
  });

  it("R relaunch: currentUser has created_at and last_login_at from auth:get-current-user", async () => {
    mockApi.system.hasEncryptionKeyStore.mockResolvedValue({ success: true, hasKeyStore: true });
    mockApi.auth.preValidateSession.mockResolvedValue({ valid: true });
    mockApi.system.initializeSecureStorage.mockResolvedValue({ success: true, available: true });
    mockApi.auth.getCurrentUser.mockResolvedValue({
      success: true,
      user: { id: USER.id, email: USER.email, created_at: CREATED, last_login_at: LAST_LOGIN },
      sessionToken: "session-token",
      subscription: undefined,
      provider: "google",
      isNewUser: false,
    });
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
    render(datesTree({ status: "loading", phase: "checking-storage", database: "unknown" } as AppState));
    expect(await settle("ready")).toBe("ready");
    expect(seenUser).toEqual(expect.objectContaining({ id: USER.id, created_at: CREATED, last_login_at: LAST_LOGIN }));
  });

  it("S browser sign-in: currentUser has the dates the deep-link payload carries", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
    render(datesTree({ status: "unauthenticated", database: "initialized" } as AppState, true));
    await settle("unauthenticated");
    await act(async () => {
      signIn!({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        userId: USER.id,
        user: { id: USER.id, email: USER.email, name: "Test User", created_at: CREATED, last_login_at: LAST_LOGIN },
        provider: "google",
        isNewUser: false,
      } as unknown as DeepLinkAuthData);
    });
    expect(await settle("ready")).toBe("ready");
    expect(seenUser).toEqual(expect.objectContaining({ id: USER.id, created_at: CREATED, last_login_at: LAST_LOGIN }));
  });
});
