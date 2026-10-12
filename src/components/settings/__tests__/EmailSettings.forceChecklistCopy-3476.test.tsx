/**
 * BACKLOG-3476 — the force re-cache warning names checklist links.
 *
 * The confirmation is global Settings and a checklist can exist on a machine
 * whose plan no longer includes checklists, so the checklist sentence is
 * unconditional.
 *
 * BACKLOG-3910a: a force run no longer removes those links — an email (or one
 * of its attachments) on a checklist item is kept. The sentence now says so.
 *
 * Harness copied from EmailSettings.cancelStrip-2856.test.tsx.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));

jest.mock("../../../services", () => ({
  settingsService: { updatePreferences: jest.fn().mockResolvedValue({ success: true }) },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    googleDisconnectMailbox: jest.fn(),
    microsoftDisconnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(() => () => {}),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { api: unknown }).api = {
    system: {
      checkAllConnections: jest.fn().mockResolvedValue({
        success: true,
        google: { connected: true, email: "me@example.com" },
        microsoft: { connected: false },
      }),
    },
    transactions: {
      precacheEmails: jest.fn(),
      cancelPrecacheEmails: jest.fn().mockResolvedValue({ success: true }),
      onPrecacheProgress: () => () => {},
    },
  };
});

describe("BACKLOG-3476 — force re-cache warning", () => {
  it("says emails on a checklist item are kept", async () => {
    const user = userEvent.setup();
    render(<EmailSettings userId="user-1" initialPreferences={undefined as never} />);
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));

    const body = await screen.findByTestId("force-recache-dialog-body");
    expect(body).toHaveTextContent(/Emails attached to a deal or a checklist item, .* are kept/);
    expect(body).not.toHaveTextContent(/removed too/);
    // SR F1: the dialog states the window it keeps. Mutation: line missing → red.
    expect(screen.getByTestId("force-window-line")).toHaveTextContent(
      "Keeps emails from the last 1.5 months; older emails are removed from this computer unless they are attached to a deal.",
    );
  });
});
