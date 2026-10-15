/**
 * BACKLOG-3888 — the recorded email providers (cloud preferences.emailProviders)
 * reach renderer state through the bounded account-setup read, on every
 * platform, and the ResumeSetupBanner keeps its ORIGINAL floor-only rule: a
 * recorded provider does NOT bring it up for a user with a texts source (the
 * founder's surface for that case is the amber SystemHealthMonitor strip).
 *
 * End-to-end over the REAL renderer path: LoadingOrchestrator Phase 4 reads
 * the account-setup read (which carries the cloud preferences.emailProviders
 * under its 8 s bound) and the connection check, the
 * reducer builds `ready`, and the REAL ResumeSetupBanner decides from that
 * state. Only window.api is simulated.
 *
 * FIXTURE PROVENANCE (transcribed, not invented):
 *   user:get-account-setup accountSetupHandlers.ts getAccountSetup -> { success, setup, emailStepAnswered,
 *                          contactSourceAnswered, emailProviders } (emailProviders absent on the
 *                          timeout/cache path)
 *   emailProviders value   electron/services/emailProviderRecord.ts (["outlook"], ["outlook","gmail"])
 *   preferences:get        preferenceHandlers.ts:30-49 -> { success: true, preferences } (macOS only)
 *   system:check-all-connections  systemHandlers.ts:1166-1170 -> { success: true, ...checkAllConnections() }
 *     not connected        connectionStatusService.ts:~131 { connected: false, error: { type: "NOT_CONNECTED" } }
 *   user:get-phone-type    userSettingsHandlers.ts:80-83 -> { success: true, phoneType }
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { useAppState } from "./useAppState";
import { AuthProvider } from "../../../contexts/AuthContext";
import { ResumeSetupBanner } from "../../../components/setup/ResumeSetupBanner";
import type { AppState } from "./types";
import type { AppStateMachine } from "../types";

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
  error: { type: "NOT_CONNECTED", userMessage: "Outlook is not connected" },
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

const baseUser = { id: "user-3888", email: "user@example.com" };
const macOS = { isMacOS: true, isWindows: false, hasIPhone: false };
const windows = { isMacOS: false, isWindows: true, hasIPhone: false };
type Platform = typeof macOS;

function arrange(opts: {
  platform: Platform;
  phoneType: "iphone" | "android" | null;
  /** Recorded providers in the bag, or "unreadable" (timeout / cache path). */
  emailProviders: string[] | "unreadable";
  microsoft?: unknown;
  google?: unknown;
  fdaGranted?: boolean;
}): void {
  Object.defineProperty(window.navigator, "platform", {
    value: opts.platform.isMacOS ? "MacIntel" : "Win32",
    configurable: true,
  });
  mockApi.drivers.checkApple.mockResolvedValue({ isInstalled: true });
  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockResolvedValue({ stage: "complete" });
  mockApi.user.getPhoneType.mockResolvedValue({ success: true, phoneType: opts.phoneType });
  mockApi.system.checkAllConnections.mockResolvedValue({
    success: true,
    google: opts.google ?? { ...NOT_CONNECTED, error: { type: "NOT_CONNECTED", userMessage: "Gmail is not connected" } },
    microsoft: opts.microsoft ?? NOT_CONNECTED,
  });
  mockApi.system.checkPermissions.mockResolvedValue({
    hasPermission: opts.fdaGranted === true,
    fullDiskAccess: opts.fdaGranted === true,
  });
  mockApi.user.getAccountSetup.mockResolvedValue({
    success: true,
    setup: "finished",
    emailStepAnswered: true,
    contactSourceAnswered: true,
    ...(opts.emailProviders === "unreadable" ? {} : { emailProviders: opts.emailProviders }),
  });
  // The FDA-decline read (macOS only). It does not carry emailProviders.
  mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
}


function Probe() {
  const { state } = useAppState();
  return (
    <>
      <div data-testid="status">{state.status}</div>
      <div data-testid="recorded">
        {state.status === "ready" ? String(state.userData.hasRecordedEmailProvider === true) : "n/a"}
      </div>
    </>
  );
}

const app = {
  showSetupPromptDismissed: false,
  goToEmailOnboarding: jest.fn(),
  handleDismissSetupPrompt: jest.fn(),
} as unknown as AppStateMachine;

async function load(platform: Platform): Promise<void> {
  render(
    <AuthProvider>
      <AppStateProvider
        initialState={{ status: "loading", phase: "loading-user-data", user: baseUser, platform } as AppState}
      >
        <LoadingOrchestrator>
          <Probe />
          <ResumeSetupBanner app={app} />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>,
  );
  // PRECONDITION: the load finished and reached the main app.
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"), {
    timeout: 3000,
  });
}

const recorded = () => screen.getByTestId("recorded").textContent;
const banner = () => screen.queryByTestId("resume-setup-banner");

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each<[string, Platform]>([
  ["Windows", windows],
  ["macOS", macOS],
])("BACKLOG-3888 — recorded providers reach renderer state (%s)", (_name, platform) => {
  it.each<[string, string[] | "unreadable", string]>([
    ["one provider -> recorded", ["outlook"], "true"],
    ["two providers -> recorded", ["outlook", "gmail"], "true"],
    ["empty set -> not recorded", [], "false"],
    ["unreadable (timeout / cache path) -> not recorded", "unreadable", "false"],
  ])("%s", async (_n, emailProviders, expected) => {
    arrange({ platform, phoneType: "iphone", emailProviders });
    await load(platform);
    expect(recorded()).toBe(expected);
  });

  it("ResumeSetupBanner is back to the floor-only rule: recorded provider + no mailbox + texts source -> NO banner", async () => {
    arrange({ platform, phoneType: "iphone", fdaGranted: true, emailProviders: ["outlook"] });
    await load(platform);
    expect(recorded()).toBe("true"); // PRECONDITION: the record did arrive
    expect(banner()).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3888 — startup is not held by the preferences read", () => {
  it("Windows: a hung preferences read does not hold startup (the bag arrives via the bounded account-setup read)", async () => {
    arrange({ platform: windows, phoneType: "iphone", emailProviders: ["outlook"] });
    mockApi.preferences.get.mockReturnValue(new Promise(() => {}));
    await load(windows);
    expect(recorded()).toBe("true");
  });
});
