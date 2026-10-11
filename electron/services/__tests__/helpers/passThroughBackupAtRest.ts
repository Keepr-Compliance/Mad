/**
 * BACKLOG-3816 S4-C: an at-rest layer that manages nothing, for orchestrator suites whose
 * subject is NOT the kept backup's encryption (disk guard, 3598 cleanup, prior-backup
 * state, ...). The real layer is exercised by atRest/__tests__/backupAtRest.test.ts and
 * deviceSyncOrchestrator.backupAtRest-3816.test.ts.
 *
 * Use from a jest.mock factory:
 *   jest.mock("../atRest/backupAtRest", () => ({
 *     ...jest.requireActual("../atRest/backupAtRest"),
 *     getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
 *   }));
 */
export const passThroughBackupAtRest = {
  busyReason: () => null,
  // `underLock` is the orchestrator's new-chain step, run under the per-phone lock.
  beginSync: async (udid: string, opts?: { underLock?: () => Promise<void> }) => {
    if (opts?.underLock) await opts.underLock();
    return { kind: "none" as const, udid };
  },
  finishSync: async () => undefined,
  releaseForQuit: () => undefined,
  buildParseCopy: async () => ({ copied: 0, missing: 0, unreadable: 0 }),
  on: () => undefined,
};
