/**
 * BACKLOG-3476 — the force re-cache warning names checklist links.
 *
 * A force re-cache deletes and re-downloads the cached emails and their
 * attachments; checklist links to them cascade away. Once the Checklist tab can
 * create links, the confirmation has to say so — unconditionally, because the
 * dialog is global Settings and a checklist can exist on a machine whose plan
 * no longer includes checklists.
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
  it("says checklist links to those emails and attachments are removed too", async () => {
    const user = userEvent.setup();
    render(<EmailSettings userId="user-1" initialPreferences={undefined as never} />);
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));

    const confirm = await screen.findByTestId("force-recache-confirm");
    const dialog = confirm.closest("div.bg-white") ?? document.body;
    expect(dialog).toHaveTextContent(
      /Links from checklist items to those emails and their attachments are removed too\./,
    );
  });
});
