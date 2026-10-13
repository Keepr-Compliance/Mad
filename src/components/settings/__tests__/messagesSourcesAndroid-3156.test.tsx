/**
 * BACKLOG-3156 stage G — the Messages Sources card (founder approved 2026-10-13,
 * mock v3).
 *
 * - The Android row carries the email Sources control (ConnectionControl, the one
 *   EmailSettings' ProviderConnectionControl renders): green "Connected" + kebab
 *   (Relink / Unlink) while linked, a blue "Link" button while not. Clicking the
 *   control or its menu never changes the selected source.
 * - "Show connection details" (today's diagnostic lines) renders ONLY while
 *   Android is the selected source.
 * - "To use iPhone Sync" sits inside the iPhone card, ONLY while iPhone is selected.
 * - Ported from GoogleMessagesSettings-3659: the link status, Link / Relink
 *   opening the Sync Android modal, Unlink asking first in the popup's words,
 *   and the "Checking the browser…" window after Keepr starts.
 *
 * Controls (each mutation run, see the PR):
 *   K1 ROW_CLICK_IGNORE without "button"            → "kebab / Link / menu clicks never change the source"
 *   D1 details rendered whatever the source         → "details only for Android"
 *   I1 iPhone steps rendered whatever the source    → "iPhone steps only for iPhone"
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true, isWindowsArm64: false })),
}));

let mockState: RcsExtensionState;
const mockForget = jest.fn(async () => undefined);
const mockGetState = jest.fn(async () => ({ success: true, data: mockState }));
jest.mock("../../../services/rcsImportService", () => ({
  rcsImportService: {
    linkForget: () => mockForget(),
    getExtensionState: () => mockGetState(),
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { ImportSourceSettings } = require("../ImportSourceSettings") as typeof import("../ImportSourceSettings");
const { GoogleMessagesLinkProvider } = require("../android/googleMessagesLink") as typeof import("../android/googleMessagesLink");
const { usePlatform } = require("../../../contexts/PlatformContext") as { usePlatform: jest.Mock };
/* eslint-enable @typescript-eslint/no-require-imports */

const USER = "user-1";
const BASE_STATE: RcsExtensionState = {
  extensionVersion: "0.3.76", extensionSeenAt: "2026-10-01T10:00:00.000Z", pairedAt: "2026-10-01T10:00:00.000Z",
  optedIn: true, lastCacheFinishedAt: "2026-10-01T11:00:00.000Z", consentVersion: 1, consentRequired: 1,
  consentAt: "2026-10-01T09:00:00.000Z", autoDeleteDays: null,
};

function storeSource(source: string | undefined): void {
  jest.mocked(window.api.preferences.get).mockResolvedValue({
    success: true,
    preferences: source ? { messages: { source } } : {},
  });
}

async function renderSources(opts: { source?: string; onLink?: () => void; linkCheckMs?: number } = {}) {
  storeSource(opts.source);
  const onLink = opts.onLink ?? jest.fn();
  const view = render(
    <GoogleMessagesLinkProvider linkCheckMs={opts.linkCheckMs ?? 60_000}>
      <ImportSourceSettings userId={USER} onLinkGoogleMessages={onLink} />
    </GoogleMessagesLinkProvider>,
  );
  await screen.findByRole("radio", { name: /iPhone Sync/ });
  await waitFor(() => expect(mockGetState).toHaveBeenCalled());
  await act(async () => undefined);
  return { ...view, onLink };
}

const radio = (value: string) => document.querySelector<HTMLInputElement>(`input[name="importSource"][value="${value}"]`)!;

beforeEach(() => {
  jest.clearAllMocks();
  usePlatform.mockReturnValue({ isMacOS: true, isWindowsArm64: false });
  mockState = { ...BASE_STATE, extensionPaired: true };
  jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
});

