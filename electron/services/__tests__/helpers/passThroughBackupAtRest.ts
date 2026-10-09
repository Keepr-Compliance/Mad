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
  buildParseCopy: async () => ({ copied: 0, missing: 0 }),
  on: () => undefined,
};

/**
 * B1: a saved-backup-password store with nothing in it and no file I/O. The real store
 * writes `<userData>/backup-password-store.json`; suites whose subject is not the
 * password must not touch it. Use from a jest.mock factory:
 *   jest.mock("../atRest/backupPassword", () => ({
 *     ...jest.requireActual("../atRest/backupPassword"),
 *     getBackupPasswordStore: () =>
 *       require("./helpers/passThroughBackupAtRest").passThroughBackupPasswordStore,
 *   }));
 */
export const passThroughBackupPasswordStore = {
  get: async () => ({ kind: "absent" as const }),
  put: async () => undefined,
  replaceVerified: async () => undefined,
  replaceUnreadable: async () => undefined,
  storePath: () => "",
};
