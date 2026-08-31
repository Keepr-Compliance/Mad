/**
 * BACKLOG-2986 — Android is a first-class contact source on the Contacts screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FOUNDER SAW
 * ---------------------------------------------------------------------------
 * Contacts settings, twenty minutes after a successful Android sync:
 *
 *     Import
 *     1,174 macOS   1,176 iPhone   0 Outlook
 *     Select a Source        [Force Re-import]
 *
 * while the same session's desktop log read `Received 389 contacts` /
 * `Android contact sync complete (full): inserted=389`. The data arrived; the
 * screen whose job is to show where contacts came from did not mention it, and
 * there was no switch anywhere in Settings that could turn it off.
 *
 * ---------------------------------------------------------------------------
 * WHICH NUMBER THE CELL SHOWS, AND WHY THE ASSERTION IS ON THE NUMBER
 * ---------------------------------------------------------------------------
 * `external_contacts` rows with source `android_sync` — 389 — because that is
 * the single `getContactSourceStats` GROUP BY that every other cell in this
 * grid reads. The 26 from "Promoted 26 Android contacts to main contacts
 * table" is a different quantity (a `promoteToMainContacts` result) and no cell
 * here shows a promotion count for any source.
 *
 * Asserting only that the grid grew a fourth cell would pass on an EMPTY
 * Android cell and prove nothing, so every assertion below names the value.
 *
 * ---------------------------------------------------------------------------
 * THE HALF THIS FILE CANNOT PROVE
 * ---------------------------------------------------------------------------
 * That the switch draws OFF is not that Android contacts stop importing. The
 * backend half — `isContactSourceEnabled(user, "direct", "androidContacts",
 * true)` returning FALSE on the same absent key, i.e. the derived rule beating
 * the `true` the caller passes — is pinned in
 * `electron/utils/__tests__/preferenceHelper.test.ts`. Both halves must go red
 * together when `androidContacts` is removed from `BACKEND_DERIVED_DEFAULT_KEYS`;
 * removing it from only ONE of the two copies leaves the renderer drawing OFF
 * while the backend reads true, and only the electron-side control catches that.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsSettings } from "../ContactsSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";

const mockUpdatePreferences = jest.fn().mockResolvedValue({ success: true });
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

/**
 * FIXTURE PROVENANCE — transcribed, not invented.
 *
 * `contacts.getSourceStats` resolves `{ success, stats }` where `stats` is what
 * `externalContactDbService.getContactSourceStats` returns: the seeded object
 * `{ macos: 0, iphone: 0, outlook: 0, google_contacts: 0, android_sync: 0 }`
 * overwritten by one `SELECT source, COUNT(*) ... GROUP BY source` row per
 * source present. So every key is ALWAYS defined, including `android_sync`,
 * and a source with no rows is a real `0` rather than absent.
 *
 * The counts below are the founder's own 2026-08-29 session:
 * 389 android_sync external records; 26 of them were promoted, which is
 * deliberately NOT the number this grid shows.
 */
const FOUNDER_STATS = {
  macos: 1174,
  iphone: 1176,
  outlook: 0,
  google_contacts: 0,
  android_sync: 389,
};

function renderSettings(
  preferences: Record<string, unknown>,
  options: {
    platform?: "darwin" | "win32";
    stats?: Record<string, number>;
    androidCompanionActive?: boolean;
  } = {},
) {
  const { platform = "darwin", stats = FOUNDER_STATS, androidCompanionActive = false } = options;

  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform },
      contacts: {
        getExternalSyncStatus: jest
          .fn()
          .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: jest.fn().mockResolvedValue({ success: true, stats }),
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
        androidCompanionActive={androidCompanionActive}
      />
    </PlatformProvider>,
  );
}

/**
 * The preference bag exactly as onboarding writes it
 * (`ContactSourceStep.buildDirectContactSourcePrefs`): only the VISIBLE keys
 * are present, so an untouched source is genuinely absent rather than `false`.
 * `androidContacts` is visible only when the declared phone type is Android —
 * which is why "absent" is the state nearly every user is in.
 */
function prefs(direct: Record<string, boolean>, phoneType = "iphone") {
  return { phone_type: phoneType, contactSources: { direct } };
}

const ANDROID_SWITCH = "Android Phone Contacts import";

/**
 * The number rendered in the ANDROID cell specifically.
 *
 * Scoped rather than a bare `getByText("389")` because the assertions that
 * matter are identity assertions: "0" and small counts appear in several cells,
 * and a mutation that pointed the Android cell at another source's count must
 * fail here rather than find its number somewhere else on the panel. The cell
 * is `<div><div>{count}</div><div>Android</div></div>`, so the count is the
 * label's first sibling.
 */
async function androidCellCount(): Promise<string | null> {
  const label = await screen.findByText("Android");
  return label.parentElement?.firstElementChild?.textContent ?? null;
}

