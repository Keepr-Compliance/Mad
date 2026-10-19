/**
 * BACKLOG-3996 (SR R1): an iPhone query that timed out reaches the sync failure view as
 * a title, the numbered steps and the contact-support line — not the one-line
 * description. The Connect screen does not show it (a time-out happens during a sync).
 * The copy itself is pinned here, verbatim, against the electron formatter.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn, UserFacingError } from "../../../types/iphone";
import {
  formatIphoneToolTimeoutError,
  formatToolBlockedError,
  SUPPORT_CLOSING_LINE,
} from "../../../../electron/services/diagnostics/userFacingErrors";
import { IPHONE_TOOL_TIMEOUT_CODE } from "../ToolBlockedNotice";

const base = (): UseIPhoneSyncReturn => ({
  isConnected: true,
  device: {
    udid: "test-udid",
    name: "Test iPhone",
    productType: "iPhone14,2",
    productVersion: "17.0",
    serialNumber: "ABC123",
    isConnected: true,
  },
  syncStatus: "idle",
  progress: null,
  error: null,
  userError: null,
  appleEncryptedBackup: false,
  lastSyncTime: null,
  isWaitingForPasscode: false,
  syncLocked: false,
  lockReason: null,
  needsTrust: false,
  needsTrustUdid: null,
  toolsMissing: false,
  driverMissing: false,
  installDriverStatus: "idle",
  installDriverError: null,
  recoverInstallDriver: jest.fn(),
  recheckDriver: jest.fn(),
  setConnectScreenActive: jest.fn(),
  appleDevicesState: null,
  appleUsbDriver: null,
  startSync: jest.fn(),
  cancelSync: jest.fn(),
  dismissSync: jest.fn(),
  checkSyncStatus: jest.fn(),
  requestTrust: jest.fn(),
  isStarting: false,
  retryAvailableAt: null,
});

let mockContextValue: UseIPhoneSyncReturn = base();
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));
jest.mock("../ConnectionStatus", () => ({
  ConnectionStatus: () => <div data-testid="connection-status">Connect</div>,
}));
jest.mock("../SyncProgress", () => ({
  SyncProgress: () => <div data-testid="sync-progress">Progress</div>,
}));
jest.mock("../../sync/SyncLockBanner", () => ({
  SyncLockBanner: () => <div data-testid="sync-lock-banner">Locked</div>,
}));

// The exact object main sends (electron formatter), not a hand-written copy.
const TIMEOUT: UserFacingError = formatIphoneToolTimeoutError();

describe("BACKLOG-3996 copy", () => {
  it("is the approved wording, steps one per line, ending with the support line", () => {
    expect(TIMEOUT).toEqual({
      title: "This is taking longer than expected",
      description:
        "Keepr stopped waiting for your iPhone after 90 seconds. Sometimes security software pauses Keepr's iPhone tools while it checks them.",
      actionSuggestion: [
        "1. Make sure your iPhone is unlocked and still connected.",
        "2. If your antivirus is showing an alert about Keepr, choose to allow it.",
        "3. Wait a moment, then select Try Again.",
        "If this keeps happening, contact support.",
      ].join("\n"),
      code: "IPHONE_TOOL_TIMEOUT",
    });
    expect(TIMEOUT.actionSuggestion.split("\n").pop()).toBe(SUPPORT_CLOSING_LINE);
    // The renderer's mirrored code string matches main's.
    expect(IPHONE_TOOL_TIMEOUT_CODE).toBe(TIMEOUT.code);
    // Not the antivirus-blocked message.
    const blocked = formatToolBlockedError();
    expect(TIMEOUT.title).not.toBe(blocked.title);
    expect(TIMEOUT.description).not.toBe(blocked.description);
  });
});

describe("BACKLOG-3996 IPhoneSyncFlow: iPhone query timed out", () => {
  it("sync failure view shows the title, the steps and the support line", () => {
    mockContextValue = { ...base(), syncStatus: "error", error: TIMEOUT.description, userError: TIMEOUT };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText("This is taking longer than expected")).toBeInTheDocument();
    expect(screen.getByText(TIMEOUT.description)).toBeInTheDocument();
    expect(screen.getByText("Make sure your iPhone is unlocked and still connected.")).toBeInTheDocument();
    expect(screen.getByText("If your antivirus is showing an alert about Keepr, choose to allow it.")).toBeInTheDocument();
    expect(screen.getByText("Wait a moment, then select Try Again.")).toBeInTheDocument();
    expect(screen.getByText("If this keeps happening, contact support.")).toBeInTheDocument();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-error-message")).not.toBeInTheDocument();
  });

  it("the Connect screen does not show it", () => {
    mockContextValue = { ...base(), isConnected: false, device: null, userError: TIMEOUT };
    render(<IPhoneSyncFlow />);
    expect(screen.queryByText("This is taking longer than expected")).not.toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
  });
});
