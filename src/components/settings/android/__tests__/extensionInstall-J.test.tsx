/**
 * Founder (storyboards A02 / J01, 2026-10-04): how the extension is installed.
 * A per-account "Beta extension install" preference (default OFF) picks the
 * beta (unpacked) path; until the extension is published
 * (EXTENSION_PUBLISHED = false) everyone gets it.
 *
 * Mutations (each turns a test red):
 *   J1 the preference read from another key, or absent read as on   → "the preference"
 *   J2 an unpublished extension not forcing beta                     → "wantsBetaInstall"
 *   J3 the store path (A02) not as the storyboard                    → "A02"
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  EXTENSION_PUBLISHED,
  betaInstallPreferencePatch,
  readBetaInstallPreference,
  wantsBetaInstall,
} from "../extensionDistribution";
import { GoogleMessagesSyncFlow } from "../GoogleMessagesSyncFlow";

const mockStore = jest.fn(async () => undefined);
let mockPrefs: Record<string, unknown> = {};
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    getExtensionState: async () => ({ success: true, data: { extensionVersion: null, extensionSeenAt: null, pairedAt: null, optedIn: false, lastCacheFinishedAt: null } }),
    prepareExtension: async () => ({ success: true, data: { folder: "Keepr Extension", version: "0.3.47" } }),
    openChromeForExtension: async () => ({ copied: true, opened: true }),
    openExtensionStore: () => mockStore(),
    getJob: async () => ({ success: true, data: null }),
    onJobProgress: () => () => undefined,
  },
}));
jest.mock("../../../../services/settingsService", () => ({
  settingsService: { getPreferences: async () => ({ success: true, data: mockPrefs }) },
}));

describe("the beta-install preference", () => {
  it("lives at messageImport.googleMessages.betaExtensionInstall; absent → off", () => {
    expect(readBetaInstallPreference({})).toBe(false);
    expect(readBetaInstallPreference(undefined)).toBe(false);
    expect(readBetaInstallPreference({ messageImport: { googleMessages: { betaExtensionInstall: true } } })).toBe(true);
    expect(readBetaInstallPreference({ messageImport: { betaExtensionInstall: true } })).toBe(false);
    expect(readBetaInstallPreference(betaInstallPreferencePatch(true))).toBe(true);
    expect(readBetaInstallPreference(betaInstallPreferencePatch(false))).toBe(false);
  });

  it("wantsBetaInstall: not published → beta for everyone; published → the preference", () => {
    expect(EXTENSION_PUBLISHED).toBe(false);
    expect(wantsBetaInstall(false)).toBe(true);
    expect(wantsBetaInstall(false, false)).toBe(true);
    expect(wantsBetaInstall(false, true)).toBe(false);
    expect(wantsBetaInstall(true, true)).toBe(true);
  });
});

describe("A02 (published, preference off): the Chrome Web Store", () => {
  // SR C6: "Use another texting app?" is gone (the Companion's UI is removed).
  it("'Install the Keepr extension', 'For Chrome. Takes a minute.', Add to Chrome — and nothing else", async () => {
    mockPrefs = {};
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} userId="user-1" pollMs={20} published />);
    const step = await screen.findByTestId("gm-step-install");
    await waitFor(() => expect(screen.getByRole("heading")).toHaveTextContent("Install the Keepr extension"));
    expect(step).toHaveTextContent("For Chrome. Takes a minute.");
    expect(screen.queryByTestId("gm-beta-label")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Add to Chrome"]);
    fireEvent.click(screen.getByTestId("gm-add-to-chrome"));
    expect(mockStore).toHaveBeenCalledTimes(1);
  });

  it("the preference on → J01 (beta) even when published", async () => {
    mockPrefs = { messageImport: { googleMessages: { betaExtensionInstall: true } } };
    render(<GoogleMessagesSyncFlow onClose={jest.fn()} userId="user-1" pollMs={20} published />);
    expect(await screen.findByTestId("gm-beta-label")).toHaveTextContent("BETA");
  });
});
