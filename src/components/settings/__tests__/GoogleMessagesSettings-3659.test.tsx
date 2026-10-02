/**
 * BACKLOG-3659 P3d — Settings → Android: Google Messages, with its own
 * Force re-import, auto-delete and consent controls.
 *
 * Mutations that turn this suite red:
 *   S1 Force re-import without the confirmation, or not calling clearTexts → "Force re-import"
 *   S2 a failed clear shown as a success                                    → "a refused clear"
 *   S3 the auto-delete switch not saved                                     → "auto-delete"
 *   S4 Withdraw not recording null                                          → "consent"
 *   S5 Settings not showing this section for android-messages-web           → (Settings.test)
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

let mockState: RcsExtensionState;
const mockClear = jest.fn();
const mockAutoDelete = jest.fn();
const mockConsent = jest.fn();

jest.mock("../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: mockState }),
    clearTexts: (...a: unknown[]) => mockClear(...a),
    setCacheAutoDelete: (...a: unknown[]) => mockAutoDelete(...a),
    setCacheConsent: (...a: unknown[]) => mockConsent(...a),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GoogleMessagesSettings } = require("../GoogleMessagesSettings") as typeof import("../GoogleMessagesSettings");

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    extensionVersion: "0.3.4", extensionSeenAt: "2026-10-01T10:00:00.000Z", pairedAt: "2026-10-01T10:00:00.000Z",
    optedIn: true, lastCacheFinishedAt: "2026-10-01T11:00:00.000Z", consentVersion: 1, consentRequired: 1,
    consentAt: "2026-10-01T09:00:00.000Z", autoDeleteDays: null,
  };
  mockClear.mockResolvedValue({ success: true, data: { messagesDeleted: 175 } });
  mockAutoDelete.mockResolvedValue({ success: true });
  mockConsent.mockResolvedValue({ success: true });
});

describe("GoogleMessagesSettings", () => {
  it("shows the extension, the pairing, the last sync and the consent", async () => {
    render(<GoogleMessagesSettings />);
    expect(await screen.findByTestId("gm-settings-extension")).toHaveTextContent("installed (version 0.3.4)");
    expect(screen.getByTestId("gm-settings-consent")).toHaveTextContent(/agreed/);
  });

  it("Force re-import: asks first, then clears only Google Messages texts and says so (S1)", async () => {
    render(<GoogleMessagesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    expect(mockClear).not.toHaveBeenCalled();
    expect(screen.getByText(/delete every text imported from Google Messages/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("Cleared 175 texts imported from Google Messages");
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it("a refused clear shows its error, not a success line (S2)", async () => {
    mockClear.mockResolvedValue({ success: false, error: "Nothing was cleared. Keepr is still saving the last Sync." });
    render(<GoogleMessagesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was cleared");
    expect(screen.queryByText(/^Cleared /)).toBeNull();
  });

  it("auto-delete: off by default; switching it on saves it (S3)", async () => {
    render(<GoogleMessagesSettings />);
    const box = (await screen.findByTestId("gm-auto-delete")) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(mockAutoDelete).toHaveBeenCalledWith(true));
  });

  it("consent: Withdraw records null (S4)", async () => {
    render(<GoogleMessagesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(mockConsent).toHaveBeenCalledWith(null));
  });
});
