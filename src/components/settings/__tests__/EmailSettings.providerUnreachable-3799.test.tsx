/**
 * BACKLOG-3799: when a mailbox token refresh cannot reach the provider
 * (network, antivirus TLS inspection), main reports the connection as STILL
 * CONNECTED with a PROVIDER_UNREACHABLE error. Settings shows "Connected" and
 * the can't-reach sentence; it does not offer Reconnect.
 *
 * Harness copied from settingsConnectionControl-3156 (same mocks, same render).
 * The error object is the one connectionStatusService builds for this case.
 *
 * MUTATION: drop the PROVIDER_UNREACHABLE clause from the panel gate -> U1 RED.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: mockIsOnline,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

let mockIsOnline = true;

const authService = {
  googleConnectMailbox: jest.fn(),
  microsoftConnectMailbox: jest.fn(),
  googleDisconnectMailbox: jest.fn(),
  microsoftDisconnectMailbox: jest.fn(),
  onMailboxConnected: jest.fn(() => () => {}),
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

type ProviderState = {
  connected: boolean;
  email?: string;
  error?: { type: string; userMessage?: string; action?: string };
};

function setConnections(google: ProviderState, microsoft: ProviderState): void {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: {
        ...originalApi?.system,
        checkAllConnections: jest
          .fn()
          .mockResolvedValue({ success: true, google, microsoft }),
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
}

const NOT_CONNECTED: ProviderState = { connected: false };

async function renderEmails(): Promise<void> {
  render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
  await waitFor(() =>
    expect(screen.getByTestId("emails-block-sources")).toBeInTheDocument(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOnline = true;
});

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

const UNREACHABLE_MS = "Can't reach Microsoft. Check your network or antivirus, then try again.";

describe("BACKLOG-3799 — provider unreachable keeps the mailbox connected", () => {
  it("U1 Outlook: shows Connected AND the can't-reach sentence, no Reconnect", async () => {
    setConnections(NOT_CONNECTED, {
      connected: true,
      email: "outlook-user@example.com",
      error: { type: "PROVIDER_UNREACHABLE", userMessage: UNREACHABLE_MS, action: "" },
    });
    await renderEmails();
    await waitFor(() => expect(screen.getByText(UNREACHABLE_MS)).toBeInTheDocument());
    expect(screen.getByTestId("email-connection-microsoft-status")).toHaveTextContent("Connected");
    expect(screen.queryByTestId("email-connection-microsoft-reconnect")).not.toBeInTheDocument();
  });

  it("U2 a plain connected row shows no amber sentence", async () => {
    setConnections(NOT_CONNECTED, { connected: true, email: "outlook-user@example.com" });
    await renderEmails();
    await waitFor(() =>
      expect(screen.getByTestId("email-connection-microsoft-status")).toHaveTextContent("Connected"),
    );
    expect(screen.queryByText(UNREACHABLE_MS)).not.toBeInTheDocument();
  });
});
