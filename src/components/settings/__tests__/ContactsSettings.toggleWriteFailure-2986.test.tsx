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

/**
 * ===========================================================================
 * THE REASON HAS TO SURVIVE THE TRIP, AND IT DID NOT
 * ===========================================================================
 * These cases run the REAL `settingsService` — only `window.api` is mocked —
 * because the failure was spread across three layers and mocking the service
 * would hide two of them:
 *
 *   1. `WindowApiPreferences.update` declared `=> Promise<{ success: boolean }>`
 *      while `preferences:update` has always returned
 *      `{ success, error?, preferences? }` (`preferenceHandlers.ts:21-25`). The
 *      reason was dropped at the TYPE boundary.
 *   2. `settingsService.updatePreferences` therefore returned `{ success }`
 *      alone — it had nothing to forward.
 *   3. The toggle handler wrote `catch {` without binding, so even a forwarded
 *      reason would have died there.
 *
 * Fix any two of the three and the banner still says nothing useful, which is
 * why the assertion is on the STRING reaching the alert rather than on any one
 * layer's return value.
 */
describe("BACKLOG-2986 — the failure reason reaches the user", () => {
  /** The real settingsService over a mocked IPC bridge. */
  function renderWithRealService(updateResult: { success: boolean; error?: string }) {
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: { ...originalApi?.system, platform: "darwin" },
        preferences: { update: jest.fn().mockResolvedValue(updateResult) },
        contacts: {
          getExternalSyncStatus: jest.fn().mockResolvedValue({ success: true }),
          getSourceStats: jest
            .fn()
            .mockResolvedValue({ success: true, stats: { android_sync: 389 } }),
        },
      },
      writable: true,
      configurable: true,
    });

    return render(
      <PlatformProvider>
        <ContactsSettings
          userId="user-1"
          initialPreferences={ANDROID_OFF as never}
          isMicrosoftConnected={true}
          isGoogleConnected={false}
        />
      </PlatformProvider>,
    );
  }

  it("shows the reason the main process gave, not a generic message", async () => {
    jest.unmock("../../../services");
    const { settingsService } = jest.requireActual("../../../services");
    mockUpdatePreferences.mockImplementation((...args: unknown[]) =>
      (settingsService.updatePreferences as (...a: unknown[]) => unknown)(...args),
    );

    renderWithRealService({ success: false, error: "session expired" });

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Android Phone Contacts could not be saved: session expired/i,
    );
  });

  it("falls back to the generic message when the main process gave no reason", async () => {
    // An earlier draft turned `{ success: false }` into a thrown Error so both
    // routes could share one catch, which made this case read
    // "… could not be saved: Preferences could not be saved". A value is a
    // value; only a real reason is appended.
    jest.unmock("../../../services");
    const { settingsService } = jest.requireActual("../../../services");
    mockUpdatePreferences.mockImplementation((...args: unknown[]) =>
      (settingsService.updatePreferences as (...a: unknown[]) => unknown)(...args),
    );

    renderWithRealService({ success: false });

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Android Phone Contacts could not be saved\./i);
    expect(alert).not.toHaveTextContent(/could not be saved:/i);
  });
});

describe("BACKLOG-2986 — the banner is where the click was", () => {
  it("renders above the toggle group, not above the whole section", async () => {
    // It first rendered at the top of Contacts, which put it off-screen for
    // anyone toggling one of the lower switches. Document order is the
    // assertion because it is what "the user can see it" reduces to here:
    // the alert must precede the switch it is about, adjacent to it.
    mockUpdatePreferences.mockResolvedValue({ success: false, error: "offline" });
    renderSettings(ANDROID_OFF);

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    const alert = await screen.findByRole("alert");

    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the second node comes after the
    // first. Two assertions, because "before the switch" alone was also true of
    // the position this replaced.
    //
    // (a) The alert precedes the switch it is about.
    expect(alert.compareDocumentPosition(screen.getByLabelText(ANDROID_SWITCH)) & 4).toBeTruthy();
    // (b) And it sits INSIDE the import panel — after that panel's own heading,
    //     immediately above the "Import From" group. The old position was
    //     between the section's <h3> and this panel, which satisfied (a) while
    //     being a scroll away from every switch.
    const panelHeading = screen.getByRole("heading", { level: 4, name: "Contacts" });
    expect(panelHeading.compareDocumentPosition(alert) & 4).toBeTruthy();
    expect(alert.compareDocumentPosition(screen.getByText("Import From")) & 4).toBeTruthy();
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
