/**
 * @jest-environment node
 *
 * BACKLOG-4066 C6 — `transactions:ensure-messages-coverage` is called only by Update
 * buttons (Texts-tab notice, export gate, create/edit prompt), so it passes the
 * click-only reason "update" — the one reason that may import NEWER texts. Reverting
 * it to "date-change" silently brings back the no-op click.
 *
 * Harness copied from auditRangeExtensionTrigger-2791.test.ts (mocked ipcMain + trigger).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

const mockGetTransactionDetails = jest.fn();
const mockUpdateTransaction = jest.fn();

jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: (...a: unknown[]) => mockGetTransactionDetails(...a),
    updateTransaction: (...a: unknown[]) => mockUpdateTransaction(...a),
  },
  getEarliestCommunicationDate: jest.fn(),
}));

jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn(),
    recordFailure: jest.fn(),
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// BACKLOG-3910 slice d: transactions:update reads the deal's lock first. No row
// (undefined) is an open deal, which is what this suite's deal is.
jest.mock("../../services/db/core/dbConnection", () => ({
  dbGet: jest.fn(() => undefined),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
  // BACKLOG-3339: the edit and its audit entry share one transaction.
  dbTransaction: <T,>(fn: () => T): T => fn(),
}));
jest.mock("../../services/emailSyncService", () => ({ __esModule: true, default: {} }));
// BACKLOG-3339: transactions:update writes through the synchronous call inside
// its audit transaction; routed to the same spy the suite already reads.
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { updateTransactionSync: (...a: unknown[]) => mockUpdateTransaction(...a) },
}));

jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
}));

jest.mock("../../services/messagesSyncTrigger", () => ({
  ensureTransactionMessagesSynced: jest.fn(),
  triggerMessagesSyncInBackground: jest.fn(),
}));

jest.mock("../../services/auditCoverageService", () => ({
  getAuditCoverage: jest.fn(),
  checkExportCompleteness: jest.fn(),
}));

jest.mock("../../services/reviewStateService", () => ({
  syncReviewQueueForTransaction: jest.fn(),
}));

import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";
import { ensureTransactionMessagesSynced } from "../../services/messagesSyncTrigger";

const USER = "00000000-0000-0000-0000-000000000000";
const ensureMock = ensureTransactionMessagesSynced as jest.Mock;

describe("BACKLOG-4066 — the Update IPC passes the click-only reason", () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    ensureMock.mockResolvedValue({
      ran: true,
      reason: "update",
      imported: 2,
      importRan: true,
      expansionRan: true,
      messagesFloorISO: "2026-01-01T00:00:00.000Z",
    });
    registerTransactionCrudHandlers(null);
  });

  it("C6: calls ensureTransactionMessagesSynced once with reason 'update' and the proposed start", async () => {
    const handler = handlers.get("transactions:ensure-messages-coverage");
    if (!handler) throw new Error("transactions:ensure-messages-coverage was never registered");

    const result = (await handler({} as unknown, USER, "2026-06-01T00:00:00.000Z")) as {
      success: boolean;
      importRan: boolean;
    };

    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][0]).toMatchObject({
      userId: USER,
      reason: "update",
      proposedStartISO: "2026-06-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    expect(result.importRan).toBe(true);
  });
});
