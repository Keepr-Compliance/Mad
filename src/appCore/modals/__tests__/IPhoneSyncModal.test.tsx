/**
 * BACKLOG-3416 — the sync modal does not minimise itself.
 *
 * TASK-2116 wired `onSyncStarted={onClose}` at IPhoneSyncModal.tsx:37, and
 * IPhoneSyncFlow fired that callback the moment `progress.phase` reached
 * `backing_up`. That phase says nothing about the PHONE: the user may still have
 * to unlock it, tap "Trust This Computer" and enter a passcode — which is exactly
 * what SyncProgress's amber panel is telling them to do when the modal vanishes.
 * The effect's only user-side guard was `needsPassword`, the LOCAL
 * backup-encryption prompt, which is a different thing entirely.
 *
 * WHY THIS TEST LIVES AT THE MODAL, NOT THE FLOW. The removed effect's guard
 * ended in `&& onSyncStarted`. With the prop gone from the interface, no
 * Flow-level test passes it, so restoring the old effect under such a test
 * leaves it GREEN — the guard is false and nothing fires. Line 37 of this file
 * is the only place the auto-close signal was ever connected to a real close
 * handler, so this is the only level at which the mutation can go red.
 * (Verified: the mutation was run. See the control note in the PR.)
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { IPhoneSyncModal } from "../IPhoneSyncModal";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const baseSync: UseIPhoneSyncReturn = {
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
  cancelSync: jest.fn(),
  dismissSync: jest.fn(),
  checkSyncStatus: jest.fn(),
  requestTrust: jest.fn(),
};

let mockContextValue: UseIPhoneSyncReturn = { ...baseSync };

jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));

jest.mock("../../../components/iphone/ConnectionStatus", () => ({
  ConnectionStatus: () => <div data-testid="connection-status">Connected</div>,
}));

jest.mock("../../../components/iphone/SyncProgress", () => ({
  SyncProgress: () => <div data-testid="sync-progress">Progress</div>,
}));

jest.mock("../../../components/iphone/BackupPasswordModal", () => ({
  BackupPasswordModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="password-modal">Password</div> : null,
}));

jest.mock("../../../components/sync/SyncLockBanner", () => ({
  SyncLockBanner: () => <div data-testid="sync-lock-banner">Locked</div>,
}));

/**
 * Real transfer is under way in every syncing fixture below: bytes and files
 * have moved. Without them, an auto-close re-added to fire only once transfer
 * starts ("bytesProcessed > 0") never sees its condition met and every test here
 * stays green. With them, both that variant and the original backing_up trigger
 * go red. (SR measured both, BACKLOG-3416.)
 */
const TRANSFERRING = { bytesProcessed: 500 * 1024 * 1024, processedFiles: 12 };

/** The phase the auto-close used to fire on, reached while the phone may still be locked. */
const backingUp: UseIPhoneSyncReturn = {
  ...baseSync,
  syncStatus: "syncing",
  progress: { phase: "backing_up", percent: 30, message: "Transferring…", ...TRANSFERRING },
};

describe("BACKLOG-3416: IPhoneSyncModal never minimises itself", () => {
  beforeEach(() => {
    mockContextValue = { ...baseSync };
  });

  it("does not close when the sync reaches backing_up", () => {
    const onClose = jest.fn();

    // Mount IDLE, then transition. Mounting already-syncing would be green for
    // the wrong reason: the removed effect's `wasAlreadySyncingOnMount` ref
    // suppressed the fire in that case, so the mutation could not go red.
    const { rerender } = render(<IPhoneSyncModal onClose={onClose} />);
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    mockContextValue = backingUp;
    rerender(<IPhoneSyncModal onClose={onClose} />);

    // The old behaviour fired here, hiding the trust/passcode instructions.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-progress")).toBeInTheDocument();
  });

  it("stays open across every later phase of the sync", () => {
    const onClose = jest.fn();
    const { rerender } = render(<IPhoneSyncModal onClose={onClose} />);

    for (const phase of ["backing_up", "extracting", "storing"] as const) {
      mockContextValue = {
        ...baseSync,
        syncStatus: "syncing",
        progress: { phase, percent: 40, ...TRANSFERRING },
      };
      rerender(<IPhoneSyncModal onClose={onClose} />);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it("still closes when the user clicks minimize — the only way out during a sync", () => {
    const onClose = jest.fn();
    const { rerender } = render(<IPhoneSyncModal onClose={onClose} />);

    mockContextValue = backingUp;
    rerender(<IPhoneSyncModal onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle(/Minimize/i));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
