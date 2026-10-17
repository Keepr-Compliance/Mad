/**
 * BACKLOG-3910d (founder 2026-10-12): one narrow allowance on a locked deal.
 * An APPROVED deal can be set to closed, through transactions:update (status
 * only) and transactions:bulk-update-status. Submitted, under review and
 * resubmitted deals refuse everything, close included. The bulk status change
 * and the address-filter setting are guarded like any other deal edit.
 *
 * The harness is the one in dealLockHandlers-3910.test.ts.
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
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../services/db/core/dbConnection", () => ({
  dbGet: jest.fn(),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
  // BACKLOG-3339: a deal edit and its audit entry share one transaction.
  dbTransaction: <T,>(fn: () => T): T => fn(),
}));
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    assignContactToTransaction: jest.fn(() => Promise.resolve({})),
    batchUpdateContactAssignments: jest.fn(() => Promise.resolve()),
    removeContactFromTransaction: jest.fn(() => Promise.resolve()),
    unlinkCommunication: jest.fn(() => Promise.resolve({ unlinkedIds: [] })),
    unlinkMessages: jest.fn(() => Promise.resolve()),
    linkMessages: jest.fn(() => Promise.resolve()),
    // BACKLOG-3339: the deal must exist (its owner is the audit entry's user).
    getTransactionDetails: jest.fn((id: string) => Promise.resolve({ id, user_id: "user-3910d" })),
    updateTransaction: jest.fn(() => Promise.resolve()),
    getTransactionWithContacts: jest.fn(() => Promise.resolve(null)),
  },
  getEarliestCommunicationDate: jest.fn(),
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    restoreContactToTransaction: jest.fn(() => Promise.resolve(false)),
    getTransactionById: jest.fn(() => Promise.resolve(null)),
    // BACKLOG-3339: the write transactions:update / bulk-update-status make.
    updateTransactionSync: jest.fn(),
  },
}));
jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), recordInTransaction: jest.fn(), recordFailure: jest.fn() },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: { fetchAndAutoLinkForContact: jest.fn() },
}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkCommunicationsForContact: jest.fn(() =>
    Promise.resolve({ emailsLinked: 0, messagesLinked: 0, queuedForReview: 0 }),
  ),
}));
jest.mock("../../services/transactionTextThreadsService", () => ({
  unlinkTextThreads: jest.fn(() => Promise.resolve({ removed: 0, messageIds: [] })),
}));
jest.mock("../../services/reviewStateService", () => ({
  approveReviewItems: jest.fn(() => Promise.resolve({ approved: 1 })),
  rejectReviewItems: jest.fn(() => Promise.resolve({ rejected: 1 })),
  getReviewItemTransactionIds: jest.fn(() => ["3910b000-0000-4000-8000-000000000001"]), // pii-allow-uuid: invented test id
  getReviewState: jest.fn(),
  syncReviewQueueForTransaction: jest.fn(),
  countReviewItems: jest.fn(() => 0),
  restoreRejectedToQueue: jest.fn(() => Promise.resolve(0)),
  notifyReviewStateChanged: jest.fn(),
}));
jest.mock("../../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/emailDbService", () => ({
  createEmail: jest.fn(), getEmailById: jest.fn(),
  getEmailByExternalId: jest.fn(), getCachedEmails: jest.fn(),
}));
jest.mock("../../services/db/communicationDbService", () => ({
  createCommunication: jest.fn(), removeIgnoredCommunication: jest.fn(),
  confirmEmailLinksByEmailIds: jest.fn(),
}));
jest.mock("./../featureGateHandlers", () => ({ isHideFromExportAllowed: jest.fn(() => Promise.resolve(true)) }));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));

import { dbGet } from "../../services/db/core/dbConnection";
import transactionService from "../../services/transactionService";
import databaseService from "../../services/databaseService";
import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";


import { registerEmailAutoLinkHandlers } from "../emailAutoLinkHandlers";

const A = "3910d000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented test id
const B = "3910d000-0000-4000-8000-000000000002"; // pii-allow-uuid: invented test id
const C = "3910d000-0000-4000-8000-000000000003"; // pii-allow-uuid: invented test id

type Res = {
  success: boolean;
  error?: string;
  dealLocked?: string;
  refusedEdit?: string;
  updatedCount?: number;
  refusedIds?: string[];
};

const update = () => jest.mocked(transactionService.updateTransaction) as unknown as jest.Mock;
// BACKLOG-3339: transactions:update and bulk-update-status write through the
// synchronous call inside their audit transaction.
const writeSync = () => jest.mocked(databaseService.updateTransactionSync) as unknown as jest.Mock;

beforeAll(() => {
  registerTransactionCrudHandlers(null);
  registerEmailAutoLinkHandlers();
});
beforeEach(() => jest.clearAllMocks());

function statuses(byDeal: Record<string, string>): void {
  jest.mocked(dbGet).mockImplementation(((_q: string, params?: unknown[]) => {
    const id = String((params ?? [])[0]);
    return id in byDeal ? { submission_status: byDeal[id] } : undefined;
  }) as never);
}
const call = async (channel: string, ...args: unknown[]): Promise<Res> =>
  (await handlers.get(channel)!({} as unknown, ...args)) as Res;

describe("transactions:update on a locked deal", () => {
  it("approved + status closed only: goes through", async () => {
    statuses({ [A]: "approved" });
    const res = await call("transactions:update", A, { status: "closed" });
    expect(res.dealLocked).toBeUndefined();
    expect(writeSync()).toHaveBeenCalledTimes(1);
  });

  it.each(["submitted", "under_review", "resubmitted"])("%s + status closed: refused", async (s) => {
    statuses({ [A]: s });
    const res = await call("transactions:update", A, { status: "closed" });
    expect(res).toMatchObject({ success: false, dealLocked: "submitted", refusedEdit: "edit-deal-details" });
    expect(writeSync()).not.toHaveBeenCalled();
  });

  it("approved + any other field, or status plus another field: refused", async () => {
    statuses({ [A]: "approved" });
    for (const u of [{ started_at: "2026-01-15" }, { status: "closed", started_at: "2026-01-15" }, { status: "active" }]) {
      const res = await call("transactions:update", A, u);
      expect(res).toMatchObject({ success: false, dealLocked: "sealed" });
    }
    expect(writeSync()).not.toHaveBeenCalled();
  });
});

describe("transactions:bulk-update-status", () => {
  it("closes an approved deal and an open deal; refuses the rest, per deal, and reports which", async () => {
    statuses({ [A]: "approved", [B]: "not_submitted", [C]: "under_review" });
    const res = await call("transactions:bulk-update-status", [A, B, C], "closed");
    expect(res.updatedCount).toBe(2);
    expect(res.refusedIds).toEqual([C]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/1 locked deal was not changed/);
    expect(writeSync().mock.calls.map((c) => c[0]).sort()).toEqual([A, B].sort());
  });

  it("approved deal to a status other than closed: refused", async () => {
    statuses({ [A]: "approved" });
    const res = await call("transactions:bulk-update-status", [A], "active");
    expect(res.refusedIds).toEqual([A]);
    expect(writeSync()).not.toHaveBeenCalled();
  });

  it("submitted deal to closed: refused", async () => {
    statuses({ [A]: "submitted" });
    const res = await call("transactions:bulk-update-status", [A], "closed");
    expect(res.refusedIds).toEqual([A]);
    expect(writeSync()).not.toHaveBeenCalled();
  });

  it("only open deals: all change, success", async () => {
    statuses({ [A]: "not_submitted", [B]: "needs_changes" });
    const res = await call("transactions:bulk-update-status", [A, B], "active");
    expect(res).toMatchObject({ success: true, updatedCount: 2 });
    expect(res.refusedIds).toBeUndefined();
  });
});

describe("transactions:update-address-filter", () => {
  it.each(["submitted", "under_review", "resubmitted", "approved"])("%s: refused, nothing written", async (s) => {
    statuses({ [A]: s });
    const res = await call("transactions:update-address-filter", A, true);
    expect(res).toMatchObject({ success: false, refusedEdit: "edit-deal-details" });
    expect(update()).not.toHaveBeenCalled();
  });

  it("open deal: written", async () => {
    statuses({ [A]: "not_submitted" });
    await call("transactions:update-address-filter", A, true);
    expect(update()).toHaveBeenCalledTimes(1);
  });
});
