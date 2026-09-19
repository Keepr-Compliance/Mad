/**
 * BACKLOG-2755 — `transactions:bulk-update-status` accepts exactly the statuses
 * the database does.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT DRIVES THE HANDLER
 * ====================================================
 * Before this item, `transactions:bulk-update-status` carried its OWN literal
 * list of legal statuses, separate from the one in `validateTransactionData`
 * and separate again from the column's CHECK constraint. It had NO test at all:
 * the channel appeared exactly twice in the tree (the preload bridge and the
 * handler) and in no suite.
 *
 * Testing the exported `isTransactionStatus` guard directly would pin the
 * guard — which is not the thing that was unpinned. The handler's own gate is.
 * So this suite invokes the real registered IPC handler through the same
 * registry harness the other handler suites use, and asserts the ACCEPTED SET.
 *
 * Two assertions per direction, and they are not redundant:
 *   - against a HAND-WRITTEN literal: the tripwire. A change to the column's
 *     CHECK must consciously update that line.
 *   - against `TransactionStatusSchema.options`: fails if a hand-written list
 *     that DIFFERS from the schema is ever reintroduced in the handler.
 * Membership sampling would pass while a third value drifted, so neither
 * assertion samples.
 */
import { randomUUID } from "crypto";
import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";
import type { TransactionWithDetails } from "../services/transactionService/types";

const mockIpcHandle = jest.fn();

jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  BrowserWindow: jest.fn(),
}));

jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: jest.fn(),
    updateTransaction: jest.fn(),
  },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    databaseService: { updateTransaction: jest.fn() },
    isInitialized: jest.fn().mockReturnValue(true),
  },
}));

// Import after the mocks are in place.
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { TransactionStatusSchema } from "../schemas/transaction";
import transactionService from "../services/transactionService";

const mockTransactionService = transactionService as jest.Mocked<
  typeof transactionService
>;

describe("transactions:bulk-update-status — accepted status domain (BACKLOG-2755)", () => {
  let registeredHandlers: IpcHandlerRegistry;

  // Generated per run rather than written down: the handler validates the ID
  // shape before it looks at status, and a literal UUID in a public repo is
  // indistinguishable from a real record id (BACKLOG-2871).
  const TX_ID = randomUUID();
  const mockEvent = {} as IpcMainInvokeEvent;

  /** A value no CHECK list contains, so "the domain is closed" is measured. */
  const DOMAIN_SENTINEL = "zzz_not_a_real_domain_value";

  const CANDIDATES = [
    // the column's own CHECK list
    "pending",
    "active",
    "closed",
    "rejected",
    // the value the old hand-written lists accepted and the database rejects
    "cancelled",
    DOMAIN_SENTINEL,
  ];

  beforeAll(() => {
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation(
      (channel: string, handler: RegisteredIpcHandler) => {
        registeredHandlers.set(channel, handler);
      },
    );
    registerTransactionCrudHandlers({
      webContents: { send: jest.fn() },
      isDestroyed: () => false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Auto-detected, so the manual-transaction gate (TASK-984) does not fire
    // for `pending` / `rejected` and cannot be mistaken for a domain rejection.
    mockTransactionService.getTransactionDetails.mockResolvedValue({
      id: TX_ID,
      user_id: "user-1",
      detection_source: "auto",
    } as unknown as TransactionWithDetails);
    mockTransactionService.updateTransaction.mockResolvedValue(
      undefined as never,
    );
  });

  /**
   * Drive the REAL handler once per candidate and report which values it
   * accepted, judged by whether the update actually reached the service.
   */
  async function acceptedSet(): Promise<string[]> {
    const accepted: string[] = [];
    for (const status of CANDIDATES) {
      mockTransactionService.updateTransaction.mockClear();
      const handler = registeredHandlers.get("transactions:bulk-update-status");
      try {
        await handler(mockEvent, [TX_ID], status);
        if (
          mockTransactionService.updateTransaction.mock.calls.some(
            (call) => (call[1] as { status?: string })?.status === status,
          )
        ) {
          accepted.push(status);
        }
      } catch {
        // rejected — deliberately not accepted
      }
    }
    return accepted.sort();
  }

  it("registers the channel at all — the suite is vacuous otherwise", () => {
    expect(registeredHandlers.has("transactions:bulk-update-status")).toBe(true);
  });

  it("accepts exactly the CHECK's list — pinned by hand, so a domain change cannot ride in", async () => {
    await expect(acceptedSet()).resolves.toEqual([
      "active",
      "closed",
      "pending",
      "rejected",
    ]);
  });

  it("accepts exactly what the schema declares, so no hand-written list can return here", async () => {
    await expect(acceptedSet()).resolves.toEqual(
      [...TransactionStatusSchema.options].sort(),
    );
  });

  it("names the legal values in the error rather than restating them by hand", async () => {
    // `wrapHandler` converts the ValidationError into a failed response rather
    // than letting it reject, so the message is asserted where a caller would
    // actually read it.
    const handler = registeredHandlers.get("transactions:bulk-update-status");
    const result = await handler(mockEvent, [TX_ID], "cancelled");

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Status must be one of: pending, active, closed, rejected",
    );
  });
});
