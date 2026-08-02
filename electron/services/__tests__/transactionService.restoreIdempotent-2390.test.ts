/**
 * @jest-environment node
 *
 * BACKLOG-2390 (regression) — restoreRemovedEmailThread must be idempotent.
 *
 * Founder QA (rebuilt email-undo build): restoring an email from "Show removed"
 * threw
 *   UNIQUE constraint failed: communications.email_id, communications.transaction_id
 * transiently, then cleared. Root cause: restore re-links via a PLAIN
 * `INSERT INTO communications` (createCommunication) with no conflict handling.
 * restoreRemovedEmailThread is THREAD-AWARE — it restores the whole conversation
 * from one ignored row — so a thread with multiple ignored_communications rows
 * (or an overlapping Undo + manual restore) re-inserts a link that already
 * exists → the partial UNIQUE(email_id, transaction_id) index rejects it.
 *
 * This models the real DB: createCommunication THROWS a UNIQUE error when a link
 * for (email_id, transaction_id) already exists (exactly what a plain INSERT does
 * against idx_comm_email_txn). The test therefore FAILS on the pre-fix code
 * (the second re-insert throws) and passes once restore guards the re-insert.
 *
 * We assert restored-link IDENTITY (which email_ids are (re)created / skipped and
 * which ignored rows are cleared), not just counts.
 */

const mockGetById = jest.fn();
const mockDelete = jest.fn();
const mockAddIgnored = jest.fn();
const mockRemoveIgnored = jest.fn();
const mockCreateComm = jest.fn();
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockGetTxDetails = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getCommunicationById: (...args: unknown[]) => mockGetById(...args),
    deleteCommunication: (...args: unknown[]) => mockDelete(...args),
    addIgnoredCommunication: (...args: unknown[]) => mockAddIgnored(...args),
    removeIgnoredCommunication: (...args: unknown[]) => mockRemoveIgnored(...args),
    createCommunication: (...args: unknown[]) => mockCreateComm(...args),
    getTransactionDetails: (...args: unknown[]) => mockGetTxDetails(...args),
  },
}));

jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: jest.fn(),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
  logService: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import transactionService from "../transactionService";

const USER_ID = "u-2390";
const TX_ID = "tx-2390";
const THREAD_ID = "thread-2390";

interface IgnoredRow {
  id: string;
  email_id: string | null;
  thread_id: string | null;
  match_reason: string | null;
}

