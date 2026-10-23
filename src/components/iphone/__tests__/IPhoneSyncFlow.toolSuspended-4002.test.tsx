/**
 * BACKLOG-4002: the BACKUP_TIMEOUT message reaches the sync failure view as a title, the
 * numbered steps and the support line (like the 3996 time-out), and the suspended notice
 * from the hook is handed to SyncProgress.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn, UserFacingError } from "../../../types/iphone";
import {
  formatBackupWatchdogError,
  formatToolSuspendedNotice,
} from "../../../../electron/services/diagnostics/userFacingErrors";
import { BACKUP_TIMEOUT_CODE } from "../ToolBlockedNotice";

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
// The props IPhoneSyncFlow hands to SyncProgress, captured.
const mockSyncProgressProps: Array<Record<string, unknown>> = [];
jest.mock("../SyncProgress", () => ({
  SyncProgress: (props: Record<string, unknown>) => {
    mockSyncProgressProps.push(props);
    return <div data-testid="sync-progress">Progress</div>;
  },
}));
jest.mock("../../sync/SyncLockBanner", () => ({
  SyncLockBanner: () => <div data-testid="sync-lock-banner">Locked</div>,
}));

const B1: UserFacingError = formatBackupWatchdogError({ toolSuspendedAtTimeout: true, keeprFolder: null, platform: "win32" });
const B2: UserFacingError = formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: null, platform: "win32" });

describe("BACKLOG-4002 IPhoneSyncFlow", () => {
  beforeEach(() => {
    mockSyncProgressProps.length = 0;
  });

  it("the renderer's mirrored code string matches main's", () => {
    expect(BACKUP_TIMEOUT_CODE).toBe(B1.code);
  });

  it.each([["b1", B1], ["b2", B2]])("BACKUP_TIMEOUT %s: title, steps and support line in the failure view", (_n, msg) => {
    mockContextValue = { ...base(), syncStatus: "error", error: msg.description, userError: msg };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText(msg.title)).toBeInTheDocument();
    expect(screen.getByText(msg.description)).toBeInTheDocument();
    expect(screen.getByText("Select Try Again.")).toBeInTheDocument();
    expect(screen.getByText("If this keeps happening, contact support.")).toBeInTheDocument();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
  });

  it("hands the hook's suspended notice to SyncProgress", () => {
    const notice = formatToolSuspendedNotice(null);
    mockContextValue = {
      ...base(),
      syncStatus: "syncing",
      progress: { phase: "backing_up", percent: 0, message: "x" },
      toolSuspendedNotice: notice,
    };
    render(<IPhoneSyncFlow />);
    expect(screen.getByTestId("sync-progress")).toBeInTheDocument();
    expect(mockSyncProgressProps.at(-1)?.toolSuspendedNotice).toEqual(notice);
  });
});
