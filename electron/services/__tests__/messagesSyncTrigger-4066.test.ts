/**
 * @jest-environment node
 *
 * BACKLOG-4066 — "Update Mac messages" (Texts-tab notice) and the export gate's
 * "Update now" must import NEWER texts when the Mac marker is stale.
 *
 * Mocked suite (no native driver), so it runs under plain `npx jest`. The real-driver
 * suite `messagesSyncTrigger.test.ts` carries the case whose marker row is written by
 * the real SOURCE_COVERAGE_UPSERT_SQL; it runs on CI.
 *
 * The threshold (COVERAGE_TOLERANCE_MS) and the notice's rule (sourceCoverageGaps) are
 * the REAL ones (requireActual), so C7 measures the trigger against the notice itself.
 */
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../macOSMessagesImportService", () => ({
  __esModule: true,
  default: { importMessages: jest.fn() },
}));
jest.mock("../messagesBackgroundImportSignal", () => ({
  emitBackgroundImportStarted: jest.fn(),
  emitBackgroundImportFinished: jest.fn(),
}));
jest.mock("../macImportMarker", () => ({
  recordMacImportRun: jest.fn(),
  readMacLastImportISO: jest.fn(),
}));
jest.mock("../autoLinkService", () => ({
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue({}),
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auditCoverageService", () => {
  const actual = jest.requireActual<typeof import("../auditCoverageService")>("../auditCoverageService");
  return {
    __esModule: true,
    ...actual,
    getMessagesFloorISO: jest.fn(),
    isMessagesImporterAvailable: jest.fn(),
  };
});
jest.mock("../db/messageImportStateService", () => ({
  recordImport: jest.fn(),
  recordExpansionRun: jest.fn(),
  getDeepestImportStart: jest.fn(),
}));
jest.mock("../importPlanInputs", () => ({
  resolveImportPlanForUser: jest.fn(),
  readNonRejectedTransactions: jest.fn(),
}));

import macOSMessagesImportService from "../macOSMessagesImportService";
import { readMacLastImportISO, recordMacImportRun } from "../macImportMarker";
import {
  COVERAGE_TOLERANCE_MS,
  getMessagesFloorISO,
  isMessagesImporterAvailable,
  sourceCoverageGaps,
} from "../auditCoverageService";
import { getDeepestImportStart, recordImport } from "../db/messageImportStateService";
import { readNonRejectedTransactions, resolveImportPlanForUser } from "../importPlanInputs";
import {
  ensureTransactionMessagesSynced,
  __resetMessagesSyncStateForTests,
  type MessagesSyncReason,
} from "../messagesSyncTrigger";
import type { SourceCoverage } from "../../types/auditCoverage";

const USER = "user-4066";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FLOOR = "2026-01-01T00:00:00.000Z";
/** The deal's audit start: AFTER the floor, so the start side is covered. */
const START = "2026-06-01T00:00:00.000Z";

const importMessages = macOSMessagesImportService.importMessages as jest.Mock;
const markerMock = readMacLastImportISO as jest.Mock;
const recordRunMock = recordMacImportRun as jest.Mock;
const importerMock = isMessagesImporterAvailable as jest.Mock;
const planMock = resolveImportPlanForUser as jest.Mock;
const recordImportMock = recordImport as jest.Mock;

const ago = (ms: number) => new Date(NOW - ms).toISOString();

function click(reason: MessagesSyncReason = "update", proposedStartISO: string | null = START) {
  return ensureTransactionMessagesSynced({ userId: USER, reason, proposedStartISO });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  __resetMessagesSyncStateForTests();
  importMessages.mockResolvedValue({ success: true, messagesImported: 2 });
  markerMock.mockReturnValue(ago(20 * DAY));
  importerMock.mockResolvedValue(true);
  planMock.mockResolvedValue({ mode: "delta" });
  (getMessagesFloorISO as jest.Mock).mockReturnValue(FLOOR);
  (getDeepestImportStart as jest.Mock).mockReturnValue(null);
  (readNonRejectedTransactions as jest.Mock).mockReturnValue([]);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("BACKLOG-4066 — an Update click fetches newer texts", () => {
  it("C1: 'update', start covered, Mac marker 20 days old -> ONE delta import, marker stamped, skipped undefined", async () => {
    const result = await click();

    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(planMock).toHaveBeenCalledWith({ userId: USER, mode: "delta", requestedStartISO: START });
    expect(importMessages.mock.calls[0][2]).toEqual({ mode: "delta" });
    expect(recordRunMock).toHaveBeenCalledTimes(1);
    expect(recordRunMock).toHaveBeenCalledWith(USER, NOW);
    expect(recordImportMock).toHaveBeenCalledWith(USER, START);
    expect(result.importRan).toBe(true);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBeUndefined();
  });

  it("C1b: 'update' with no required start (no deals) still imports newer texts; skipped undefined, recordImport(null)", async () => {
    const result = await click("update", null);

    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(planMock).toHaveBeenCalledWith({ userId: USER, mode: "delta", requestedStartISO: null });
    expect(recordImportMock).toHaveBeenCalledWith(USER, null);
    expect(result.skipped).toBeUndefined();
  });

  it.each<MessagesSyncReason>(["open", "export", "date-change", "create", "scan"])(
    "C2: automatic reason '%s', same stale marker -> NO import, skipped 'covered'",
    async (reason) => {
      const result = await click(reason);
      expect(importMessages).not.toHaveBeenCalled();
      expect(recordRunMock).not.toHaveBeenCalled();
      expect(result.skipped).toBe("covered");
    },
  );

  it("C3: 'update', marker 2 hours old -> NO import, skipped 'covered'", async () => {
    markerMock.mockReturnValue(ago(2 * 60 * 60 * 1000));
    const result = await click();
    expect(importMessages).not.toHaveBeenCalled();
    expect(result.skipped).toBe("covered");
  });

  it("C4: 'update', newer gap, import fails -> marker NOT stamped, skipped 'import_failed'", async () => {
    importMessages.mockResolvedValue({ success: false, messagesImported: 0, error: "already in progress" });
    const result = await click();
    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(recordRunMock).not.toHaveBeenCalled();
    expect(recordImportMock).not.toHaveBeenCalled();
    expect(result.importRan).toBe(false);
    expect(result.skipped).toBe("import_failed");
  });

  it("C5: 'update', marker never written (null) -> NO import", async () => {
    markerMock.mockReturnValue(null);
    const result = await click();
    expect(importMessages).not.toHaveBeenCalled();
    expect(result.skipped).toBe("covered");
  });

  it("no importer (no Full Disk Access / not macOS) -> NO import, skipped 'no_importer'", async () => {
    importerMock.mockResolvedValue(false);
    const result = await click();
    expect(importMessages).not.toHaveBeenCalled();
    expect(result.skipped).toBe("no_importer");
  });
});

describe("C7 — boundary sweep: the click imports exactly when the notice shows the newer line", () => {
  const offsets: Array<[string, number]> = [
    ["1 day + 1 hour", DAY + 60 * 60 * 1000],
    ["1 day + 1 minute", DAY + 60 * 1000],
    ["1 day + 1 ms", DAY + 1],
    ["exactly 1 day", DAY],
    ["1 day - 1 minute", DAY - 60 * 1000],
    ["1 day - 1 hour", DAY - 60 * 60 * 1000],
  ];

  it("uses the shared tolerance (1 day), not a local constant", () => {
    expect(COVERAGE_TOLERANCE_MS).toBe(DAY);
  });

  it.each(offsets)("marker %s old", async (_label, age) => {
    const lastSyncAt = ago(age);
    markerMock.mockReturnValue(lastSyncAt);
    const macRow: SourceCoverage = {
      source: "mac",
      coveredSince: FLOOR,
      lastSyncAt,
      approximate: false,
      hasRows: true,
    };
    const noticeShowsNewer = sourceCoverageGaps([macRow], START, "mac", null, NOW).some(
      (g) => g.kind === "newer",
    );

    await click();

    expect(importMessages.mock.calls.length > 0).toBe(noticeShowsNewer);
    // Both sides of the boundary are covered by this table — guard against a table
    // edit that leaves only one side.
    expect(noticeShowsNewer).toBe(age > DAY);
  });
});

describe("C8 — a click during an in-flight automatic run", () => {
  it("chains after a start-only 'date-change' run instead of joining it -> exactly ONE import", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const expand = jest.requireMock("../autoLinkService").expandAttachedThreadsForUser as jest.Mock;
    expand.mockImplementationOnce(() => gate.then(() => ({})));

    const first = click("date-change"); // start covered -> no import, held in expansion
    const second = click("update");

    expect(importMessages).not.toHaveBeenCalled();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.importRan).toBe(false);
    expect(b.importRan).toBe(true);
    expect(importMessages).toHaveBeenCalledTimes(1);
  });

  it("a click chained after a run that ALREADY refreshed the marker does not rescan -> ONE import", async () => {
    // The first run has a start gap (start before the floor), imports, and the
    // marker it writes is fresh by the time the chained click runs.
    importMessages.mockImplementation(async () => {
      markerMock.mockReturnValue(ago(60 * 1000));
      return { success: true, messagesImported: 1 };
    });
    // As the real recordImport does: the scan's reach becomes deepest_import_start.
    recordImportMock.mockImplementation((_u: string, iso: string | null) => {
      (getDeepestImportStart as jest.Mock).mockReturnValue(iso);
    });
    const first = click("date-change", "2025-06-01T00:00:00.000Z");
    const second = click("update", "2025-06-01T00:00:00.000Z");
    const [a, b] = await Promise.all([first, second]);

    expect(a.importRan).toBe(true);
    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(b.importRan).toBe(false);
    expect(b.skipped).toBe("covered");
  });

  it("a second click joins an in-flight click run -> ONE import, same result", async () => {
    const first = click("update");
    const second = click("update");
    const [a, b] = await Promise.all([first, second]);
    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });
});
