/**
 * BACKLOG-3888 — a returning user who chose email gets the setup banner when
 * no mailbox is connected, whatever texts sources they have.
 *
 * End-to-end over the REAL renderer path: LoadingOrchestrator Phase 4 reads
 * the cloud preferences bag (preferences:get) and the connection check, the
 * reducer builds `ready`, and the REAL ResumeSetupBanner decides from that
 * state. Only window.api is simulated.
 *
 * FIXTURE PROVENANCE (transcribed, not invented):
 *   preferences:get        preferenceHandlers.ts:30-49 -> { success: true, preferences }
 *   emailProviders value   electron/services/emailProviderRecord.ts (["outlook"], ["outlook","gmail"])
 *   system:check-all-connections  systemHandlers.ts:1166-1170 -> { success: true, ...checkAllConnections() }
 *     not connected        connectionStatusService.ts:~131 { connected: false, error: { type: "NOT_CONNECTED" } }
 *     refresh failed       connectionStatusService.ts:215-227 { connected: false, email, error: { type: "TOKEN_REFRESH_FAILED", ... } }
 *   user:get-account-setup readAccountSetup.ts -> { success, setup, emailStepAnswered, contactSourceAnswered }
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
const CONNECTED = { connected: true, email: "broker@example.com", error: null };
const REFRESH_FAILED = {
  connected: false,
  email: "broker@example.com",
  error: {
    type: "TOKEN_REFRESH_FAILED",
    userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
    action: "Reconnect",
    actionHandler: "reconnect-microsoft",
    details: "Failed to refresh authentication token",
  },
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
    getAccountSetup: jest.fn(async () => ({
      success: true,
      setup: "finished",
      emailStepAnswered: true,
      contactSourceAnswered: true,
    })),
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
  preferences: Record<string, unknown> | "reject";
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
  if (opts.preferences === "reject") {
    mockApi.preferences.get.mockRejectedValue(new Error("supabase unreachable"));
  } else {
    mockApi.preferences.get.mockResolvedValue({ success: true, preferences: opts.preferences });
  }
}

function Status() {
  const { state } = useAppState();
  return <div data-testid="status">{state.status}</div>;
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
          <Status />
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

const banner = () => screen.queryByTestId("resume-setup-banner");

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each<[string, Platform]>([
  ["Windows", windows],
  ["macOS", macOS],
])("BACKLOG-3888 — chose email, no mailbox (%s)", (_name, platform) => {
  it.each<["iphone" | "android" | null]>([["iphone"], ["android"], [null]])(
    "recorded provider + no mailbox + phoneType %s -> banner",
    async (phoneType) => {
      arrange({ platform, phoneType, preferences: { emailProviders: ["outlook"] } });
      await load(platform);
      expect(banner()).toBeInTheDocument();
      expect(mockApi.preferences.get).toHaveBeenCalledWith(baseUser.id);
    },
  );

  it("recorded provider + no mailbox + texts source present -> banner (texts do not hide it)", async () => {
    arrange({
      platform,
      phoneType: "iphone",
      fdaGranted: true,
      preferences: { emailProviders: ["outlook", "gmail"] },
    });
    await load(platform);
    expect(banner()).toBeInTheDocument();
  });

  it("recorded provider + a mailbox connected -> no banner", async () => {
    arrange({
      platform,
      phoneType: "iphone",
      preferences: { emailProviders: ["outlook"] },
      microsoft: CONNECTED,
    });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });

  it("two recorded providers, only one connected -> no banner", async () => {
    arrange({
      platform,
      phoneType: "iphone",
      preferences: { emailProviders: ["outlook", "gmail"] },
      google: CONNECTED,
    });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });

  it("NO recorded provider + no mailbox + phoneType iphone -> no banner (texts-only user is not nagged)", async () => {
    arrange({ platform, phoneType: "iphone", preferences: {} });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });

  it("empty recorded set -> no banner", async () => {
    arrange({ platform, phoneType: "android", preferences: { emailProviders: [] } });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });

  it("preferences unreadable -> no banner (unknown never nags)", async () => {
    arrange({ platform, phoneType: "iphone", preferences: "reject" });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });

  it("recorded provider + token expired (amber Reconnect strip owns it) -> no banner", async () => {
    arrange({
      platform,
      phoneType: "iphone",
      preferences: { emailProviders: ["outlook"] },
      microsoft: REFRESH_FAILED,
    });
    await load(platform);
    expect(banner()).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3888 — loading", () => {
  it("no banner while user data is still loading, even with a recorded provider", async () => {
    arrange({ platform: windows, phoneType: "iphone", preferences: { emailProviders: ["outlook"] } });
    // Hold the connection check open: the load cannot finish.
    mockApi.system.checkAllConnections.mockReturnValue(new Promise(() => {}));
    render(
      <AuthProvider>
        <AppStateProvider
          initialState={{ status: "loading", phase: "loading-user-data", user: baseUser, platform: windows } as AppState}
        >
          <LoadingOrchestrator>
            <Status />
            <ResumeSetupBanner app={app} />
          </LoadingOrchestrator>
        </AppStateProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(mockApi.preferences.get).toHaveBeenCalled());
    expect(banner()).not.toBeInTheDocument();
  });
});
