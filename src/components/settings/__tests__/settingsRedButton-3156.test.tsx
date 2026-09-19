/**
 * BACKLOG-3156 stage D — one red, two shapes, chosen by blast radius.
 *
 * The app carried four different reds that nobody chose. This suite pins the
 * two recoverable destructive actions — Sign Out All Devices and Clear Log —
 * to the SAME outlined-red button the Emails section already uses for Force
 * Re-cache, and pins that they still do what they did before.
 *
 * The reference string is copied from EmailSettings.tsx's `force-recache-emails`
 * button (int/epic9-close @ c81aabfa9). EmailSettings.tsx is not edited by this
 * stage, and this suite does not render it — the tokens below are asserted on
 * the two buttons it does render.
 *
 * The negative half of the assertion matters as much as the positive half: a
 * positive-only check passes on a button that merely GAINED classes. The
 * `not.toHaveClass` list names the tinted-fill and extra-small tokens the two
 * buttons used to carry, so a revert to the old style fails here.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// --- The shared shape ------------------------------------------------------

/** Tokens every level-one red button carries. */
const RED_BUTTON = [
  "px-3",
  "py-2",
  "bg-white",
  "border",
  "border-red-300",
  "text-red-700",
  "hover:bg-red-50",
  "text-sm",
  "font-medium",
  "rounded",
  "transition-all",
];

/**
 * Tokens from the two tinted-fill styles these buttons used to carry. Present
 * on neither afterwards; listed so that reverting either restyle reds this
 * suite rather than passing on a superset of classes.
 */
const NOT_TINTED = [
  "bg-red-50",
  "border-red-200",
  "text-red-600",
  "text-xs",
  "py-1",
  "py-1.5",
  "px-2",
  "hover:bg-red-100",
  "transition-colors",
];

// --- Mocks -----------------------------------------------------------------

const mockNotifyError = jest.fn();
const mockNotifySuccess = jest.fn();
jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({
    notify: {
      error: (...args: unknown[]) => mockNotifyError(...args),
      success: (...args: unknown[]) => mockNotifySuccess(...args),
      warning: jest.fn(),
      info: jest.fn(),
    },
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  }),
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

let mockIsOnline = true;
jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: mockIsOnline }),
}));

const mockRequestSync = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], requestSync: mockRequestSync }),
}));

import { SecuritySettings } from "../SecuritySettings";
import { DataPrivacySettings } from "../DataPrivacySettings";

// --- window.api ------------------------------------------------------------

const mockGetActiveDevices = jest.fn();
const mockSignOutAllDevices = jest.fn();
const mockFailureLogGetRecent = jest.fn();
const mockFailureLogClear = jest.fn();
const mockBackupGetInfo = jest.fn();

const LOG_ENTRY = {
  id: 1,
  timestamp: new Date().toISOString(),
  operation: "sync",
  error_message: "network unreachable",
  metadata: null,
  acknowledged: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOnline = true;

  mockGetActiveDevices.mockResolvedValue({ success: true, devices: [] });
  mockSignOutAllDevices.mockResolvedValue({ success: true });
  mockFailureLogGetRecent.mockResolvedValue({
    success: true,
    entries: [LOG_ENTRY],
  });
  mockFailureLogClear.mockResolvedValue({ success: true });
  mockBackupGetInfo.mockResolvedValue({ success: false });

  (window as unknown as { api: unknown }).api = {
    auth: {
      getActiveDevices: (...a: unknown[]) => mockGetActiveDevices(...a),
      signOutAllDevices: (...a: unknown[]) => mockSignOutAllDevices(...a),
    },
    failureLog: {
      getRecent: (...a: unknown[]) => mockFailureLogGetRecent(...a),
      clear: (...a: unknown[]) => mockFailureLogClear(...a),
    },
    databaseBackup: {
      getInfo: (...a: unknown[]) => mockBackupGetInfo(...a),
    },
  };

  jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const renderSecurity = () =>
  render(
    <StrictMode>
      <SecuritySettings userId="user-1" />
    </StrictMode>,
  );

const renderDataPrivacy = () =>
  render(
    <StrictMode>
      <DataPrivacySettings userId="user-1" />
    </StrictMode>,
  );

const signOutButton = () =>
  screen.getByRole("button", { name: /sign out all devices/i });

const clearLogButton = () => screen.getByRole("button", { name: /clear log/i });

// --- Tests -----------------------------------------------------------------

describe("BACKLOG-3156 stage D — the one red button", () => {
  it("Sign Out All Devices wears the shared outlined red, not the old tinted fill", async () => {
    renderSecurity();
    const btn = await waitFor(() => signOutButton());

    expect(btn).toHaveClass(...RED_BUTTON);
    NOT_TINTED.forEach((token) => expect(btn).not.toHaveClass(token));
  });

  it("Clear Log wears the shared outlined red, not the old tinted fill", async () => {
    renderDataPrivacy();
    const btn = await waitFor(() => clearLogButton());

    expect(btn).toHaveClass(...RED_BUTTON);
    NOT_TINTED.forEach((token) => expect(btn).not.toHaveClass(token));
  });

  it("both buttons carry the SAME red — the point of the stage", async () => {
    const security = renderSecurity();
    const signOutClasses = new Set(
      (await waitFor(() => signOutButton())).className.split(/\s+/),
    );
    security.unmount();

    renderDataPrivacy();
    const clearClasses = new Set(
      (await waitFor(() => clearLogButton())).className.split(/\s+/),
    );

    // Every red/size token of the shared shape appears on both. Layout
    // modifiers (ml-4 on the Sign Out row, the disabled: pair) are allowed to
    // differ — they are placement and state, not the button's identity.
    RED_BUTTON.forEach((token) => {
      expect(signOutClasses.has(token)).toBe(true);
      expect(clearClasses.has(token)).toBe(true);
    });
  });

  it("Sign Out All Devices still signs out when clicked", async () => {
    renderSecurity();
    const btn = await waitFor(() => signOutButton());

    fireEvent.click(btn);

    await waitFor(() => expect(mockSignOutAllDevices).toHaveBeenCalledTimes(1));
  });

  it("Sign Out All Devices is still disabled offline, and clicking it does nothing", async () => {
    mockIsOnline = false;
    renderSecurity();
    const btn = await waitFor(() => signOutButton());

    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(mockSignOutAllDevices).not.toHaveBeenCalled();
  });

  it("Clear Log still clears the diagnostic log when clicked", async () => {
    renderDataPrivacy();
    const btn = await waitFor(() => clearLogButton());

    fireEvent.click(btn);

    await waitFor(() => expect(mockFailureLogClear).toHaveBeenCalledTimes(1));
  });

  it("Clear Log is still absent when the log is empty", async () => {
    mockFailureLogGetRecent.mockResolvedValue({ success: true, entries: [] });
    renderDataPrivacy();

    await waitFor(() => expect(mockFailureLogGetRecent).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /clear log/i }),
    ).not.toBeInTheDocument();
  });
});
