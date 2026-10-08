/**
 * BACKLOG-1926: the Sync iPhone window says which step a plugged-in iPhone is
 * waiting on — "Unlock your iPhone to continue", "Tap Trust on your iPhone,
 * then enter your passcode", "Connected" — instead of "Connect Your iPhone"
 * until the phone finally connects.
 *
 * Path under test: main `device-trust-state` -> preload `onTrustState` ->
 * useIPhoneSync `trustState` -> IPhoneSyncFlow -> real ConnectionStatus.
 * Event payload states are the ones DeviceDetectionService emits
 * (electron/services/deviceDetectionService.ts `DeviceTrustState`).
 */
import React from "react";
import { render, screen, renderHook, act } from "@testing-library/react";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import { useIPhoneSync } from "../../../hooks/useIPhoneSync";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";
import { WINDOWS_ARM64_UNSUPPORTED_HEADING } from "../../../constants/windowsArm64Copy";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: true, isMacOS: false, isLinux: false, platform: "windows" }),
}));

const baseContext: UseIPhoneSyncReturn = {
  isConnected: false,
  device: null,
  syncStatus: "idle",
  progress: null,
  error: null,
  userError: null,
  needsPassword: false,
  lastSyncTime: null,
  isWaitingForPasscode: false,
  syncLocked: false,
  lockReason: null,
  needsTrust: false,
  needsTrustUdid: null,
  trustState: null,
  toolsMissing: false,
  driverMissing: false,
  installDriverStatus: "idle",
  installDriverError: null,
  recoverInstallDriver: jest.fn(),
  startSync: jest.fn(),
  submitPassword: jest.fn(),
  cancelSync: jest.fn(),
  dismissSync: jest.fn(),
  checkSyncStatus: jest.fn(),
  requestTrust: jest.fn(),
};

let mockContextValue: UseIPhoneSyncReturn = { ...baseContext };
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));
jest.mock("../SyncProgress", () => ({ SyncProgress: () => <div>Progress</div> }));
jest.mock("../BackupPasswordModal", () => ({ BackupPasswordModal: () => null }));
jest.mock("../../sync/SyncLockBanner", () => ({ SyncLockBanner: () => <div>Locked</div> }));

function setArmFlag(value: boolean | undefined) {
  const api = window.api as unknown as { system?: Record<string, unknown> };
  if (!api.system) api.system = {};
  if (value === undefined) delete api.system.isWindowsArm64;
  else api.system.isWindowsArm64 = value;
}

describe("IPhoneSyncFlow trust steps (BACKLOG-1926)", () => {
  afterEach(() => {
    mockContextValue = { ...baseContext };
    setArmFlag(undefined);
  });

  it("locked -> Trust dialog -> trusted shows three different headings", () => {
    mockContextValue = { ...baseContext, trustState: "locked" };
    const { rerender } = render(<IPhoneSyncFlow />);
    expect(screen.getByRole("heading", { name: "Unlock your iPhone to continue" })).toBeInTheDocument();
    expect(screen.queryByText("Connect Your iPhone")).not.toBeInTheDocument();

    mockContextValue = { ...baseContext, trustState: "trust_pending" };
    rerender(<IPhoneSyncFlow />);
    expect(
      screen.getByRole("heading", { name: "Tap Trust on your iPhone, then enter your passcode" }),
    ).toBeInTheDocument();

    mockContextValue = { ...baseContext, trustState: "trusted" };
    rerender(<IPhoneSyncFlow />);
    expect(screen.getByRole("heading", { name: "Connected" })).toBeInTheDocument();
  });

  it("declined: tells the user to unplug and replug", () => {
    mockContextValue = { ...baseContext, trustState: "denied" };
    render(<IPhoneSyncFlow />);
    expect(screen.getByRole("heading", { name: "Trust was declined" })).toBeInTheDocument();
    expect(screen.getByText(/Unplug your iPhone, plug it back in/)).toBeInTheDocument();
  });

  it("no trust state: the normal Connect Your iPhone screen", () => {
    render(<IPhoneSyncFlow />);
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(screen.queryByTestId("iphone-trust-state")).not.toBeInTheDocument();
  });

  it("connected wins over a leftover trust state (device card shown)", () => {
    mockContextValue = {
      ...baseContext,
      trustState: "trusted",
      isConnected: true,
      device: { udid: "u", name: "Test iPhone", productType: "iPhone14,2", productVersion: "17.0", serialNumber: "s", isConnected: true },
    };
    render(<IPhoneSyncFlow />);
    expect(screen.getByRole("heading", { name: "Test iPhone" })).toBeInTheDocument();
    expect(screen.queryByTestId("iphone-trust-state")).not.toBeInTheDocument();
  });

  it("Windows on ARM (BACKLOG-3363): the unsupported view wins over a trust state", () => {
    setArmFlag(true);
    mockContextValue = { ...baseContext, trustState: "locked" };
    render(<IPhoneSyncFlow />);
    expect(screen.getByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    expect(screen.queryByTestId("iphone-trust-state")).not.toBeInTheDocument();
  });
});

describe("useIPhoneSync trustState (BACKLOG-1926)", () => {
  let trustCb: ((d: { udid: string; state: string }) => void) | null;
  let connectedCb: ((d: unknown) => void) | null;
  let onTrustState: jest.Mock;
  const savedApi = (window as unknown as { api: unknown }).api;

  beforeEach(() => {
    trustCb = null;
    connectedCb = null;
    onTrustState = jest.fn((cb) => {
      trustCb = cb;
      return jest.fn();
    });
    (window as unknown as { api: unknown }).api = {
      device: {
        startDetection: jest.fn(),
        stopDetection: jest.fn(),
        onConnected: jest.fn((cb) => {
          connectedCb = cb;
          return jest.fn();
        }),
        onDisconnected: jest.fn(() => jest.fn()),
        onTrustState,
      },
      backup: { checkStatus: jest.fn().mockResolvedValue({ success: true }) },
    };
  });

  afterEach(() => {
    (window as unknown as { api: unknown }).api = savedApi;
  });

  it("follows the main process: locked -> trust_pending -> trusted -> connected clears it", () => {
    const { result } = renderHook(() => useIPhoneSync(true));
    expect(result.current.trustState).toBeNull();

    act(() => trustCb?.({ udid: "u", state: "locked" }));
    expect(result.current.trustState).toBe("locked");
    act(() => trustCb?.({ udid: "u", state: "trust_pending" }));
    expect(result.current.trustState).toBe("trust_pending");
    act(() => trustCb?.({ udid: "u", state: "trusted" }));
    expect(result.current.trustState).toBe("trusted");

    act(() =>
      connectedCb?.({ udid: "u", name: "Test iPhone", productType: "iPhone14,2", productVersion: "17.0", serialNumber: "s", isConnected: true }),
    );
    expect(result.current.trustState).toBeNull();
  });

  it("'cleared' (unplugged) returns to no state", () => {
    const { result } = renderHook(() => useIPhoneSync(true));
    act(() => trustCb?.({ udid: "u", state: "trust_pending" }));
    act(() => trustCb?.({ udid: "u", state: "cleared" }));
    expect(result.current.trustState).toBeNull();
  });

  it("detection off (BACKLOG-3418): does not subscribe", () => {
    renderHook(() => useIPhoneSync(false));
    expect(onTrustState).not.toHaveBeenCalled();
  });
});
