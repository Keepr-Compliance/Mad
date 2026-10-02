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
 *   L1 the months control missing, or not showing the stored window       → "months control"
 *   L2 the months written anywhere but messageImport.filters (the key the
 *      cache Sync's floor reads), or a failed save left on screen          → "months control"
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
let mockPrefs: Record<string, unknown> = {};
const mockUpdatePrefs = jest.fn();

jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: async () => ({ success: true, data: mockPrefs }),
    updatePreferences: (...a: unknown[]) => mockUpdatePrefs(...a),
  },
}));

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
  mockClear.mockResolvedValue({ success: true, data: { messagesDeleted: 175, androidMessagesDeleted: 12, contactsDeleted: 3 } });
  mockAutoDelete.mockResolvedValue({ success: true });
  mockConsent.mockResolvedValue({ success: true });
  mockExcluded = [];
  mockPrefs = {};
  mockUpdatePrefs.mockResolvedValue({ success: true });
  mockRemoveExclusion.mockImplementation(async (a: { id?: string; all?: boolean }) => {
    mockExcluded = a.all ? [] : mockExcluded.filter((c) => c.id !== a.id);
    return { success: true };
  });
});

describe("GoogleMessagesSettings", () => {
  it("shows the extension, the pairing and the last sync; no consent line (S4)", async () => {
    render(<GoogleMessagesSettings userId="user-1" />);
    expect(await screen.findByTestId("gm-settings-extension")).toHaveTextContent("installed (version 0.3.4)");
    expect(screen.queryByTestId("gm-settings-consent")).toBeNull();
    expect(screen.queryByText(/Copying your texts/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("months control: absent → the default 3 months; the stored value; null → All time (L1)", async () => {
    const view = render(<GoogleMessagesSettings userId="user-1" />);
    const select = (await screen.findByRole("combobox", { name: "Import messages from" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("3");
    expect(screen.getByTestId("gm-lookback-line")).toHaveTextContent("Copying texts from the last 3 months");
    view.unmount();
    mockPrefs = { messageImport: { filters: { lookbackMonths: null } } };
    render(<GoogleMessagesSettings userId="user-1" />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Import messages from" }) as HTMLSelectElement).value).toBe("all"));
    expect(screen.getByTestId("gm-lookback-line")).toHaveTextContent("Copying all your texts");
  });

  it("months control: a change is saved to messageImport.filters; a failed save reverts (L2)", async () => {
    mockPrefs = { messageImport: { filters: { lookbackMonths: 6 } } };
    render(<GoogleMessagesSettings userId="user-1" />);
    const select = (await screen.findByRole("combobox", { name: "Import messages from" })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("6"));
    fireEvent.change(select, { target: { value: "12" } });
    await waitFor(() =>
      expect(mockUpdatePrefs).toHaveBeenCalledWith("user-1", { messageImport: { filters: { lookbackMonths: 12 } } }),
    );
    expect(screen.getByTestId("gm-lookback-line")).toHaveTextContent("Copying texts from the last 12 months");
    mockUpdatePrefs.mockResolvedValue({ success: false });
    fireEvent.change(select, { target: { value: "all" } });
    await waitFor(() => expect(select.value).toBe("12"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Keepr could not save that.");
  });

  // BACKLOG-3657 (founder re-confirmed 2026-10-01): the shared Android reset,
  // one confirmation naming both sources. Mutation: the old Google-Messages-
  // only warning / result → red.
  it("Force re-import: asks first (one warning naming both Android sources), then says what both lost (S1)", async () => {
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    expect(mockClear).not.toHaveBeenCalled();
    const warning = screen.getByTestId("android-force-warning");
    expect(warning).toHaveTextContent(
      "Force re-import will delete every text imported from your Android phone (Google Messages and Android Companion)",
    );
    expect(warning).toHaveTextContent(/you can restore them from “Show removed” on the transaction/);
    fireEvent.click(screen.getByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Cleared 175 texts imported from Google Messages and 12 texts and 3 contacts from the Android Companion.",
    );
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it("a refused clear shows its error, not a success line (S2)", async () => {
    mockClear.mockResolvedValue({ success: false, error: "Nothing was cleared. Keepr is still saving the last Sync." });
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was cleared");
    expect(screen.queryByText(/^Cleared /)).toBeNull();
  });

  it("auto-delete: off by default; switching it on saves it (S3)", async () => {
    render(<GoogleMessagesSettings userId="user-1" />);
    const box = (await screen.findByTestId("gm-auto-delete")) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(mockAutoDelete).toHaveBeenCalledWith(true));
  });

  // Founder (2026-10-02): one line + Manage, never an inline list. Mutation:
  // the list back inline, or the line shown at 0 → red.
  it("chats not synced: one line 'N chats not synced · Manage'; no inline list; 0 → no line (M1)", async () => {
    mockExcluded = [
      { id: "x-1", title: "Test Contact A", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
    ];
    const view = render(<GoogleMessagesSettings userId="user-1" />);
    const box = await screen.findByTestId("gm-not-synced");
    await waitFor(() => expect(screen.getByTestId("gm-not-synced-line")).toHaveTextContent("2 chats not synced · Manage"));
    expect(box).not.toHaveTextContent("Test Contact A");
    expect(screen.queryByRole("button", { name: "Sync again" })).toBeNull();
    expect(box).toHaveTextContent("texts already in Keepr stay");
    view.unmount();
    mockExcluded = [];
    render(<GoogleMessagesSettings userId="user-1" />);
    await screen.findByTestId("gm-not-synced");
    expect(screen.queryByTestId("gm-not-synced-line")).toBeNull();
  });

  // Mutation: Manage not opening the modal / Sync again not switching the chat back on → red.
  it("Manage opens the modal: titles or the fallback, search, Sync again (M2, E1, E2)", async () => {
    mockExcluded = [
      { id: "x-1", title: "Test Contact A", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
      { id: "x-3", title: "+1 (555) 555-0123", createdAt: "2026-10-01T08:00:00.000Z" },
    ];
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const list = await screen.findByTestId("gm-not-synced-list");
    expect(list).toHaveTextContent("Test Contact A");
    expect(list).toHaveTextContent("A chat you switched off in Google Messages");
    const search = screen.getByRole("searchbox", { name: "Search chats not synced" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "0123" } });
    expect(list).toHaveTextContent("+1 (555) 555-0123");
    expect(list).not.toHaveTextContent("Test Contact A");
    fireEvent.change(search, { target: { value: "contact" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync again" }));
    await waitFor(() => expect(mockRemoveExclusion).toHaveBeenCalledWith({ id: "x-1" }));
    await waitFor(() => expect(screen.getByTestId("gm-not-synced-line")).toHaveTextContent("2 chats not synced"));
    // Live (0.3.15): when it happens. Mutation: no notice → red.
    expect(screen.getByTestId("gm-not-synced-notice")).toHaveTextContent("Test Contact A: will sync on the next Sync.");
  });

  it("Sync all again (in the modal footer) asks first, then clears every exclusion; Escape closes (E3, M3)", async () => {
    mockExcluded = [
      { id: "x-1", title: null, createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
    ];
    const view = render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sync all again" }));
    expect(mockRemoveExclusion).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole("button", { name: "Sync all again" });
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(mockRemoveExclusion).toHaveBeenCalledWith({ all: true }));
    await waitFor(() => expect(screen.queryByTestId("gm-not-synced-line")).toBeNull());
    view.unmount();
    mockExcluded = [{ id: "x-1", title: null, createdAt: "2026-10-01T10:00:00.000Z" }];
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByTestId("gm-not-synced-modal")).toBeNull();
  });
});
