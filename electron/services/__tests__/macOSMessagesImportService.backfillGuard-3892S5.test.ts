/**
 * @jest-environment node
 *
 * BACKLOG-3892 S5 (SR S3): a texts force re-import refuses while the iPhone "Get older
 * texts" backfill runs — the same direction as the backfill, which refuses while a force
 * re-import runs. The refusal comes before the re-import cancels or clears anything, and
 * a plain (delta) import is not affected.
 */
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({ __esModule: true, default: { getRawDatabase: jest.fn() } }));
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })) },
}));
jest.mock("../supportAccess/trace", () => ({ __esModule: true, supportTrace: jest.fn() }));

import macOSMessagesImportService from "../macOSMessagesImportService/macOSMessagesImportService";
import { testImportPlan } from "./helpers/importPlanFixture";

const DONE = {
  success: true,
  messagesImported: 0,
  messagesSkipped: 0,
  attachmentsImported: 0,
  attachmentsUpdated: 0,
  attachmentsSkipped: 0,
  duration: 0,
};

describe("BACKLOG-3892 S5: force re-import vs a running iPhone backfill", () => {
  let doImport: jest.SpyInstance;
  let backfillRunning: string | null;

  beforeEach(() => {
    backfillRunning = null;
    macOSMessagesImportService.setReprocessBlocker(() => (backfillRunning ? "iphone-backfill" : null));
    doImport = jest
      .spyOn(macOSMessagesImportService as unknown as { doImport: (...a: unknown[]) => Promise<unknown> }, "doImport")
      .mockResolvedValue(DONE);
  });
  afterEach(() => {
    macOSMessagesImportService.setReprocessBlocker(() => null);
    jest.restoreAllMocks();
  });

  it("refuses a force re-import while a backfill runs; nothing is imported and no flag is left set", async () => {
    backfillRunning = "deal-1";
    const r = await macOSMessagesImportService.importMessages("user-1", undefined, testImportPlan({ mode: "reprocess" }));
    expect(r.success).toBe(false);
    expect(r.alreadyInProgress).toBeUndefined();
    expect(r.messagesImported).toBe(0);
    expect(doImport).not.toHaveBeenCalled();
    expect(macOSMessagesImportService.isForceReimportInProgress()).toBe(false);
  });

  it("runs the force re-import when no backfill runs (the pair: the refusal is the guard, not a broken import)", async () => {
    const r = await macOSMessagesImportService.importMessages("user-1", undefined, testImportPlan({ mode: "reprocess" }));
    expect(r).toEqual(DONE);
    expect(doImport).toHaveBeenCalledTimes(1);
  });

  it("a plain (delta) import is not refused by a running backfill", async () => {
    backfillRunning = "deal-1";
    const r = await macOSMessagesImportService.importMessages("user-1", undefined, testImportPlan({ mode: "delta" }));
    expect(r).toEqual(DONE);
    expect(doImport).toHaveBeenCalledTimes(1);
  });
});
