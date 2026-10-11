/**
 * BACKLOG-3816 (phantom cancel): every control in the iPhone sync flow that cancels a
 * sync names itself, so main can record which one ended the run. (BACKLOG-3881 removed
 * the backup-password modal and its "password-cancel" trigger.)
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

const mockInfo = jest.fn();
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: (...a: unknown[]) => mockInfo(...a), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockContextValue: UseIPhoneSyncReturn;
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));
jest.mock("../SyncProgress", () => ({
  SyncProgress: ({ onCancel }: { onCancel?: () => void }) => (
    <button data-testid="progress-cancel" onClick={() => onCancel?.()}>Cancel</button>
  ),
}));
jest.mock("../../sync/SyncLockBanner", () => ({
  SyncLockBanner: () => <div>Locked</div>,
}));

const DEVICE = {
  udid: "u-3816",
  name: "Test iPhone",
  productType: "iPhone17,1",
  productVersion: "26.6",
  serialNumber: "S3816",
  isConnected: true,
};

function state(over: Partial<UseIPhoneSyncReturn>): UseIPhoneSyncReturn {
  return {
    isConnected: true,
    device: DEVICE,
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
    cancelSync: jest.fn(() => Promise.resolve()),
    dismissSync: jest.fn(),
    checkSyncStatus: jest.fn(),
    requestTrust: jest.fn(),
    ...over,
  } as UseIPhoneSyncReturn;
}

beforeEach(() => mockInfo.mockClear());

describe("BACKLOG-3816: each cancel control names its trigger", () => {
  it("progress Cancel -> progress-cancel", () => {
    mockContextValue = state({ syncStatus: "syncing", progress: { phase: "backing_up", percent: 0, message: "" } });
    render(<IPhoneSyncFlow />);
    fireEvent.click(screen.getByTestId("progress-cancel"));
    expect(mockContextValue.cancelSync).toHaveBeenCalledWith("progress-cancel");
    expect(mockInfo).toHaveBeenCalledWith("[IPhoneSyncFlow] Cancel clicked");
  });

  it("error Close -> error-close", () => {
    mockContextValue = state({ syncStatus: "error", error: "x" });
    render(<IPhoneSyncFlow onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mockContextValue.cancelSync).toHaveBeenCalledWith("error-close");
  });

  it("Try Again with no phone -> try-again-no-device", () => {
    mockContextValue = state({ syncStatus: "error", error: "x", isConnected: false, device: null });
    render(<IPhoneSyncFlow />);
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(mockContextValue.cancelSync).toHaveBeenCalledWith("try-again-no-device");
  });

  it("BACKLOG-3881: Apple-encrypted Close -> error-close", () => {
    mockContextValue = state({ syncStatus: "error", error: "x", appleEncryptedBackup: true });
    render(<IPhoneSyncFlow onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mockContextValue.cancelSync).toHaveBeenCalledWith("error-close");
  });
});
