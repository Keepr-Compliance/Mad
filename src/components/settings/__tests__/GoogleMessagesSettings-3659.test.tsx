/**
 * BACKLOG-3659 P3d — Settings → Android: Google Messages, with its own
 * Force re-import and auto-delete (no consent line: founder, 2026-10-01).
 *
 * Mutations that turn this suite red:
 *   S1 Force re-import without the confirmation, or not calling clearTexts → "Force re-import"
 *   S2 a failed clear shown as a success                                    → "a refused clear"
 *   S3 the auto-delete switch not saved                                     → "auto-delete"
 *   S4 the consent line / Withdraw back in this section                     → "no consent line"
 *   S5 Settings not showing this section for android-messages-web           → (Settings.test)
 *   E1 (P3c) switched-off chats not listed / no fallback title               → "chats not synced"
 *   E2 (P3c) Sync again not switching that chat back on                       → "chats not synced"
 *   E3 (P3c) Sync all again without a confirmation                            → "Sync all again"
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

let mockState: RcsExtensionState;
const mockClear = jest.fn();
const mockAutoDelete = jest.fn();
const mockConsent = jest.fn();
let mockExcluded: Array<{ id: string; title: string | null; createdAt: string }> = [];
const mockRemoveExclusion = jest.fn();

jest.mock("../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: mockState }),
    clearTexts: (...a: unknown[]) => mockClear(...a),
    setCacheAutoDelete: (...a: unknown[]) => mockAutoDelete(...a),
    setCacheConsent: (...a: unknown[]) => mockConsent(...a),
    listExclusions: async () => ({ success: true, data: mockExcluded }),
    removeExclusion: (...a: unknown[]) => mockRemoveExclusion(...a),
    onDataChanged: () => () => undefined,
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
  mockExcluded = [];
  mockRemoveExclusion.mockImplementation(async (a: { id?: string; all?: boolean }) => {
    mockExcluded = a.all ? [] : mockExcluded.filter((c) => c.id !== a.id);
    return { success: true };
  });
});

describe("GoogleMessagesSettings", () => {
  it("shows the extension, the pairing and the last sync; no consent line (S4)", async () => {
    render(<GoogleMessagesSettings />);
    expect(await screen.findByTestId("gm-settings-extension")).toHaveTextContent("installed (version 0.3.4)");
    expect(screen.queryByTestId("gm-settings-consent")).toBeNull();
    expect(screen.queryByText(/Copying your texts/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
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

  it("chats not synced: listed with the stored title, or a plain fallback; Sync again switches one back on (E1, E2)", async () => {
    mockExcluded = [
      { id: "x-1", title: "Test Contact A", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
    ];
    render(<GoogleMessagesSettings />);
    const box = await screen.findByTestId("gm-not-synced");
    await waitFor(() => expect(box).toHaveTextContent("2 chats not synced"));
    expect(box).toHaveTextContent("Test Contact A");
    expect(box).toHaveTextContent("A chat you switched off in Google Messages");
    expect(box).toHaveTextContent("texts already in Keepr stay");
    fireEvent.click(screen.getAllByRole("button", { name: "Sync again" })[0]);
    await waitFor(() => expect(mockRemoveExclusion).toHaveBeenCalledWith({ id: "x-1" }));
    await waitFor(() => expect(box).toHaveTextContent("1 chat not synced"));
  });

  it("Sync all again asks first, then clears every exclusion (E3)", async () => {
    mockExcluded = [
      { id: "x-1", title: null, createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
    ];
    render(<GoogleMessagesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync all again" }));
    expect(mockRemoveExclusion).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole("button", { name: "Sync all again" });
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(mockRemoveExclusion).toHaveBeenCalledWith({ all: true }));
    await waitFor(() => expect(screen.getByTestId("gm-not-synced")).toHaveTextContent("Every chat is synced"));
  });
});
