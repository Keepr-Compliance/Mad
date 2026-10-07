/**
 * BACKLOG-3673 — Phase 4 + the reducer route on ONE thing: the account record.
 *
 * Real AuthProvider + real AppStateProvider/reducer + real LoadingOrchestrator.
 * Only `window.api` is stubbed. IPC results are transcribed from the producers:
 *   - user:get-account-setup -> accountSetupHandlers.getAccountSetup's return
 *   - system:check-all-connections -> { success, google:{connected}, microsoft:{connected} }
 *   - system:check-permissions -> { hasPermission, fullDiskAccess }
 *   - preferences:get -> { success, preferences }
 *   - auth:get-current-user (relaunch) -> sessionHandlers.handleGetCurrentUser's
 *     return, where `isNewUser: needsToAcceptTerms(user, cloudUser)`
 *   - auth:deep-link-callback (sign-in) -> the payload main.ts sends, where
 *     `isNewUser: needsTermsAcceptance` (driven through the real
 *     useLoginHandlers.handleDeepLinkAuthSuccess)
 * No real values.
 *
 * Controls:
 *   C2  half-finished account (email answered, mailbox connected) -> setup,
 *       macOS with FDA still to ask (C8a: `permissions` NOT answered) and Windows
 *   C3  finished record + no mailbox + no FDA + driver missing -> dashboard
 *   C4  a "completed" email answer + a connected mailbox never route: not-finished -> setup
 *   C5  finished record, mailbox disconnected -> dashboard (relaunch), and a
 *       disconnect while on the dashboard never re-routes
 *   C6  outdated terms never re-run setup: finished + isNewUser (relaunch AND
 *       sign-in, mac AND win) -> dashboard WITH the terms screen
 *   C7  outdated terms are never skipped: the terms screen is up over the
 *       dashboard; an unfinished account gets it over setup (row 17)
 *   row 20  no record readable (bridge missing / rejected) -> the
 *           "Couldn't load your account settings" screen, never setup
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
jest.mock("../../../components/Profile", () => ({ __esModule: true, default: () => null }));
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
  ({ status: "loading", phase: "loading-user-data", user: USER, platform: PLATFORM_INFO[plat] }) as AppState;

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

describe("C2 / C8a — a half-finished account stays in setup", () => {
  it("macOS: email answered, mailbox connected, FDA not asked -> setup, and FDA is still to ask", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("not-finished", true, true));
    render(tree(loadingUserData("mac")));
    expect(await settle("onboarding")).toBe("onboarding");
    if (latest?.status !== "onboarding") throw new Error("expected onboarding");
    // C8a: assert on what the queue is seeded with, never the legacy `step`.
    expect(latest.completedSteps).not.toContain("permissions");
    expect(latest.accountAnswers).toEqual({ contactSource: true, emailStep: true });
  });

  it("Windows twin: same answers -> setup, never the dashboard", async () => {
    setPlatform("win");
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("not-finished", true, true));
    render(tree(loadingUserData("win"), "win"));
    expect(await settle("onboarding")).toBe("onboarding");
  });
});

describe("C3 — a finished account lands on the dashboard whatever the device says", () => {
  it.each<Plat>(["mac", "win"])("%s: finished + no mailbox + no FDA + driver missing -> ready", async (plat) => {
    setPlatform(plat);
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
    mockApi.system.checkAllConnections.mockResolvedValue(connections(false));
    render(tree(loadingUserData(plat), plat));
    expect(await settle("ready")).toBe("ready");
  });
});

describe("C4 — no routing copy left behind", () => {
  it("email answer 'completed' + a connected mailbox, record empty -> setup", async () => {
    mockApi.auth.checkEmailOnboarding.mockResolvedValue({ success: true, completed: true });
    mockApi.system.checkAllConnections.mockResolvedValue(connections(true));
    mockApi.system.checkPermissions.mockResolvedValue({ hasPermission: true, fullDiskAccess: true });
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("not-finished", true, true));
    render(tree(loadingUserData("mac")));
    expect(await settle("onboarding")).toBe("onboarding");
  });
});

describe("C5 — a mailbox disconnect never restarts setup (BACKLOG-3338)", () => {
  it("relaunch with a finished record and no mailbox -> ready; a later disconnect stays ready", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
    mockApi.system.checkAllConnections.mockResolvedValue(connections(false));
    let dispatchRef: ((a: never) => void) | null = null;
    function Grab() {
      dispatchRef = useAppState().dispatch as never;
      return null;
    }
    render(
      <AuthProvider>
        <AppStateProvider initialState={loadingUserData("mac")}>
          <Grab />
          <LoadingOrchestrator>
            <Probe />
          </LoadingOrchestrator>
        </AppStateProvider>
      </AuthProvider>,
    );
    expect(await settle("ready")).toBe("ready");
    await act(async () => {
      dispatchRef!({ type: "EMAIL_DISCONNECTED", provider: "google" } as never);
    });
    expect(latest?.status).toBe("ready");
  });
});

describe("row 20 — no readable record -> the account-settings screen, never setup", () => {
  const TITLE = "Couldn't load your account settings";

  it("bridge method missing -> account-settings screen", async () => {
    mockApi.user.getAccountSetup = undefined;
    render(tree(loadingUserData("mac")));
    expect(await screen.findByText(TITLE, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(history).not.toContain("onboarding");
  });

  it("IPC rejects -> account-settings screen", async () => {
    mockApi.user.getAccountSetup!.mockRejectedValue(new Error("ipc down"));
    render(tree(loadingUserData("mac")));
    expect(await screen.findByText(TITLE, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(history).not.toContain("onboarding");
  });
});

describe("C6 / C7 — outdated terms: terms screen only, never setup, never skipped", () => {
  it.each<Plat>(["mac", "win"])(
    "%s relaunch: finished + needsToAcceptTerms -> ready WITH the terms screen",
    async (plat) => {
      setPlatform(plat);
      mockApi.system.hasEncryptionKeyStore.mockResolvedValue({ success: true, hasKeyStore: true });
      mockApi.auth.preValidateSession.mockResolvedValue({ valid: true });
      mockApi.system.initializeSecureStorage.mockResolvedValue({ success: true, available: true });
      // sessionHandlers.handleGetCurrentUser: { success, user, sessionToken,
      // subscription, provider, isNewUser: needsToAcceptTerms(...) }
      mockApi.auth.getCurrentUser.mockResolvedValue({
        success: true,
        user: { id: USER.id, email: USER.email },
        sessionToken: "session-token",
        subscription: undefined,
        provider: "google",
        isNewUser: true,
      });
      mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
      render(tree({ status: "loading", phase: "checking-storage" } as AppState, plat));
      expect(await settle("ready")).toBe("ready");
      expect(screen.getByTestId("welcome-terms")).toBeInTheDocument();
    },
  );

  it.each<Plat>(["mac", "win"])(
    "%s sign-in: finished + deep-link isNewUser -> ready WITH the terms screen (new computer, no cache)",
    async (plat) => {
      setPlatform(plat);
      mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
      render(tree({ status: "unauthenticated" } as AppState, plat, true));
      await settle("unauthenticated");
      // main.ts auth:deep-link-callback payload, isNewUser: needsTermsAcceptance
      await act(async () => {
        signIn!({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          userId: USER.id,
          user: { id: USER.id, email: USER.email, name: "Test User" },
          provider: "google",
          licenseStatus: undefined,
          device: undefined,
          isNewUser: true,
        } as unknown as DeepLinkAuthData);
      });
      expect(await settle("ready")).toBe("ready");
      expect(screen.getByTestId("welcome-terms")).toBeInTheDocument();
    },
  );

  it("CONTROL: terms current -> ready WITHOUT the terms screen", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("finished", true, true));
    render(tree({ status: "unauthenticated" } as AppState, "mac", true));
    await settle("unauthenticated");
    await act(async () => {
      signIn!({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        userId: USER.id,
        user: { id: USER.id, email: USER.email, name: "Test User" },
        provider: "google",
        isNewUser: false,
      } as unknown as DeepLinkAuthData);
    });
    expect(await settle("ready")).toBe("ready");
    expect(screen.queryByTestId("welcome-terms")).not.toBeInTheDocument();
  });

  it("row 17: unfinished + outdated terms -> setup WITH the terms screen", async () => {
    mockApi.user.getAccountSetup!.mockResolvedValue(accountSetup("not-finished", false, true));
    render(tree({ status: "unauthenticated" } as AppState, "mac", true));
    await settle("unauthenticated");
    await act(async () => {
      signIn!({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        userId: USER.id,
        user: { id: USER.id, email: USER.email, name: "Test User" },
        provider: "google",
        isNewUser: true,
      } as unknown as DeepLinkAuthData);
    });
    expect(await settle("onboarding")).toBe("onboarding");
    expect(screen.getByTestId("welcome-terms")).toBeInTheDocument();
  });
});