describe("the Android row's connection control", () => {
  it("linked: green Connected + a kebab with Relink and Unlink (the email control); Relink opens the link step", async () => {
    const { onLink } = await renderSources({ source: "macos-native" });
    const row = screen.getByTestId("import-source-android-row");
    expect(within(row).getByTestId("gm-connection-dot")).toHaveClass("w-2", "h-2", "bg-green-500", "rounded-full");
    expect(within(row).getByTestId("gm-connection-status")).toHaveTextContent(/^Connected$/);
    expect(within(row).getByTestId("gm-connection-status")).toHaveClass("text-xs", "text-green-600", "font-medium");
    expect(within(row).queryByTestId("gm-connection-connect")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Google Messages connection options" }));
    const menu = within(row).getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Relink", "Unlink"]);
    expect(within(menu).getByRole("menuitem", { name: "Unlink Google Messages" })).toHaveClass("text-red-700");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Relink Google Messages" }));
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it("not linked: a blue Link button (the email Connect button's classes) that opens the link step", async () => {
    mockState = { ...BASE_STATE, extensionPaired: false, pairingSaved: false };
    const { onLink } = await renderSources({ source: "macos-native" });
    const link = screen.getByTestId("gm-connection-connect");
    expect(link).toHaveTextContent(/^Link$/);
    expect(link.className).toBe(
      "px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed",
    );
    expect(screen.queryByTestId("gm-connection-status")).toBeNull();
    expect(document.querySelector('input[inputmode="numeric"]')).toBeNull();
    fireEvent.click(link);
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it("kebab / Link / menu clicks never change the source (K1)", async () => {
    await renderSources({ source: "macos-native" });
    const row = screen.getByTestId("import-source-android-row");
    fireEvent.click(within(row).getByRole("button", { name: "Google Messages connection options" }));
    fireEvent.click(within(row).getByRole("menuitem", { name: "Unlink Google Messages" }));
    fireEvent.click(screen.getByTestId("gm-forget-cancel"));
    await act(async () => undefined);
    expect(radio("macos-native").checked).toBe(true);
    expect(radio("android-messages-web").checked).toBe(false);
    expect(window.api.preferences.update).not.toHaveBeenCalled();
  });

  it("a Link click does not change the source either (K1)", async () => {
    mockState = { ...BASE_STATE, extensionPaired: false, pairingSaved: false };
    await renderSources({ source: "macos-native" });
    fireEvent.click(screen.getByTestId("gm-connection-connect"));
    await act(async () => undefined);
    expect(radio("macos-native").checked).toBe(true);
    expect(window.api.preferences.update).not.toHaveBeenCalled();
  });

  it("anywhere else on the row selects Android (anti-vacuity for K1)", async () => {
    await renderSources({ source: "macos-native" });
    fireEvent.click(screen.getByTestId("import-source-android-row"));
    await waitFor(() =>
      expect(window.api.preferences.update).toHaveBeenCalledWith(USER, { messages: { source: "android-messages-web" } }),
    );
    expect(radio("android-messages-web").checked).toBe(true);
  });

  it("Unlink asks first in the popup's words; Cancel keeps the link; Unlink forgets it and re-reads the state", async () => {
    await renderSources({ source: "android-messages-web" });
    const row = screen.getByTestId("import-source-android-row");
    fireEvent.click(within(row).getByRole("button", { name: "Google Messages connection options" }));
    fireEvent.click(within(row).getByRole("menuitem", { name: "Unlink Google Messages" }));
    expect(mockForget).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const popup = require("../../../../chrome-extension/popup.js") as { COPY: { unlinkAsk: string } };
    expect(screen.getByTestId("gm-forget-confirm")).toHaveTextContent(popup.COPY.unlinkAsk);
    fireEvent.click(screen.getByTestId("gm-forget-cancel"));
    expect(screen.queryByTestId("gm-forget-confirm")).toBeNull();
    expect(mockForget).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole("button", { name: "Google Messages connection options" }));
    fireEvent.click(within(row).getByRole("menuitem", { name: "Unlink Google Messages" }));
    const reads = mockGetState.mock.calls.length;
    mockState = { ...BASE_STATE, extensionPaired: false, pairingSaved: false };
    fireEvent.click(screen.getByTestId("gm-forget-yes"));
    await waitFor(() => expect(mockForget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetState.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByTestId("gm-connection-connect")).toHaveTextContent("Link"));
  });

  it("a saved, unproven link right after Keepr starts: 'Checking the browser…', then Connected", async () => {
    mockState = { ...BASE_STATE, extensionPaired: false, pairingSaved: true, linkNotHere: false };
    storeSource("macos-native");
    render(
      <GoogleMessagesLinkProvider linkCheckMs={150}>
        <ImportSourceSettings userId={USER} onLinkGoogleMessages={jest.fn()} />
      </GoogleMessagesLinkProvider>,
    );
    expect(await screen.findByTestId("gm-connection-checking")).toHaveTextContent("Checking the browser…");
    await waitFor(() => expect(screen.getByTestId("gm-connection-status")).toHaveTextContent("Connected"), { timeout: 2000 });
  });

  it("nothing saved, or an extension said 'no link here': Link at once", async () => {
    mockState = { ...BASE_STATE, extensionPaired: false, pairingSaved: true, linkNotHere: true };
    await renderSources({ source: "macos-native" });
    expect(screen.getByTestId("gm-connection-connect")).toHaveTextContent("Link");
    expect(screen.queryByTestId("gm-connection-checking")).toBeNull();
  });
});

describe("Show connection details", () => {
  it.each(["macos-native", "iphone-sync"])("details only for Android: none while %s is selected (D1)", async (source) => {
    await renderSources({ source });
    expect(radio(source).checked).toBe(true);
    expect(screen.queryByTestId("gm-connection-details")).toBeNull();
    expect(screen.queryByText("Show connection details")).toBeNull();
    expect(screen.queryByTestId("gm-settings-extension")).toBeNull();
  });

  it("Android selected: collapsed under the row, holding today's four lines", async () => {
    await renderSources({ source: "android-messages-web" });
    const details = screen.getByTestId("gm-connection-details") as HTMLDetailsElement;
    expect(screen.getByTestId("import-source-android-row").contains(details)).toBe(true);
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(within(details).getByText("Show connection details").closest("summary")).not.toBeNull();
    expect(within(details).getByTestId("gm-settings-extension")).toHaveTextContent("Keepr extension: installed (version 0.3.76)");
    expect(details).toHaveTextContent("Google Messages connected: yes");
    expect(details).toHaveTextContent(`Last sync: ${new Date("2026-10-01T11:00:00.000Z").toLocaleString()}`);
    expect(details).toHaveTextContent("To sync, click Sync Android on the dashboard.");
  });

  it("selecting Android shows it; selecting another source hides it", async () => {
    await renderSources({ source: "macos-native" });
    fireEvent.click(radio("android-messages-web"));
    await waitFor(() => expect(screen.getByTestId("gm-connection-details")).toBeInTheDocument());
    fireEvent.click(radio("iphone-sync"));
    await waitFor(() => expect(screen.queryByTestId("gm-connection-details")).toBeNull());
  });
});

describe("To use iPhone Sync", () => {
  it.each(["macos-native", "android-messages-web"])("iPhone steps only for iPhone: none while %s is selected (I1)", async (source) => {
    await renderSources({ source });
    expect(radio(source).checked).toBe(true);
    expect(screen.queryByTestId("iphone-sync-steps")).toBeNull();
    expect(screen.queryByText("To use iPhone Sync:")).toBeNull();
  });

  it("iPhone selected: the steps sit inside the iPhone card, with the mock's words", async () => {
    await renderSources({ source: "iphone-sync" });
    const steps = screen.getByTestId("iphone-sync-steps");
    expect(radio("iphone-sync").closest("label")!.contains(steps)).toBe(true);
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Connect your iPhone to this Mac via USB",
      "Trust this computer on your iPhone if prompted",
      'Click "Import from iPhone" to sync messages',
    ]);
  });
});
