/**
 * BACKLOG-3363: the Sync iPhone window on a Windows on ARM PC.
 *
 * Real ConnectionStatus (not mocked). The flag comes from the preload bridge
 * synchronously (window.api.system.isWindowsArm64), so the unsupported view
 * must be there on the FIRST render — no await / waitFor. It wins over the
 * driver-missing install view and the Trust hint.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";
import { WINDOWS_ARM64_UNSUPPORTED_HEADING } from "../../../constants/windowsArm64Copy";

const baseContext: UseIPhoneSyncReturn = {
  isConnected: false,
  device: null,
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
  driverMissing: true,
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
};

let mockContextValue: UseIPhoneSyncReturn = { ...baseContext };
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));
jest.mock("../SyncProgress", () => ({ SyncProgress: () => <div>Progress</div> }));
jest.mock("../../sync/SyncLockBanner", () => ({ SyncLockBanner: () => <div>Locked</div> }));

function setArmFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isWindowsArm64;
  else system.isWindowsArm64 = value;
}

describe("IPhoneSyncFlow on Windows on ARM (BACKLOG-3363)", () => {
  afterEach(() => setArmFlag(undefined));

  it("ARM + driverMissing: unsupported heading on first render, no Install button, no Trust hint", () => {
    setArmFlag(true);
    mockContextValue = { ...baseContext, driverMissing: true };
    render(<IPhoneSyncFlow />);
    // Synchronous: no waitFor.
    expect(screen.getByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install Apple Mobile Device Support/i })).toBeNull();
    expect(screen.queryByText(/Don.t see your iPhone/i)).toBeNull();
    expect(screen.queryByText("Connect Your iPhone")).toBeNull();
    expect(screen.queryByText(/Install iTunes/i)).toBeNull();
  });

  it("ARM, no driverMissing: unsupported heading, no connect prompt / Trust hint", () => {
    setArmFlag(true);
    mockContextValue = { ...baseContext, driverMissing: false };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    expect(screen.queryByText("Connect Your iPhone")).toBeNull();
    expect(screen.queryByText(/Don.t see your iPhone/i)).toBeNull();
  });

  it("normal PC (flag absent) + driverMissing: install view, no unsupported heading", () => {
    mockContextValue = { ...baseContext, driverMissing: true };
    render(<IPhoneSyncFlow />);
    expect(screen.getByRole("button", { name: /Install Apple Mobile Device Support/i })).toBeInTheDocument();
    expect(screen.queryByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeNull();
  });

  it("normal PC (flag false), no driverMissing: connect prompt + Trust hint", () => {
    setArmFlag(false);
    mockContextValue = { ...baseContext, driverMissing: false };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(screen.queryByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeNull();
  });
});
