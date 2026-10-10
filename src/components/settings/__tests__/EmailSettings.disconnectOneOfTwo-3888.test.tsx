/**
 * BACKLOG-3888 — disconnecting ONE of two mailboxes in Settings keeps the user
 * "connected", so the setup banner stays hidden; disconnecting the ONLY one
 * brings the banner back.
 *
 * Integration across the real chain, nothing between the ends mocked:
 *   EmailSettings (menu -> confirm -> handleDisconnect*, post-disconnect
 *   checkConnections) -> onEmailDisconnected(provider, anyStillConnected)
 *   -> useEmailSettingsCallbacks -> useEmailOnboardingApi.setHasEmailConnected
 *   -> EMAIL_DISCONNECTED -> real reducer -> real ResumeSetupBanner.
 * Only window.api / authService (the IPC edge) are simulated.
 *
 * Harness copied from settingsConnectionControl-3156.test.tsx (same mocks,
 * same menu -> confirm flow). checkAllConnections returns the CURRENT
 * simulated main-process state, which the disconnect mock mutates, matching
 * main: after auth:*:disconnect-mailbox the row is gone and the next check
 * reports { connected: false } for that provider.
 *
 * Mutations that must red (BACKLOG-3888 SR B1):
 *   - EmailSettings always passes false            -> T1, T2 red
 *   - EmailSettings reads the disconnected provider -> T1, T2 red
 *   - useEmailSettingsCallbacks drops the value     -> T1, T2 red
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";
import { AppStateProvider } from "../../../appCore/state/machine/AppStateContext";
import { useAppState } from "../../../appCore/state/machine/useAppState";
import { useEmailSettingsCallbacks } from "../../../appCore/hooks/useEmailSettingsCallbacks";
import { ResumeSetupBanner } from "../../setup/ResumeSetupBanner";
import type { ReadyState } from "../../../appCore/state/machine/types";
import type { AppStateMachine } from "../../../appCore/state/types";

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

type Provider = "google" | "microsoft";
const main: Record<Provider, { connected: boolean; email?: string }> = {
  google: { connected: false },
  microsoft: { connected: false },
};

const authService = {
  googleConnectMailbox: jest.fn(),
  microsoftConnectMailbox: jest.fn(),
  googleDisconnectMailbox: jest.fn(async () => {
    main.google = { connected: false };
    return { success: true };
  }),
  microsoftDisconnectMailbox: jest.fn(async () => {
    main.microsoft = { connected: false };
    return { success: true };
  }),
  onMailboxConnected: jest.fn(() => () => {}),
  completeEmailOnboarding: jest.fn(async () => ({ success: true })),
};

jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
  get authService() {
    return authService;
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const originalApi = window.api;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: {
        ...originalApi?.system,
        checkAllConnections: jest.fn(async () => ({
          success: true,
          google: { ...main.google },
          microsoft: { ...main.microsoft },
        })),
      },
      transactions: {
        precacheEmails: jest.fn(),
        cancelPrecacheEmails: jest.fn(),
        onPrecacheProgress: () => () => {},
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "api", { value: originalApi, writable: true, configurable: true });
});

/** Windows, iPhone with drivers (above the texts floor), chose email, connected. */
const readyConnected: ReadyState = {
  status: "ready",
  user: { id: "u", email: "u@example.com" },
  platform: { isMacOS: false, isWindows: true, hasIPhone: false },
  userData: {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    hasRecordedEmailProvider: true,
    needsDriverSetup: false,
    fda: "not-applicable",
    setup: "finished",
  },
};

const app = {
  showSetupPromptDismissed: false,
  goToEmailOnboarding: jest.fn(),
  handleDismissSetupPrompt: jest.fn(),
} as unknown as AppStateMachine;

function Connected() {
  const { state } = useAppState();
  return (
    <div data-testid="has-email-connected">
      {state.status === "ready" ? String(state.userData.hasEmailConnected) : "n/a"}
    </div>
  );
}

function Harness() {
  const { handleEmailDisconnectedFromSettings } = useEmailSettingsCallbacks({ userId: "u" });
  return (
    <>
      <ResumeSetupBanner app={app} />
      <Connected />
      <EmailSettings
        userId="u"
        initialPreferences={undefined as never}
        onEmailDisconnected={handleEmailDisconnectedFromSettings}
      />
    </>
  );
}

const LABEL: Record<Provider, RegExp> = { google: /disconnect gmail/i, microsoft: /disconnect outlook/i };

async function disconnect(provider: Provider): Promise<void> {
  render(
    <AppStateProvider initialState={readyConnected}>
      <Harness />
    </AppStateProvider>,
  );
  await screen.findByTestId(`email-connection-${provider}-status`);
  // PRECONDITION: connected, no banner.
  expect(screen.getByTestId("has-email-connected")).toHaveTextContent("true");
  expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();

  await userEvent.click(screen.getByTestId(`email-connection-${provider}-trigger`));
  await userEvent.click(screen.getByRole("menuitem", { name: LABEL[provider] }));
  await userEvent.click(screen.getByTestId("disconnect-confirm"));
  const call = provider === "google" ? authService.googleDisconnectMailbox : authService.microsoftDisconnectMailbox;
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
}

describe("BACKLOG-3888 — Settings disconnect -> reducer -> banner", () => {
  it.each<[string, Provider, Provider]>([
    ["T1 Gmail", "google", "microsoft"],
    ["T2 Outlook", "microsoft", "google"],
  ])("%s: disconnect one of two -> still connected, no banner", async (_n, provider, other) => {
    main[provider] = { connected: true, email: `${provider}@example.com` };
    main[other] = { connected: true, email: `${other}@example.com` };
    await disconnect(provider);
    // Let the post-disconnect check and dispatch land, then assert they did NOT flip it.
    await waitFor(() =>
      expect(
        (window.api.system.checkAllConnections as jest.Mock).mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId(`email-connection-${provider}-status`)).not.toBeInTheDocument(),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("has-email-connected")).toHaveTextContent("true");
    expect(screen.queryByTestId("resume-setup-banner")).not.toBeInTheDocument();
  });

  it.each<[string, Provider, Provider]>([
    ["T3 Gmail", "google", "microsoft"],
    ["T4 Outlook", "microsoft", "google"],
  ])("%s: disconnect the only mailbox -> banner", async (_n, provider, other) => {
    main[provider] = { connected: true, email: `${provider}@example.com` };
    main[other] = { connected: false };
    await disconnect(provider);
    await waitFor(() =>
      expect(screen.getByTestId("has-email-connected")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("resume-setup-banner")).toBeInTheDocument();
  });
});
