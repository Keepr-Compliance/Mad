/**
 * BACKLOG-2898 — the user-visible step is logged when it CHANGES, not per frame.
 *
 * Measured on the founder's real PC log (703,761 B / 4,023 lines / 21 min):
 * 2,824 records were `[IPhoneSyncFlow] Rendering: progress` and every one of
 * them was byte-identical apart from its timestamp — same `view`, same payload.
 * 80.7% of a support log carrying one fact.
 *
 * These controls pin the two independent properties:
 *   1. a repeated identical step logs ONCE at info;
 *   2. a genuine step change logs again;
 *   3. the per-frame notice never reaches the file transport (it is debug).
 */

import React from "react";
import { render } from "@testing-library/react";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn, BackupProgress } from "../../../types/iphone";
import logger from "../../../utils/logger";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const baseContext: UseIPhoneSyncReturn = {
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

let mockContextValue: UseIPhoneSyncReturn = { ...baseContext };

jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => mockContextValue,
}));

jest.mock("../ConnectionStatus", () => ({ ConnectionStatus: () => <div /> }));
jest.mock("../SyncProgress", () => ({ SyncProgress: () => <div /> }));
jest.mock("../BackupPasswordModal", () => ({ BackupPasswordModal: () => null }));
jest.mock("../../sync/SyncLockBanner", () => ({ SyncLockBanner: () => <div /> }));

/**
 * A `sync:progress` payload as the main process actually sends it — a NEW
 * object every event, which is why the render effect refires. Transcribed from
 * the message shapes emitted by electron/handlers/syncHandlers.ts:456-462 and
 * electron/services/deviceSyncOrchestrator.ts getBackupProgressMessage().
 */
function progressEvent(message: string, percent: number): BackupProgress {
  return { phase: "storing", percent, message } as BackupProgress;
}

/** Only the step lines — the per-frame notice is deliberately a separate line. */
function stepLines(): string[] {
  return (logger.info as jest.Mock).mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("[IPhoneSyncFlow]") && !m.includes("Mounted") && !m.includes("Unmounted"));
}

describe("BACKLOG-2898: IPhoneSyncFlow logs step changes, not frames", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextValue = {
      ...baseContext,
      syncStatus: "syncing",
      syncLocked: true,
      progress: progressEvent("Saving messages... 1 of 663,000", 0),
    };
  });

  it("logs ONE info line when the same step repeats across 500 progress events", () => {
    const { rerender } = render(<IPhoneSyncFlow />);

    // 500 events of the SAME user-visible step. The counter ticks; the step
    // the user is being shown does not change.
    for (let i = 2; i <= 500; i++) {
      mockContextValue = {
        ...mockContextValue,
        progress: progressEvent(`Saving messages... ${i.toLocaleString()} of 663,000`, i / 6630),
      };
      rerender(<IPhoneSyncFlow />);
    }

    expect(stepLines()).toHaveLength(1);
  });

  it("logs again when the step genuinely changes", () => {
    const { rerender } = render(<IPhoneSyncFlow />);
    const afterFirstStep = stepLines().length;

    mockContextValue = {
      ...mockContextValue,
      progress: progressEvent("Saving attachments... 1 of 64,000", 50),
    };
    rerender(<IPhoneSyncFlow />);

    expect(stepLines().length).toBe(afterFirstStep + 1);
    expect(stepLines()[stepLines().length - 1]).toContain("Saving attachments");
  });

  it("carries the phase and the message the user is being shown", () => {
    render(<IPhoneSyncFlow />);
    const line = stepLines()[0];
    expect(line).toContain("storing");
    expect(line).toContain("Saving messages");
  });

  it("does not send a per-frame render notice at info (file-transport level)", () => {
    const { rerender } = render(<IPhoneSyncFlow />);
    for (let i = 2; i <= 200; i++) {
      mockContextValue = {
        ...mockContextValue,
        progress: progressEvent(`Saving messages... ${i} of 663,000`, i / 6630),
      };
      rerender(<IPhoneSyncFlow />);
    }

    const renderNoticesAtInfo = (logger.info as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Rendering"));

    expect(renderNoticesAtInfo).toHaveLength(0);
  });
});
