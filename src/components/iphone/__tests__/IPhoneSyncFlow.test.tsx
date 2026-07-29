/**
 * Tests for IPhoneSyncFlow component
 * TASK-2116: Tests re-open modal redirect message during active sync
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

// Mock the context
const mockSyncReturn: UseIPhoneSyncReturn = {
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
  // BACKLOG-1919: Apple-driver recovery state + action
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

let mockContextValue: UseIPhoneSyncReturn = { ...mockSyncReturn };

jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));

// Mock sub-components to simplify tests
jest.mock("../ConnectionStatus", () => ({
  ConnectionStatus: ({ isConnected }: { isConnected: boolean }) => (
    <div data-testid="connection-status">
      {isConnected ? "Connected" : "Disconnected"}
    </div>
  ),
}));

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

describe("IPhoneSyncFlow", () => {
  beforeEach(() => {
    mockContextValue = { ...mockSyncReturn };
  });

  it("shows connection status when idle", () => {
    render(<IPhoneSyncFlow />);
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
  });

  it("shows sync progress when re-opening modal during active sync", () => {
    const onClose = jest.fn();
    const onSyncStarted = jest.fn();

    // Start from idle (modal opened before sync starts)
    const { rerender } = render(
      <IPhoneSyncFlow onClose={onClose} onSyncStarted={onSyncStarted} />
    );

    // Transition to syncing (user clicked Sync — wasAlreadySyncingOnMount is false)
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "syncing",
      progress: {
        phase: "backing_up",
        percent: 30,
        message: "Importing...",
      },
    };

    rerender(
      <IPhoneSyncFlow onClose={onClose} onSyncStarted={onSyncStarted} />
    );

    // onSyncStarted should have been called (triggering modal auto-close)
    expect(onSyncStarted).toHaveBeenCalledTimes(1);

    // Should show the SyncProgress component (full details in modal)
    expect(screen.getByTestId("sync-progress")).toBeInTheDocument();
  });

  it("shows sync progress during extracting phase after auto-close", () => {
    const onClose = jest.fn();
    const onSyncStarted = jest.fn();

    // Start from idle, then transition to syncing
    const { rerender } = render(
      <IPhoneSyncFlow onClose={onClose} onSyncStarted={onSyncStarted} />
    );

    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "syncing",
      progress: {
        phase: "backing_up",
        percent: 30,
      },
    };

    rerender(
      <IPhoneSyncFlow onClose={onClose} onSyncStarted={onSyncStarted} />
    );

    expect(onSyncStarted).toHaveBeenCalledTimes(1);

    // Progress moves to extracting phase
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "syncing",
      progress: {
        phase: "extracting",
        percent: 50,
        message: "Reading messages...",
      },
    };

    rerender(
      <IPhoneSyncFlow onClose={onClose} onSyncStarted={onSyncStarted} />
    );

    // Should show SyncProgress component with full details
    expect(screen.getByTestId("sync-progress")).toBeInTheDocument();
  });

  // BACKLOG-2333: Cancel resets to the clean idle state. Reopening the modal
  // after a cancel (idle, no progress) must show the NORMAL start/connection
  // screen — never blank, never a "Sync Cancelled" message.
  it("shows the connection (start) screen after cancel — never 'Sync Cancelled'", () => {
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "idle",
      progress: null,
    };

    render(<IPhoneSyncFlow />);

    // Identity: the start screen renders and NOTHING else.
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    expect(screen.queryByText("Sync Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Complete!")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sync-progress")).not.toBeInTheDocument();
  });

  // BACKLOG-2333: "Sync Cancelled" copy must not exist anywhere in the flow.
  it("never renders 'Sync Cancelled' copy in any terminal state", () => {
    for (const s of ["idle", "complete", "error"] as const) {
      mockContextValue = {
        ...mockSyncReturn,
        syncStatus: s,
        progress: s === "complete" ? { phase: "complete", percent: 100, message: "done" } : null,
        error: s === "error" ? "boom" : null,
      };
      const { unmount } = render(<IPhoneSyncFlow />);
      expect(screen.queryByText("Sync Cancelled")).not.toBeInTheDocument();
      unmount();
    }
  });

  // BACKLOG-2333: The render is provably total (single computed view with a
  // ConnectionStatus default), so a stale `idle + progress≠null` combo carried
  // over on reopen renders the start screen — NOT a blank container.
  it("never renders blank: idle + stale progress falls back to the connection screen", () => {
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "idle",
      progress: { phase: "backing_up", percent: 42, message: "stale" },
    };

    render(<IPhoneSyncFlow />);

    // Identity: connection screen renders; no progress/success/cancelled views.
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Complete!")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Cancelled")).not.toBeInTheDocument();
  });

  // BACKLOG-2333: The other proven gap combo — `complete + progress=null` — also
  // falls back to the connection screen instead of a blank container.
  it("never renders blank: complete without progress falls back to the connection screen", () => {
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "complete",
      progress: null,
    };

    render(<IPhoneSyncFlow />);

    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    // Success screen requires progress, so it must NOT render here.
    expect(screen.queryByText("Sync Complete!")).not.toBeInTheDocument();
  });

  // BACKLOG-2328 regression: a genuine completion still shows the success screen.
  it("shows 'Sync Complete!' when syncStatus is complete", () => {
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "complete",
      progress: {
        phase: "complete",
        percent: 100,
        message: "Saved 500 messages and 50 contacts",
      },
    };

    render(<IPhoneSyncFlow />);

    expect(screen.getByText("Sync Complete!")).toBeInTheDocument();
    expect(screen.queryByText("Sync Cancelled")).not.toBeInTheDocument();
  });

  // BACKLOG-2328 regression: a genuine error still shows the error screen.
  it("shows 'Sync Failed' when syncStatus is error", () => {
    mockContextValue = {
      ...mockSyncReturn,
      syncStatus: "error",
      error: "Backup failed: device locked",
    };

    render(<IPhoneSyncFlow />);

    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.queryByText("Sync Cancelled")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Complete!")).not.toBeInTheDocument();
  });
});
