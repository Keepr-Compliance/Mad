/**
 * BACKLOG-2486 — Settings > Contacts tells the truth about contact sources.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * Two defects inherited from BACKLOG-2482 §3, both of which the gate split made
 * urgent rather than cosmetic:
 *
 * 1. The macOS switch was labelled "macOS / iPhone Contacts" and wrote ONLY
 *    `macosContacts`. It named two sources and controlled one. Once each source
 *    answers to its own preference, a switch called "iPhone" that does not move
 *    the iPhone gate is simply untrue.
 *
 * 2. There was NO `iphoneContacts` control anywhere in Settings — onboarding was
 *    its only writer. That was survivable while the backend OR'd the key with
 *    `macosContacts`. It is not survivable now: on macOS an absent
 *    `iphoneContacts` derives FALSE, so without a control here a user with iCloud
 *    contact sync switched off had no way to ever get their iPhone contacts.
 *
 * ---------------------------------------------------------------------------
 * THE ASSERTION THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * The switch's ABSENT-preference position must equal what the MAIN PROCESS will
 * do with the same absent key. It is drawn through `isContactSourceOnByDefault`,
 * the renderer mirror of the rule `preferenceHelper.isContactSourceEnabled`
 * applies. Defaulting to `true` here — as every other toggle in this panel does —
 * would paint the iPhone switch ON while the backend read the same absent key as
 * OFF on macOS: a control that disagrees with its own effect.
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

function renderSettings(
  preferences: Record<string, unknown>,
  platform: "darwin" | "win32" = "darwin",
) {
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
        getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: {} }),
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
 * (`ContactSourceStep.buildDirectContactSourcePrefs`, `:219-230`): only the
 * VISIBLE keys are present, so an untouched source is genuinely absent rather
 * than `false`.
 */
function prefs(direct: Record<string, boolean>, phoneType = "iphone") {
  return { phone_type: phoneType, contactSources: { direct } };
}

const IPHONE_SWITCH = "iPhone Contacts import";
const MACOS_SWITCH = "macOS Contacts import";

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

describe("BACKLOG-2486 — the macOS switch no longer claims to control iPhone", () => {
  it("is labelled 'macOS Contacts', not 'macOS / iPhone Contacts'", () => {
    renderSettings(prefs({ macosContacts: true, iphoneContacts: true }), "darwin");

    expect(screen.getByLabelText(MACOS_SWITCH)).toBeInTheDocument();
    expect(screen.queryByText("macOS / iPhone Contacts")).not.toBeInTheDocument();
    expect(screen.getByText("macOS Contacts")).toBeInTheDocument();
  });

  it("writes macosContacts and leaves iphoneContacts untouched", async () => {
    renderSettings(prefs({ macosContacts: true, iphoneContacts: true }), "darwin");

    fireEvent.click(screen.getByLabelText(MACOS_SWITCH));

    await waitFor(() => expect(mockUpdatePreferences).toHaveBeenCalled());
    expect(mockUpdatePreferences).toHaveBeenCalledWith("user-1", {
      contactSources: { direct: { macosContacts: false } },
    });
  });
});

describe("BACKLOG-2486 — iPhone Contacts has a switch of its own", () => {
  it("writes iphoneContacts when toggled", async () => {
    renderSettings(prefs({ macosContacts: true, iphoneContacts: false }), "darwin");

    fireEvent.click(screen.getByLabelText(IPHONE_SWITCH));

    await waitFor(() => expect(mockUpdatePreferences).toHaveBeenCalled());
    expect(mockUpdatePreferences).toHaveBeenCalledWith("user-1", {
      contactSources: { direct: { iphoneContacts: true } },
    });
  });

  it("reflects an explicitly stored true", () => {
    renderSettings(prefs({ iphoneContacts: true }), "darwin");
    expect(screen.getByLabelText(IPHONE_SWITCH)).toHaveAttribute("aria-checked", "true");
  });

  it("reflects an explicitly stored false", () => {
    renderSettings(prefs({ iphoneContacts: false }), "darwin");
    expect(screen.getByLabelText(IPHONE_SWITCH)).toHaveAttribute("aria-checked", "false");
  });

  /**
   * THE ONE THAT MATTERS. An absent key must draw the switch the way the main
   * process will read it, not the way the other toggles default.
   */
  it("draws OFF on macOS when nothing is stored, matching the backend's derived default", () => {
    renderSettings(prefs({ macosContacts: true }), "darwin");
    expect(screen.getByLabelText(IPHONE_SWITCH)).toHaveAttribute("aria-checked", "false");
  });

  it("draws ON on Windows when nothing is stored, matching the backend's derived default", () => {
    renderSettings(prefs({ outlookContacts: true }), "win32");
    expect(screen.getByLabelText(IPHONE_SWITCH)).toHaveAttribute("aria-checked", "true");
  });

  it("explains why it is off by default on macOS", () => {
    renderSettings(prefs({ macosContacts: true }), "darwin");
    expect(screen.getByText(/already includes iPhone contacts synced through iCloud/)).toBeInTheDocument();
  });

  it("is hidden for a declared Android user, who has no iPhone to import from", () => {
    renderSettings(prefs({ androidContacts: true }, "android"), "darwin");
    expect(screen.queryByLabelText(IPHONE_SWITCH)).not.toBeInTheDocument();
  });

  it("is shown when the phone type was never recorded, so the default is reversible", () => {
    // No `phone_type` at all. On macOS the derived default is OFF, so hiding the
    // control here would leave this user no way back to their iPhone contacts.
    renderSettings({ contactSources: { direct: { macosContacts: true } } }, "darwin");
    expect(screen.getByLabelText(IPHONE_SWITCH)).toBeInTheDocument();
    expect(screen.getByLabelText(IPHONE_SWITCH)).toHaveAttribute("aria-checked", "false");
  });

  it("is reachable on Windows with no mailbox connected, where it is the only source", () => {
    // `hasAnySources` previously read `isMacOS || isMicrosoftConnected ||
    // isGoogleConnected`, so this user hit the "no sources" placeholder and never
    // saw the one switch that governs their only contact source.
    Object.defineProperty(window, "api", {
      value: {
        ...originalApi,
        system: { ...originalApi?.system, platform: "win32" },
        contacts: {
          getExternalSyncStatus: jest.fn().mockResolvedValue({ success: true }),
          getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: {} }),
        },
      },
      writable: true,
      configurable: true,
    });

    render(
      <PlatformProvider>
        <ContactsSettings
          userId="user-1"
          initialPreferences={prefs({}) as never}
          isMicrosoftConnected={false}
          isGoogleConnected={false}
        />
      </PlatformProvider>,
    );

    expect(screen.getByLabelText(IPHONE_SWITCH)).toBeInTheDocument();
  });
});
