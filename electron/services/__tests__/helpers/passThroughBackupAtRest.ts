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
  beginSync: async (udid: string) => ({ kind: "none" as const, udid }),
  finishSync: async () => undefined,
  buildParseCopy: async () => ({ copied: 0, missing: 0 }),
};
