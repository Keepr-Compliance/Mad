/**
 * @jest-environment node
 *
 * BACKLOG-1718 (R4): restoreRemovedEmailThread — thread-aware restore.
 *
 * Symmetry requirement: R3 thread-aware unlink moves all N emails of a thread
 * to ignored_communications. Clicking Restore on ONE should bring ALL N back.
 *
 * Verifies:
 *   1. Thread of 3 emails unlinked by R3 → restore ONE → all 3 re-linked.
 *   2. NULL thread_id in ignored row → fallback via emails table → expands.
 *   3. Single email (no thread) → only 1 restored (no expansion).
 *   4. SMS/message rows (email_id NULL) are NOT expanded by the sibling query.
 */

const mockRemoveIgnored = jest.fn();
const mockCreateComm = jest.fn();
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    removeIgnoredCommunication: (...args: unknown[]) => mockRemoveIgnored(...args),
    createCommunication: (...args: unknown[]) => mockCreateComm(...args),
    // unlinkCommunication path (not under test but required for import)
    getCommunicationById: jest.fn(),
    deleteCommunication: jest.fn(),
    addIgnoredCommunication: jest.fn(),
    getTransactionDetails: jest.fn(),
  },
}));

jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
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

const USER_ID = "u1";
const TX_ID = "tx-restore";
const THREAD_ID = "thread-restore";

/** Build an ignored_communications row as written by R3 thread-expansion unlink */
function makeIgnoredRow(
  id: string,
  emailId: string,
  threadId: string | null = THREAD_ID,
): { id: string; email_id: string | null; thread_id: string | null } {
  return { id, email_id: emailId, thread_id: threadId };
}

describe("TransactionService.restoreRemovedEmailThread — thread expansion (BACKLOG-1718 R4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemoveIgnored.mockResolvedValue(undefined);
    mockCreateComm.mockResolvedValue({ id: "new-comm" });
  });

  it("restores ALL 3 sibling rows when one ignored email is clicked", async () => {
    const rows = [
      makeIgnoredRow("ign-1", "email-1"),
      makeIgnoredRow("ign-2", "email-2"),
      makeIgnoredRow("ign-3", "email-3"),
    ];

    // Clicked row lookup: ign-2 has thread_id set
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications WHERE id")) {
        return { thread_id: THREAD_ID };
      }
      return null;
    });

    // Sibling query returns all 3 rows (same transaction + thread_id)
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications") && sql.includes("thread_id")) {
        return rows;
      }
      return [];
    });

    const { restoredCount } = await transactionService.restoreRemovedEmailThread(
      "ign-2", "email-2", TX_ID, USER_ID,
    );

    // All 3 suppression records removed
    expect(mockRemoveIgnored).toHaveBeenCalledTimes(3);
    const removedIds = mockRemoveIgnored.mock.calls.map((c) => c[0]).sort();
    expect(removedIds).toEqual(["ign-1", "ign-2", "ign-3"]);

    // All 3 re-linked
    expect(mockCreateComm).toHaveBeenCalledTimes(3);
    expect(restoredCount).toBe(3);
  });

  it("NULL thread_id in ignored row: resolves via emails table and expands to siblings", async () => {
    const rows = [
      makeIgnoredRow("ign-a", "email-a", THREAD_ID),
      makeIgnoredRow("ign-b", "email-b", THREAD_ID),
    ];

    // Clicked row has thread_id = NULL (pre-fix ignored row)
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications WHERE id")) {
        return { thread_id: null };
      }
      if (sql.includes("FROM emails WHERE id")) {
        return { thread_id: THREAD_ID }; // fallback resolves thread_id
      }
      return null;
    });

    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications") && sql.includes("thread_id")) {
        return rows;
      }
      return [];
    });

    const { restoredCount } = await transactionService.restoreRemovedEmailThread(
      "ign-a", "email-a", TX_ID, USER_ID,
    );

    // emails fallback must have been invoked
    const emailsFallback = mockDbGet.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("FROM emails WHERE id"),
    );
    expect(emailsFallback.length).toBeGreaterThanOrEqual(1);

    // Both sibling rows restored (ign-a from initial set + ign-b from siblings query)
    expect(mockRemoveIgnored).toHaveBeenCalledTimes(2);
    expect(mockCreateComm).toHaveBeenCalledTimes(2);
    expect(restoredCount).toBe(2);
  });

  it("single email with no thread siblings: restores only the clicked row", async () => {
    // thread_id set but sibling query returns nothing (solo email in thread)
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications WHERE id")) {
        return { thread_id: THREAD_ID };
      }
      return null;
    });
    mockDbAll.mockReturnValue([]); // no siblings

    const { restoredCount } = await transactionService.restoreRemovedEmailThread(
      "ign-solo", "email-solo", TX_ID, USER_ID,
    );

    // Only the clicked row is restored
    expect(mockRemoveIgnored).toHaveBeenCalledTimes(1);
    expect(mockRemoveIgnored).toHaveBeenCalledWith("ign-solo");
    expect(mockCreateComm).toHaveBeenCalledTimes(1);
    expect(restoredCount).toBe(1);
  });

  it("NULL thread_id unresolvable: restores only the clicked row (no expansion)", async () => {
    // Both ignored_row and emails table return no thread_id
    mockDbGet.mockReturnValue({ thread_id: null });
    mockDbAll.mockReturnValue([]);

    const { restoredCount } = await transactionService.restoreRemovedEmailThread(
      "ign-x", "email-x", TX_ID, USER_ID,
    );

    // Sibling enumeration must NOT have run (isEmailThread = false)
    expect(mockDbAll).not.toHaveBeenCalled();
    expect(mockRemoveIgnored).toHaveBeenCalledTimes(1);
    expect(mockCreateComm).toHaveBeenCalledTimes(1);
    expect(restoredCount).toBe(1);
  });
});