beforeEach(() => {
  mockUpdatePreferences.mockClear();
});

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("BACKLOG-2986 — the Android count appears in the source grid", () => {
  /** THE ITEM'S OWN CONTROL. Red before the fix: the cell did not exist. */
  it("renders the android_sync external-contact count next to the other sources", async () => {
    renderSettings(prefs({ macosContacts: true }));

    expect(await androidCellCount()).toBe("389");
  });

  it("shows the external-record count, not the number promoted to the contacts table", async () => {
    // 389 external records; 26 of those were promoted on the same sync. Every
    // other cell in this grid is an external-record count, so this one is too —
    // a cell that silently meant "promoted" would be the only one in the row
    // measuring something else.
    renderSettings(prefs({ macosContacts: true }));

    expect(await androidCellCount()).toBe("389");
    expect(screen.queryByText("26")).not.toBeInTheDocument();
  });

  it("renders a real 0 rather than disappearing when the phone's contacts are gone", async () => {
    // The state immediately after an Android Force Re-import. A grid that
    // dropped the cell here would look identical to a grid on a machine that
    // never had Android contacts — which is the missing SIGNAL this item calls
    // the worse of its two defects.
    renderSettings(prefs({ androidContacts: true }), {
      stats: { ...FOUNDER_STATS, android_sync: 0 },
    });

    expect(await androidCellCount()).toBe("0");
  });

  it("stays out of the way for a user with no Android relationship at all", async () => {
    // No declared Android phone, no stored preference, no android_sync rows.
    renderSettings(prefs({ macosContacts: true }), {
      stats: { ...FOUNDER_STATS, android_sync: 0 },
    });

    await screen.findByText("1,174");
    expect(screen.queryByText("Android")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(ANDROID_SWITCH)).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2986 — Android Contacts has a switch, and it starts OFF", () => {
  /**
   * THE ONE THAT MATTERS on this side. Absent key + no declared Android phone
   * is the state nearly every user is in, and it used to read as `true`.
   * Founder, 2026-08-30: "contacts aren't auto imported."
   */
  it("draws OFF when nothing is stored, matching the backend's derived default", async () => {
    renderSettings(prefs({ macosContacts: true }));

    expect(await screen.findByLabelText(ANDROID_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("draws OFF on Windows too — the rule reads the phone, not the desktop", async () => {
    renderSettings(prefs({ outlookContacts: true }), { platform: "win32" });

    expect(await screen.findByLabelText(ANDROID_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("draws ON for a user who declared an Android phone and stored nothing", async () => {
    // Not a hole in "default OFF": the companion is that user's only address
    // book, and it is the card onboarding would have pre-ticked. Same clause
    // that keeps iPhone Contacts ON on Windows.
    renderSettings({ phone_type: "android", contactSources: { direct: {} } });

    expect(await screen.findByLabelText(ANDROID_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("reflects an explicitly stored true", async () => {
    renderSettings(prefs({ androidContacts: true }));
    expect(await screen.findByLabelText(ANDROID_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("reflects an explicitly stored false", async () => {
    renderSettings(prefs({ androidContacts: false }));
    expect(await screen.findByLabelText(ANDROID_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("writes androidContacts when toggled — Settings is now a writer of this key", async () => {
    // Until this change onboarding was the ONLY writer, and only for a declared
    // Android user. That is why the founder could not switch his 389 Android
    // contacts off from anywhere.
    renderSettings(prefs({ androidContacts: true }));

    fireEvent.click(await screen.findByLabelText(ANDROID_SWITCH));

    await waitFor(() => expect(mockUpdatePreferences).toHaveBeenCalled());
    expect(mockUpdatePreferences).toHaveBeenCalledWith("user-1", {
      contactSources: { direct: { androidContacts: false } },
    });
  });

  it("stays reachable after a Force Re-import has emptied the count", async () => {
    // phone_type "iphone", a stored preference, and zero android_sync rows —
    // the founder's literal state between clearing and the next sync. A
    // visibility gate of "declared Android OR count > 0" would hide the switch
    // from exactly the person who reported its absence.
    renderSettings(prefs({ androidContacts: true }), {
      stats: { ...FOUNDER_STATS, android_sync: 0 },
    });

    expect(await screen.findByLabelText(ANDROID_SWITCH)).toBeInTheDocument();
  });
});

describe("BACKLOG-2986 — the re-import is findable from the Contacts screen", () => {
  it("says the phone holds the only copy, and offers the jump when that panel is on the page", async () => {
    renderSettings(prefs({ androidContacts: true }), { androidCompanionActive: true });

    expect(
      await screen.findByText(/phone holds the only copy/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Go to Android Companion re-import/i }),
    ).toBeInTheDocument();
  });

  it("does not offer a jump to a panel that is not rendered", async () => {
    // `Settings.tsx` renders AndroidMessagesSettings — and with it the working
    // Force Re-import — only when the active import source is the companion. A
    // button that scrolled there regardless would land the user on the macOS
    // panel and claim to have taken them somewhere.
    renderSettings(prefs({ androidContacts: true }), { androidCompanionActive: false });

    expect(await screen.findByText(/phone holds the only copy/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Go to Android Companion re-import/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Set your message import source to Android/i),
    ).toBeInTheDocument();
  });
});
