/**
 * BACKLOG-3463 — Try Again must survive the phone going away, and with no
 * phone it takes the user to the "Connect Your iPhone" step.
 *
 * Founder, on the dev build, evening of 2026-09-19.
 * Pulling the cable mid-sync renders the failed-sync frame while `isConnected`
 * is still true; the detector's device-disconnected lands ~1.8 s later and the
 * button unmounted under him (dev log 20:40:18.500 → 20:40:20.263).
 *
 * WHAT THESE TWO TESTS CAN AND CANNOT SEE. The context is mocked, so the
 * reset that `cancelSync` performs is applied by this file, not by the hook.
 * It is transcribed from `useIPhoneSync.ts:1053-1059` (`setSyncStatus("idle")`,
 * `setProgress(null)`, `setNeedsPassword(false)`, `setError(null)`,
 * `setSyncLocked(false)`) and NOT invented — and that the real `cancelSync`
 * actually produces that state from an error is asserted separately, against
 * the real hook, in `src/hooks/__tests__/useIPhoneSync.test.ts`
 * ("BACKLOG-3463: cancelSync clears a sync error back to idle"). Read the two
 * together; either alone leaves a gap.
 *
 * `ConnectionStatus` is deliberately NOT mocked here (it and
 * `TrustComputerHint` are pure), so the assertion lands on the real copy the
 * founder will see rather than on a test double that would agree with anything.
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

const CONNECTED_DEVICE = {
  udid: "test-udid-3463",
  name: "Test iPhone",
  productType: "iPhone16,1",
  productVersion: "26.0",
  serialNumber: "SERIAL3463",
  isConnected: true,
};

let mockContextValue: UseIPhoneSyncReturn;

jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));

// Not exercised by either test — the flow resolves to `error` then
// `connection`. Mocked only to keep these tests off unrelated surfaces.
jest.mock("../SyncProgress", () => ({
  SyncProgress: () => <div data-testid="sync-progress">Progress</div>,
}));
jest.mock("../BackupPasswordModal", () => ({
  BackupPasswordModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="password-modal">Password</div> : null,
}));
jest.mock("../../sync/SyncLockBanner", () => ({
  SyncLockBanner: () => <div data-testid="sync-lock-banner">Locked</div>,
}));

/** The reset `cancelSync` applies — transcribed from useIPhoneSync.ts:1053-1059. */
const applyCancelSyncReset = () => {
  mockContextValue = {
    ...mockContextValue,
    syncStatus: "idle",
    progress: null,
    needsPassword: false,
    error: null,
    userError: null,
    syncLocked: false,
    lockReason: null,
  };
};

/**
 * The state the founder was in: the sync has failed, and the phone is gone (or
 * still present, per `isConnected`). Progress is non-null because the failure
 * happened mid-backup, which is the case that reaches the error frame.
 */
const makeErrorState = (isConnected: boolean): UseIPhoneSyncReturn => ({
  isConnected,
  device: isConnected ? CONNECTED_DEVICE : null,
  syncStatus: "error",
  progress: { phase: "backing_up", percent: 42, message: "Backing up iPhone..." },
  error: "Device disconnected during sync",
  userError: null,
  needsPassword: false,
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
  submitPassword: jest.fn(),
  cancelSync: jest.fn(() => {
    applyCancelSyncReset();
    return Promise.resolve();
  }),
  dismissSync: jest.fn(),
  checkSyncStatus: jest.fn(),
  requestTrust: jest.fn(),
});

const CONNECT_STEP_COPY =
  /Connect your iPhone using a USB cable to sync messages and contacts/i;

const renderFlow = () => render(
  <StrictMode>
    <IPhoneSyncFlow />
  </StrictMode>,
);

const rerenderFlow = (rerender: (ui: React.ReactElement) => void) =>
  rerender(
    <StrictMode>
      <IPhoneSyncFlow />
    </StrictMode>,
  );

describe("BACKLOG-3463: Try Again on the Sync Failed screen", () => {
  it("stays on screen with no phone connected, and takes the user to the connect step", () => {
    mockContextValue = makeErrorState(false);
    const { startSync, cancelSync } = mockContextValue;

    const { rerender } = renderFlow();

    // The screen the founder is looking at: Sync Failed, phone already gone.
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_STEP_COPY)).not.toBeInTheDocument();

    const tryAgain = screen.getByRole("button", { name: /try again/i });
    expect(tryAgain).toBeInTheDocument();

    fireEvent.click(tryAgain);
    rerenderFlow(rerender);

    // Lands on the existing "Connect Your iPhone" step — real ConnectionStatus copy.
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(screen.getByText(CONNECT_STEP_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();

    // And it did NOT retry a sync that has no device to run against.
    expect(cancelSync).toHaveBeenCalledTimes(1);
    expect(startSync).not.toHaveBeenCalled();
  });

  it("still retries the sync when the phone IS connected", () => {
    mockContextValue = makeErrorState(true);
    const { startSync, cancelSync } = mockContextValue;

    const { rerender } = renderFlow();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    rerenderFlow(rerender);

    expect(startSync).toHaveBeenCalledTimes(1);
    expect(cancelSync).not.toHaveBeenCalled();
    expect(screen.queryByText(CONNECT_STEP_COPY)).not.toBeInTheDocument();
  });
});
