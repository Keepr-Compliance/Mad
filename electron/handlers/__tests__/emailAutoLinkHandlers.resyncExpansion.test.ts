/**
 * BACKLOG-2293: the in-transaction "re-sync" affordance
 * (transactions:resync-auto-link) must run attached-thread expansion AFTER the
 * per-contact auto-link loop, so backfilled/older messages already sharing an
 * attached thread are picked up. Founder QA found this call site ran only
 * autoLinkCommunicationsForContact and never expandAttachedThreadsForUser
 * (log signature "[Transactions] Re-syncing auto-link for transaction" …
 * "[Transactions] Re-sync auto-link complete").
 *
 * We capture the handler registered via ipcMain.handle and invoke it directly
 * with the service layer mocked.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
}));

// wrapHandler: pass-through (behavior under test is the inner fn).
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: IpcHandler) => fn,
}));

const mockAutoLinkForContact = jest.fn();
const mockExpandAttachedThreads = jest.fn();
jest.mock("../../services/autoLinkService", () => ({
  autoLinkCommunicationsForContact: (...a: unknown[]) => mockAutoLinkForContact(...a),
  expandAttachedThreadsForUser: (...a: unknown[]) => mockExpandAttachedThreads(...a),
}));

const mockGetTransactionWithContacts = jest.fn();
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionWithContacts: (...a: unknown[]) => mockGetTransactionWithContacts(...a),
  },
}));

jest.mock("../../services/messageMatchingService", () => ({
  autoLinkAllToTransaction: jest.fn(),
}));

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: (...a: unknown[]) => mockLogInfo(...a),
    warn: (...a: unknown[]) => mockLogWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {},
  validateTransactionId: (id: string) => id,
}));

import { registerEmailAutoLinkHandlers } from "../emailAutoLinkHandlers";

const USER_ID = "user-99";
const TX_ID = "tx-1";

describe("transactions:resync-auto-link runs attached-thread expansion (BACKLOG-2293)", () => {
  let resync: IpcHandler;

  beforeAll(() => {
    registerEmailAutoLinkHandlers();
    resync = handlers.get("transactions:resync-auto-link")!;
    expect(resync).toBeDefined();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTransactionWithContacts.mockResolvedValue({
      id: TX_ID,
      user_id: USER_ID,
      contact_assignments: [{ contact_id: "c-1" }, { contact_id: "c-2" }],
    });
    mockAutoLinkForContact.mockResolvedValue({
      emailsLinked: 0,
      messagesLinked: 0,
      alreadyLinked: 0,
      errors: 0,
    });
    mockExpandAttachedThreads.mockResolvedValue({
      pairsExamined: 2,
      messagesLinked: 3,
      skippedSuppressed: 0,
      skippedAlreadyLinked: 0,
      errors: 0,
      durationMs: 1,
    });
  });

  it("invokes expandAttachedThreadsForUser with the transaction's user_id, after the per-contact loop", async () => {
    const result = (await resync({}, TX_ID)) as {
      success: boolean;
      attachedExpansionLinked?: number;
    };

    expect(result.success).toBe(true);
    // BACKLOG-2293: the expansion count is on the RETURN value (not just logged)
    // so the renderer can refresh + toast even when auto-link linked 0.
    expect(result.attachedExpansionLinked).toBe(3);
    // Expansion ran exactly once, for this user.
    expect(mockExpandAttachedThreads).toHaveBeenCalledTimes(1);
    expect(mockExpandAttachedThreads).toHaveBeenCalledWith(USER_ID);
    // Ordering: per-contact auto-link runs BEFORE expansion.
    expect(mockAutoLinkForContact).toHaveBeenCalledTimes(2);
    const lastAutoLinkOrder = Math.max(
      ...mockAutoLinkForContact.mock.invocationCallOrder,
    );
    const expandOrder = mockExpandAttachedThreads.mock.invocationCallOrder[0];
    expect(expandOrder).toBeGreaterThan(lastAutoLinkOrder);
  });

  it("logs the expansion count in the Re-sync auto-link complete summary", async () => {
    await resync({}, TX_ID);

    const completeLog = mockLogInfo.mock.calls.find(
      (c) => c[0] === "Re-sync auto-link complete",
    );
    expect(completeLog).toBeDefined();
    expect(completeLog![2]).toEqual(
      expect.objectContaining({ attachedExpansionLinked: 3 }),
    );
  });

  it("does not fail the re-sync if expansion throws (graceful degrade)", async () => {
    mockExpandAttachedThreads.mockRejectedValueOnce(new Error("boom"));

    const result = (await resync({}, TX_ID)) as { success: boolean };

    expect(result.success).toBe(true);
    // Failure is logged, and the summary still reports 0 expanded.
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Re-sync attached-thread expansion failed",
      "Transactions",
      expect.objectContaining({ error: "boom" }),
    );
    const completeLog = mockLogInfo.mock.calls.find(
      (c) => c[0] === "Re-sync auto-link complete",
    );
    expect(completeLog![2]).toEqual(
      expect.objectContaining({ attachedExpansionLinked: 0 }),
    );
  });
});
