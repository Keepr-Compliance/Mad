/**
 * BACKLOG-2986 — A TOGGLE WHOSE WRITE FAILS MUST NOT KEEP CLAIMING IT SAVED.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `handleContactSourceToggle` flipped local state optimistically and then:
 *
 *     try { await settingsService.updatePreferences(...) }
 *     catch { /* Silently handle *\/ }
 *
 * so a failed write left the switch showing one thing while the stored
 * preference said another.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE MATTERS, AND IT IS NOT THE ONE THE `catch` SUGGESTS
 * ---------------------------------------------------------------------------
 * `settingsService.updatePreferences` (`src/services/settingsService.ts:138-148`)
 * has its own try/catch and **RESOLVES with `{ success: false, error }`** — it
 * does not throw. So on the failure that actually happens (offline, expired
 * session) the catch never ran and the result was simply discarded.
 *
 * That is why this suite drives the two routes SEPARATELY. A revert added only
 * to the `catch` — the obvious reading of the bug report — passes
 * `rejects with an error` and still lies on `resolves { success: false }`. The
 * resolved case is the one that fails on a careless fix, and it is the one the
 * user actually hits.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BECAME URGENT WITH BACKLOG-2986
 * ---------------------------------------------------------------------------
 * It has been survivable for a long time because every absent key meant
 * ENABLED: flip a switch ON, lose the write, the key stays absent, and absent
 * read as ON anyway — switch and backend agreed by luck. `androidContacts` is
 * the first switch whose OFF is a DERIVED default, so the luck runs out: turn
 * it back ON, lose the write, and the backend keeps deriving OFF while the
 * control says otherwise. Same defect BACKLOG-2486 closed for the iPhone
 * switch, different door.
 *
 * One handler serves all six toggles, so the last case here drives a
 * non-Android one to pin that the fix is not Android-specific.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsSettings } from "../ContactsSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: jest.fn() }),
}));

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

const originalApi = window.api;

function renderSettings(preferences: Record<string, unknown>) {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform: "darwin" },
      contacts: {
        getExternalSyncStatus: jest
          .fn()
          .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: jest
          .fn()
          .mockResolvedValue({ success: true, stats: { android_sync: 389, macos: 1174 } }),
      },
    },
    writable: true,
    configurable: true,
  });

  return render(
    <PlatformProvider>
      <ContactsSettings
        userId="user-1"
        initialPreferences={preferences as never}
        isMicrosoftConnected={true}
        isGoogleConnected={false}
      />
    </PlatformProvider>,
  );
}

const ANDROID_SWITCH = "Android Phone Contacts import";
const MACOS_SWITCH = "macOS Contacts import";

/** `phone_type: "iphone"` with `androidContacts` stored OFF — the state the
 *  founder is in after switching Android contacts off. Turning it back ON is
 *  the click whose lost write this suite is about. */
const ANDROID_OFF = {
  phone_type: "iphone",
  contactSources: { direct: { macosContacts: true, androidContacts: false } },
};

beforeEach(() => {
  mockUpdatePreferences.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("BACKLOG-2986 — a resolved { success: false } reverts the switch", () => {
  /**
   * THE ONE THAT MATTERS. `updatePreferences` never throws, so this is the
   * failure the user actually gets — and the one a catch-only fix misses.
   */
  it("puts the switch back and says so when the write reports failure", async () => {
    mockUpdatePreferences.mockResolvedValue({ success: false, error: "offline" });
    renderSettings(ANDROID_OFF);

    const toggle = await screen.findByLabelText(ANDROID_SWITCH);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByLabelText(ANDROID_SWITCH)).toHaveAttribute("aria-checked", "false"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Android Phone Contacts could not be saved/i,
    );
  });

  it("names the switch the user clicked, not a generic failure", async () => {
    // "an error occurred" is not actionable; the label is.
    mockUpdatePreferences.mockResolvedValue({ success: false });
    renderSettings(ANDROID_OFF);

    fireEvent.click(await screen.findByLabelText(MACOS_SWITCH));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /macOS Contacts could not be saved/i,
    );
  });
});

describe("BACKLOG-2986 — a thrown error reverts the switch too", () => {
  it("puts the switch back and says so when the call rejects", async () => {
    mockUpdatePreferences.mockRejectedValue(new Error("boom"));
    renderSettings(ANDROID_OFF);

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    await waitFor(() =>
      expect(screen.getByLabelText(ANDROID_SWITCH)).toHaveAttribute("aria-checked", "false"),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("BACKLOG-2986 — a successful write is left alone", () => {
  it("keeps the new position and shows no error", async () => {
    mockUpdatePreferences.mockResolvedValue({ success: true });
    renderSettings(ANDROID_OFF);

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    await waitFor(() => expect(mockUpdatePreferences).toHaveBeenCalled());
    expect(screen.getByLabelText(ANDROID_SWITCH)).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a previous failure once a write succeeds", async () => {
    // Otherwise a stale banner outlives the problem and the user cannot tell
    // whether their second attempt worked.
    mockUpdatePreferences.mockResolvedValueOnce({ success: false, error: "offline" });
    renderSettings(ANDROID_OFF);

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    mockUpdatePreferences.mockResolvedValue({ success: true });
    fireEvent.click(screen.getByLabelText(ANDROID_SWITCH));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText(ANDROID_SWITCH)).toHaveAttribute("aria-checked", "true");
  });
});
