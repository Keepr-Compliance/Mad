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
import { render, screen } from "@testing-library/react";
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
  } = {},
) {
  const { platform = "darwin", stats = FOUNDER_STATS } = options;

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

/**
 * Founder (2026-10-05): the Android contacts option is HIDDEN with the Android
 * Companion's UI (only the Companion pushed these contacts). BACKLOG-2986's
 * switch, count cell and re-import note no longer render — for every user,
 * declared Android or not, with or without android_sync rows — and nothing is
 * written: the stored androidContacts value and the imported contacts stay.
 * Google Messages never reads this key (its people: contactSources.inferred.messages).
 *
 * Mutation: the option shown again (ANDROID_CONTACTS_OPTION_SHOWN true) → red.
 */
describe("the Android contacts option is hidden (founder, 2026-10-05)", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, number> | undefined]> = [
    ["the founder's 389 Android contacts, iPhone declared", prefs({ macosContacts: true }), undefined],
    ["a declared Android phone, nothing stored", prefs({}, "android"), { ...FOUNDER_STATS, android_sync: 0 }],
    ["an explicitly stored true", prefs({ androidContacts: true }, "android"), undefined],
    ["an explicitly stored false", prefs({ androidContacts: false }, "android"), undefined],
  ];
  it.each(cases)("%s: no switch, no Android count, no note — nothing written", async (_name, p, stats) => {
    renderSettings(p, stats ? { stats } : {});
    await screen.findByText("1,174");
    expect(screen.queryByLabelText(ANDROID_SWITCH)).not.toBeInTheDocument();
    expect(screen.queryByText("Android")).not.toBeInTheDocument();
    expect(screen.queryByTestId("android-contacts-note")).not.toBeInTheDocument();
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });
});

// SR (after a0d89d8b6): the hidden Android contacts are not a source the
// screen can show, so a user whose ONLY source they are gets the "no sources"
// placeholder. Mutation: the empty-state check counting the hidden Android
// source again → red.
it("only the hidden Android contacts (Windows, Android phone, no mailbox): the no-sources placeholder", async () => {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform: "win32" },
      contacts: {
        getExternalSyncStatus: jest.fn().mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: { android_sync: 389 } }),
      },
    },
    writable: true,
    configurable: true,
  });
  render(
    <PlatformProvider>
      <ContactsSettings
        userId="user-1"
        initialPreferences={prefs({ androidContacts: true }, "android") as never}
        isMicrosoftConnected={false}
        isGoogleConnected={false}
      />
    </PlatformProvider>,
  );
  expect(await screen.findByText("Connect a Microsoft or Google account, or use macOS to import contacts.")).toBeInTheDocument();
  expect(screen.queryByLabelText(ANDROID_SWITCH)).not.toBeInTheDocument();
});