describe("restoreRemovedEmailThread — idempotent re-link (BACKLOG-2390)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does NOT throw a UNIQUE violation when a thread email is already linked", async () => {
    // Thread with two emails. e-1 is ALREADY linked (e.g. a prior Undo restored
    // the conversation); e-2 is not. Both still have suppression rows.
    const linked = new Set<string>([`e-1|${TX_ID}`]); // (email_id, transaction_id)
    const ignored = new Map<string, IgnoredRow>([
      ["ig-1", { id: "ig-1", email_id: "e-1", thread_id: THREAD_ID, match_reason: null }],
      ["ig-2", { id: "ig-2", email_id: "e-2", thread_id: THREAD_ID, match_reason: null }],
    ]);

    mockGetTxDetails.mockResolvedValue({ id: TX_ID, user_id: USER_ID });

    // Real-DB behavior: a plain re-INSERT of an existing (email_id, transaction_id)
    // link violates idx_comm_email_txn. Model exactly that.
    mockCreateComm.mockImplementation(async (data: { email_id: string; transaction_id: string }) => {
      const key = `${data.email_id}|${data.transaction_id}`;
      if (linked.has(key)) {
        throw new Error("UNIQUE constraint failed: communications.email_id, communications.transaction_id");
      }
      linked.add(key);
      return { id: `comm-${data.email_id}` };
    });
    mockRemoveIgnored.mockImplementation(async (id: string) => { ignored.delete(id); });

    mockDbGet.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("FROM ignored_communications WHERE id = ?")) {
        return ignored.get(params[0] as string); // clicked row (thread_id, match_reason)
      }
      if (sql.includes("FROM emails WHERE id = ?")) {
        return { thread_id: THREAD_ID }; // thread_id fallback
      }
      if (sql.includes("FROM communications WHERE email_id = ? AND transaction_id = ?")) {
        // The idempotency guard: report the existing link.
        return linked.has(`${params[0]}|${params[1]}`) ? { id: "existing" } : undefined;
      }
      return undefined;
    });

    // Sibling expansion returns every ignored row still in the thread.
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications ic")) {
        return [...ignored.values()]
          .filter((r) => r.thread_id === THREAD_ID && r.email_id)
          .map((r) => ({ id: r.id, email_id: r.email_id, match_reason: r.match_reason }));
      }
      return [];
    });

    // Restore the thread from ig-2. Sibling expansion pulls in ig-1 (e-1),
    // whose link already exists — the pre-fix plain INSERT throws here.
    const result = await transactionService.restoreRemovedEmailThread("ig-2", "e-2", TX_ID, USER_ID);

    // IDENTITY assertions -------------------------------------------------------
    // The already-linked email must NOT be re-inserted...
    const createdEmailIds = mockCreateComm.mock.calls.map((c) => (c[0] as { email_id: string }).email_id);
    expect(createdEmailIds).not.toContain("e-1");
    // ...but the not-yet-linked email IS linked.
    expect(createdEmailIds).toContain("e-2");
    expect(linked.has(`e-2|${TX_ID}`)).toBe(true);

    // Every suppression row for the thread is cleared — nothing can linger in
    // "Show removed" while it is linked.
    expect(mockRemoveIgnored).toHaveBeenCalledWith("ig-1");
    expect(mockRemoveIgnored).toHaveBeenCalledWith("ig-2");
    expect(ignored.size).toBe(0);

    // The whole thread counts as restored (2 emails now linked).
    expect(result.restoredCount).toBe(2);
  });

  it("still links a genuinely-removed email cleanly (normal single restore unaffected)", async () => {
    // No pre-existing link — the normal path must still create the row.
    const linked = new Set<string>();
    const ignored = new Map<string, IgnoredRow>([
      ["ig-solo", { id: "ig-solo", email_id: "e-solo", thread_id: null, match_reason: null }],
    ]);

    mockGetTxDetails.mockResolvedValue({ id: TX_ID, user_id: USER_ID });
    mockCreateComm.mockImplementation(async (data: { email_id: string; transaction_id: string }) => {
      const key = `${data.email_id}|${data.transaction_id}`;
      if (linked.has(key)) throw new Error("UNIQUE constraint failed: communications.email_id, communications.transaction_id");
      linked.add(key);
      return { id: `comm-${data.email_id}` };
    });
    mockRemoveIgnored.mockImplementation(async (id: string) => { ignored.delete(id); });
    mockDbGet.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("FROM ignored_communications WHERE id = ?")) return ignored.get(params[0] as string);
      if (sql.includes("FROM emails WHERE id = ?")) return { thread_id: null }; // no thread → single
      if (sql.includes("FROM communications WHERE email_id = ? AND transaction_id = ?")) {
        return linked.has(`${params[0]}|${params[1]}`) ? { id: "existing" } : undefined;
      }
      return undefined;
    });
    mockDbAll.mockReturnValue([]);

    const result = await transactionService.restoreRemovedEmailThread("ig-solo", "e-solo", TX_ID, USER_ID);

    const createdEmailIds = mockCreateComm.mock.calls.map((c) => (c[0] as { email_id: string }).email_id);
    expect(createdEmailIds).toEqual(["e-solo"]);
    expect(linked.has(`e-solo|${TX_ID}`)).toBe(true);
    expect(mockRemoveIgnored).toHaveBeenCalledWith("ig-solo");
    expect(result.restoredCount).toBe(1);
  });
});
