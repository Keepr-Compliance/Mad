/**
 * BACKLOG-3927: the Sync iPhone window in the Microsoft Store build. Real
 * ConnectionStatus; the flag comes from window.api.system.isStoreBuild. With
 * the driver missing, the Apple Devices guide replaces the Install button, and
 * Check again runs the hook's recheckDriver.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";
import userEvent from "@testing-library/user-event";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  CHECKLIST_APPLE_DEVICES_INSTALL,
} from "../../../constants/appleDevicesStoreCopy";

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
  recheckDriver: jest.fn(async () => "not-installed" as const),
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
};

let mockContextValue: UseIPhoneSyncReturn = { ...baseContext };
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));
jest.mock("../SyncProgress", () => ({ SyncProgress: () => <div>Progress</div> }));
jest.mock("../../sync/SyncLockBanner", () => ({ SyncLockBanner: () => <div>Locked</div> }));

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}

describe("IPhoneSyncFlow in the Store build (BACKLOG-3927)", () => {
  afterEach(() => setStoreFlag(undefined));

  it("Store + driverMissing: Apple Devices guide, no Install button; Check again calls recheckDriver", async () => {
    setStoreFlag(true);
    const recheckDriver = jest.fn(async () => "not-installed" as const);
    mockContextValue = { ...baseContext, driverMissing: true, recheckDriver, appleDevicesState: "not-installed" };
    render(<IPhoneSyncFlow />);
    expect(screen.getByTestId("iphone-setup-checklist")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install Apple Mobile Device Support/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(recheckDriver).toHaveBeenCalled();
    expect(baseContext.recoverInstallDriver).not.toHaveBeenCalled();
  });

  it("Store + usb-driver-missing: the hook's USB-driver reading reaches the checklist (row 2 open)", () => {
    setStoreFlag(true);
    mockContextValue = { ...baseContext, driverMissing: false, appleDevicesState: "usb-driver-missing", appleUsbDriver: "missing" };
    render(<IPhoneSyncFlow />);
    expect(screen.getByTestId("setup-row-usbDriver")).toHaveAttribute("data-status", "open");
    expect(screen.queryByTestId("setup-row-iphone")).toBeNull();
  });

  it("Store + ready: both rows met, the normal Connect screen shows (no checklist)", () => {
    setStoreFlag(true);
    mockContextValue = { ...baseContext, driverMissing: false, appleDevicesState: "ready", appleUsbDriver: "bound" };
    render(<IPhoneSyncFlow />);
    expect(screen.queryByTestId("iphone-setup-checklist")).toBeNull();
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
  });

  it("reports the Connect screen shown, and not shown once it unmounts or another view takes over", () => {
    const setConnectScreenActive = jest.fn();
    mockContextValue = { ...baseContext, setConnectScreenActive };
    const { unmount, rerender } = render(<IPhoneSyncFlow />);
    expect(setConnectScreenActive).toHaveBeenLastCalledWith(true);
    mockContextValue = { ...baseContext, setConnectScreenActive, syncStatus: "syncing", progress: { phase: "backup", percent: 1, message: "x" } as never };
    rerender(<IPhoneSyncFlow />);
    expect(setConnectScreenActive).toHaveBeenLastCalledWith(false);
    mockContextValue = { ...baseContext, setConnectScreenActive };
    rerender(<IPhoneSyncFlow />);
    expect(setConnectScreenActive).toHaveBeenLastCalledWith(true);
    unmount();
    expect(setConnectScreenActive).toHaveBeenLastCalledWith(false);
  });

  it("website build (flag absent) + driverMissing: Install button, no guide", () => {
    mockContextValue = { ...baseContext, driverMissing: true };
    render(<IPhoneSyncFlow />);
    expect(screen.getByRole("button", { name: /Install Apple Mobile Device Support/i })).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_INSTALL)).toBeNull();
  });
});
