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
 *   E2 (P3c) the modal not read-only (an action back), or no eye hint          → "read-only modal"
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

let mockState: RcsExtensionState;
const mockClear = jest.fn();
const mockAutoDelete = jest.fn();
const mockConsent = jest.fn();
const mockSetMedia = jest.fn();
let mockExcluded: Array<{ id: string; title: string | null; createdAt: string }> = [];
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
    setMediaOptions: (...a: unknown[]) => mockSetMedia(...a),
    listExclusions: async () => ({ success: true, data: mockExcluded }),
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
  mockSetMedia.mockResolvedValue({ success: true });
  mockExcluded = [];
  mockPrefs = {};
  mockUpdatePrefs.mockResolvedValue({ success: true });
});

describe("GoogleMessagesSettings", () => {
  it("shows the extension, the pairing and the last sync; no consent line (S4)", async () => {
    render(<GoogleMessagesSettings userId="user-1" />);
    expect(await screen.findByTestId("gm-settings-extension")).toHaveTextContent("installed (version 0.3.4)");
    expect(screen.queryByTestId("gm-settings-consent")).toBeNull();
    expect(screen.queryByText(/Copying your texts/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("months control: absent → the default 1.5 months; the stored value; null → All time (L1)", async () => {
    const view = render(<GoogleMessagesSettings userId="user-1" />);
    const select = (await screen.findByRole("combobox", { name: "Import messages from" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("1.5");
    expect(select.selectedOptions[0].textContent).toBe("Last 1.5 months (default)");
    expect(screen.getByTestId("gm-lookback-line")).toHaveTextContent("Copying texts from the last 1.5 months");
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
    expect(screen.getByTestId("gm-lookback-line")).toHaveTextContent("Copying texts from the last year");
    mockUpdatePrefs.mockResolvedValue({ success: false });
    fireEvent.change(select, { target: { value: "3" } });
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
    // SR F1: the window the next Sync copies back. Mutation: line missing → red.
    expect(screen.getByTestId("force-window-line")).toHaveTextContent(
      "Syncing again copies texts from the last 1.5 months; older texts not in an audit period are not copied back.",
    );
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

  // Founder (2026-10-02): one line + "See hidden list", never an inline list. Mutation:
  // the list back inline, or the line shown at 0 → red.
  it("chats not synced: one line 'N chats not synced · See hidden list'; no inline list; 0 → no line (M1)", async () => {
    mockExcluded = [
      { id: "x-1", title: "Test Contact A", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
    ];
    const view = render(<GoogleMessagesSettings userId="user-1" />);
    const box = await screen.findByTestId("gm-not-synced");
    await waitFor(() => expect(screen.getByTestId("gm-not-synced-line")).toHaveTextContent("2 chats not synced · See hidden list"));
    expect(box).not.toHaveTextContent("Test Contact A");
    expect(screen.queryByRole("button", { name: "Sync again" })).toBeNull();
    expect(box).toHaveTextContent("texts already in Keepr stay");
    view.unmount();
    mockExcluded = [];
    render(<GoogleMessagesSettings userId="user-1" />);
    await screen.findByTestId("gm-not-synced");
    expect(screen.queryByTestId("gm-not-synced-line")).toBeNull();
  });

  // Founder (2026-10-02): the modal is READ-ONLY — the eye in Google Messages
  // is the only switch. Mutations: "See hidden list" not opening the modal, a Sync again
  // / Sync all again action back, or the eye hint missing → red.
  it("See hidden list opens the read-only \"Hidden chats\" modal: titles or the fallback, search, the eye hint — no actions (M2, E1, E2)", async () => {
    mockExcluded = [
      { id: "x-1", title: "Test Contact A", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: "x-2", title: null, createdAt: "2026-10-01T09:00:00.000Z" },
      { id: "x-3", title: "+1 (555) 555-0123", createdAt: "2026-10-01T08:00:00.000Z" },
    ];
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "See hidden list" }));
    const list = await screen.findByTestId("gm-not-synced-list");
    // Founder copy: the read-only modal is "Hidden chats". Mutation: old title → red.
    expect(screen.getByRole("heading", { name: "Hidden chats" })).toBeInTheDocument();
    expect(list).toHaveTextContent("Test Contact A");
    expect(list).toHaveTextContent("A chat you switched off in Google Messages");
    const search = screen.getByRole("searchbox", { name: "Search chats not synced" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "0123" } });
    expect(list).toHaveTextContent("+1 (555) 555-0123");
    expect(list).not.toHaveTextContent("Test Contact A");
    expect(screen.getByTestId("gm-not-synced-hint")).toHaveTextContent(
      "To sync a chat again, click the eye next to it in Google Messages.",
    );
    const modal = screen.getByTestId("gm-not-synced-modal");
    const labels = Array.from(modal.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Close"]);
    expect(modal).not.toHaveTextContent(/Sync again|Sync all again/);
  });

  it("Escape closes the modal (M3)", async () => {
    mockExcluded = [{ id: "x-1", title: null, createdAt: "2026-10-01T10:00:00.000Z" }];
    render(<GoogleMessagesSettings userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "See hidden list" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByTestId("gm-not-synced-modal")).toBeNull();
  });

  // SR M: "Download photos / videos from all chats". Photos ON and videos OFF
  // by default; videos ask first, with the storage estimate. Mutations: the
  // defaults inverted, videos switched on without asking, no estimate → red.
  it("media toggles: photos on by default; videos ask first with the storage estimate (M5)", async () => {
    render(<GoogleMessagesSettings userId="user-1" />);
    const photos = (await screen.findByTestId("gm-photos-all")) as HTMLInputElement;
    const videos = screen.getByTestId("gm-videos-all") as HTMLInputElement;
    expect(photos.checked).toBe(true);
    expect(videos.checked).toBe(false);
    fireEvent.click(photos);
    await waitFor(() => expect(mockSetMedia).toHaveBeenCalledWith({ photosAllChats: false }));
    mockSetMedia.mockClear();
    fireEvent.click(videos);
    expect(mockSetMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("gm-videos-estimate")).toHaveTextContent("Sync once to see an estimate");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockSetMedia).not.toHaveBeenCalled();
    fireEvent.click(videos);
    fireEvent.click(screen.getByRole("button", { name: "Turn on videos" }));
    await waitFor(() => expect(mockSetMedia).toHaveBeenCalledWith({ videosAllChats: true }));
  });

  it("the video estimate from the last Sync's count", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { videoEstimateText } = require("../GoogleMessagesSettings") as typeof import("../GoogleMessagesSettings");
    expect(videoEstimateText(6)).toBe("Your last Sync saw 6 videos: about 150 MB on this computer at 25 MB each (a video can be up to 200 MB).");
    expect(videoEstimateText(80)).toContain("about 2.0 GB");
    expect(videoEstimateText(null)).toContain("Sync once");
  });
});
