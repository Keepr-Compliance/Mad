/**
 * BACKLOG-3953: the restore steps for a blocked iPhone tool reach the screen — on the
 * sync failure view and on the Connect screen — and every other failure keeps its
 * one-line message.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn, UserFacingError } from "../../../types/iphone";
import { formatToolBlockedError } from "../../../../electron/services/diagnostics/userFacingErrors";

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
const BLOCKED: UserFacingError = formatToolBlockedError("C:\\Program Files\\Keepr");

function expectSteps() {
  expect(screen.getByTestId("tool-blocked-notice")).toBeInTheDocument();
  expect(screen.getByText("Your antivirus blocked Keepr's iPhone tools")).toBeInTheDocument();
  expect(screen.getByText("Open your antivirus program.")).toBeInTheDocument();
  expect(screen.getByText("Open its Quarantine list.")).toBeInTheDocument();
  expect(screen.getByText("Restore Keepr's files from there.")).toBeInTheDocument();
  expect(screen.getByText("Add an exception for the Keepr folder: C:\\Program Files\\Keepr")).toBeInTheDocument();
  expect(screen.getByText("Close Keepr and open it again.")).toBeInTheDocument();
  expect(screen.getByText("If this keeps happening, contact support.")).toBeInTheDocument();
}

describe("BACKLOG-3953 IPhoneSyncFlow: blocked iPhone tool", () => {
  it("sync failure view shows the steps instead of the one-line error", () => {
    mockContextValue = { ...base(), syncStatus: "error", error: BLOCKED.description, userError: BLOCKED };
    render(<IPhoneSyncFlow />);
    expectSteps();
    expect(screen.queryByTestId("sync-error-message")).not.toBeInTheDocument();
  });

  it("Connect screen shows the steps above the connect view", () => {
    mockContextValue = { ...base(), isConnected: false, device: null, userError: BLOCKED };
    render(<IPhoneSyncFlow />);
    expectSteps();
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
  });

  it("any other structured error keeps the one-line message and no steps", () => {
    const other = { code: "MISSING_DRIVERS", title: "t", description: "d", actionSuggestion: "a" };
    mockContextValue = { ...base(), syncStatus: "error", error: "Sync tools not installed", userError: other };
    render(<IPhoneSyncFlow />);
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent("Sync tools not installed");
    expect(screen.queryByTestId("tool-blocked-notice")).not.toBeInTheDocument();
  });
});
