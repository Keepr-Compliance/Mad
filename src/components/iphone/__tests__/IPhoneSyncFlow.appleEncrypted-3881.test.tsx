/**
 * BACKLOG-3881: Keepr does not read Apple-encrypted iPhone backups. When the last sync
 * stopped for that reason, the flow shows the steps to turn "Encrypt local backup" off —
 * never a password box, never the generic "Sync Failed". Sync Again starts ONE sync.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

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

const MAIN_MESSAGE =
  "Your iPhone backups are password-protected by Apple. Keepr can't read password-protected backups.";

describe("BACKLOG-3881 IPhoneSyncFlow: Apple-encrypted backup", () => {
  it("shows the turn-off steps, and no password box anywhere", () => {
    mockContextValue = { ...base(), syncStatus: "error", error: MAIN_MESSAGE, appleEncryptedBackup: true };
    const { container } = render(<IPhoneSyncFlow />);

    expect(screen.getByTestId("apple-encrypted-backup")).toBeInTheDocument();
    expect(screen.getByText("Your iPhone backups are password-protected by Apple")).toBeInTheDocument();
    expect(screen.getByText("Keepr can't read password-protected backups.")).toBeInTheDocument();
    expect(screen.getByText(/Open Finder \(Mac\) or Apple Devices \(Windows\) and select your iPhone\./)).toBeInTheDocument();
    expect(screen.getByText("Encrypt local backup")).toBeInTheDocument();
    expect(screen.getByText("Come back and press Sync again.")).toBeInTheDocument();
    expect(screen.getByText(/Keepr encrypts its own copy of your messages/)).toBeInTheDocument();

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
  });

  it("Sync Again starts exactly one sync (no automatic retry)", () => {
    mockContextValue = { ...base(), syncStatus: "error", error: MAIN_MESSAGE, appleEncryptedBackup: true };
    render(<IPhoneSyncFlow />);
    expect(mockContextValue.startSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sync Again" }));
    expect(mockContextValue.startSync).toHaveBeenCalledTimes(1);
  });

  it("an ordinary failure still shows Sync Failed, not the encryption steps", () => {
    mockContextValue = { ...base(), syncStatus: "error", error: "lost" };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.queryByTestId("apple-encrypted-backup")).not.toBeInTheDocument();
  });
});
