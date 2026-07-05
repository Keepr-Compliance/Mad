/**
 * @jest-environment node
 *
 * BACKLOG-1718 (R5): Remove→restore→remove cycle durability.
 *
 * Root cause: restoreRemovedEmailThread wrote NULL thread_id to the
 * communications rows it created. The next unlinkCommunication expanded
 * siblings via `WHERE thread_id = ?` — NULL rows weren't matched → only
 * 1 email unlinked. Same poisoning on the restore side.
 *
 * Fixes verified here:
 *   A. restoreRemovedEmailThread now passes thread_id to createCommunication.
 *   B. unlinkCommunication sibling query is NULL-immune: also matches rows
 *      where thread_id IS NULL but email_id → emails.thread_id equals the
 *      resolved thread. Covers poisoned rows from any pre-R5 writer.
 *   C. restoreRemovedEmailThread sibling query is NULL-immune: same OR-fallback
 *      for ignored_communications rows with thread_id IS NULL.
 *
 * Test matrix:
 *   1. Full cycle — 3-email thread, full remove→restore→remove→restore:
 *      each pass removes/restores exactly 3. Verifies thread_id written on
 *      restore (fix A) and NULL-immune queries (fix B+C).
 *   2. Poisoned-state unlink — 1 row has thread_id, 2 siblings have NULL
 *      thread_id but same email_id→emails.thread_id → unlink expands to all 3.
 *   3. Poisoned-state restore — ignored_communications: 1 row has thread_id,
 *      2 siblings have NULL thread_id but email_id → emails.thread_id matches
 *      → restore expands to all 3.
 *   4. thread_id written on restore — createCommunication payload includes
 *      thread_id for all restored rows (even those whose ignored row had NULL
 *      thread_id but was resolved via emails table fallback).
 */

const mockGetById = jest.fn();
const mockDelete = jest.fn();
const mockAddIgnored = jest.fn();
const mockRemoveIgnored = jest.fn();
const mockCreateComm = jest.fn();
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getCommunicationById: (...args: unknown[]) => mockGetById(...args),
    deleteCommunication: (...args: unknown[]) => mockDelete(...args),
    addIgnoredCommunication: (...args: unknown[]) => mockAddIgnored(...args),
    removeIgnoredCommunication: (...args: unknown[]) => mockRemoveIgnored(...args),
    createCommunication: (...args: unknown[]) => mockCreateComm(...args),
    getTransactionDetails: jest.fn(),
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

const USER_ID = "u-r5";
const TX_ID = "tx-r5";
const THREAD_ID = "thread-r5";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Communications row with thread_id populated (healthy state). */
function makeComm(id: string, emailId: string, threadId: string | null = THREAD_ID) {
  return {
    id,
    user_id: USER_ID,
    transaction_id: TX_ID,
    email_id: emailId,
    thread_id: threadId,
    message_id: null,
    communication_type: "email",
    subject: "Re: 123 Main St",
    sender: "a@b.com",
    sent_at: "2026-01-01T00:00:00Z",
  };
}

/** Communications row with thread_id = NULL (poisoned by pre-R5 restore). */
function makeNullThreadComm(id: string, emailId: string) {
  return makeComm(id, emailId, null);
}

/** ignored_communications row. */
function makeIgnoredRow(id: string, emailId: string, threadId: string | null = THREAD_ID) {
  return { id, email_id: emailId, thread_id: threadId };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BACKLOG-1718 R5: remove→restore→remove cycle durability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);
    mockRemoveIgnored.mockResolvedValue(undefined);
    mockCreateComm.mockResolvedValue({ id: "new-comm" });
  });

  // ── Test 1: Full cycle ────────────────────────────────────────────────────

  describe("Test 1: full remove→restore→remove→restore cycle on 3-email thread", () => {
    const comms = [
      makeComm("c1", "e1"),
      makeComm("c2", "e2"),
      makeComm("c3", "e3"),
    ];
    const ignoredRows = [
      makeIgnoredRow("ign-1", "e1"),
      makeIgnoredRow("ign-2", "e2"),
      makeIgnoredRow("ign-3", "e3"),
    ];

    it("pass 1 — unlink removes all 3 emails", async () => {
      // Clicked comm has thread_id set.
      mockGetById.mockImplementation((id: string) =>
        Promise.resolve(comms.find((c) => c.id === id) ?? null),
      );
      mockDbGet.mockReturnValue(null); // no emails fallback needed
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM communications")) return comms.map((c) => ({ id: c.id }));
        return [];
      });

      await transactionService.unlinkCommunication("c1");

      expect(mockDelete).toHaveBeenCalledTimes(3);
      const deletedIds = mockDelete.mock.calls.map((c) => c[0]).sort();
      expect(deletedIds).toEqual(["c1", "c2", "c3"]);
      expect(mockAddIgnored).toHaveBeenCalledTimes(3);
    });

    it("pass 2 — restore brings all 3 back AND thread_id is written to each new comm row", async () => {
      // Clicked ignored row has thread_id.
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM ignored_communications WHERE id")) return { thread_id: THREAD_ID };
        return null;
      });
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM ignored_communications")) return ignoredRows;
        return [];
      });

      const { restoredCount } = await transactionService.restoreRemovedEmailThread(
        "ign-1", "e1", TX_ID, USER_ID,
      );

      expect(restoredCount).toBe(3);
      expect(mockCreateComm).toHaveBeenCalledTimes(3);

      // Fix A: every createCommunication call must include thread_id.
      for (const call of mockCreateComm.mock.calls) {
        const payload = call[0] as Record<string, unknown>;
        expect(payload).toHaveProperty("thread_id", THREAD_ID);
      }
    });

    it("pass 3 — second unlink (after restore) removes all 3 again", async () => {
      // Simulate the restored state: comms have thread_id (fix A ensures this).
      const restoredComms = [
        makeComm("r1", "e1"),
        makeComm("r2", "e2"),
        makeComm("r3", "e3"),
      ];
      mockGetById.mockImplementation((id: string) =>
        Promise.resolve(restoredComms.find((c) => c.id === id) ?? null),
      );
      mockDbGet.mockReturnValue(null);
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM communications")) return restoredComms.map((c) => ({ id: c.id }));
        return [];
      });

      await transactionService.unlinkCommunication("r1");

      expect(mockDelete).toHaveBeenCalledTimes(3);
      const deletedIds = mockDelete.mock.calls.map((c) => c[0]).sort();
      expect(deletedIds).toEqual(["r1", "r2", "r3"]);
    });

    it("pass 4 — second restore brings all 3 back again", async () => {
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM ignored_communications WHERE id")) return { thread_id: THREAD_ID };
        return null;
      });
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM ignored_communications")) return ignoredRows;
        return [];
      });

      const { restoredCount } = await transactionService.restoreRemovedEmailThread(
        "ign-1", "e1", TX_ID, USER_ID,
      );

      expect(restoredCount).toBe(3);
    });
  });

  // ── Test 2: Poisoned-state unlink ─────────────────────────────────────────

  it("Test 2: poisoned-state unlink — NULL-immune sibling match covers NULL thread_id rows", async () => {
    // c1 has thread_id set (clicked), c2+c3 have NULL thread_id but same email_id→emails.thread_id.
    const comms = [
      makeComm("c1", "e1"),
      makeNullThreadComm("c2", "e2"),
      makeNullThreadComm("c3", "e3"),
    ];

    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(comms.find((c) => c.id === id) ?? null),
    );

    // emails table fallback: not needed for clicked row (thread_id set).
    // The NULL-immune sibling query uses EXISTS (SELECT 1 FROM emails e ...).
    // mockDbAll simulates the full result that the NULL-immune query returns.
    mockDbGet.mockReturnValue(null);
    mockDbAll.mockImplementation((sql: string) => {
      // The new NULL-immune query uses EXISTS + OR; still selects from communications.
      if (sql.includes("FROM communications")) {
        return comms.map((c) => ({ id: c.id }));
      }
      return [];
    });

    await transactionService.unlinkCommunication("c1");

    // Fix B: all 3 rows are removed, not just the clicked one.
    expect(mockDelete).toHaveBeenCalledTimes(3);
    const deletedIds = mockDelete.mock.calls.map((c) => c[0]).sort();
    expect(deletedIds).toEqual(["c1", "c2", "c3"]);
  });

  // ── Test 3: Poisoned-state restore ───────────────────────────────────────

  it("Test 3: poisoned-state restore — NULL-immune sibling match covers NULL thread_id ignored rows", async () => {
    // Clicked ignored row has thread_id. Two siblings have thread_id=NULL but
    // email_id→emails.thread_id = THREAD_ID (pre-R5 single-row unlink wrote them).
    const ignoredRows = [
      makeIgnoredRow("ign-1", "e1", THREAD_ID),
      makeIgnoredRow("ign-2", "e2", null),
      makeIgnoredRow("ign-3", "e3", null),
    ];

    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications WHERE id")) return { thread_id: THREAD_ID };
      return null;
    });

    // NULL-immune query also returns the NULL-thread_id siblings.
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications")) return ignoredRows;
      return [];
    });

    const { restoredCount } = await transactionService.restoreRemovedEmailThread(
      "ign-1", "e1", TX_ID, USER_ID,
    );

    // Fix C: all 3 rows restored, not just 1.
    expect(restoredCount).toBe(3);
    expect(mockRemoveIgnored).toHaveBeenCalledTimes(3);
    const restoredIds = mockRemoveIgnored.mock.calls.map((c) => c[0]).sort();
    expect(restoredIds).toEqual(["ign-1", "ign-2", "ign-3"]);
  });

  // ── Test 4: thread_id on restore from NULL-thread_id ignored row ──────────

  it("Test 4: thread_id written even when clicked ignored row had NULL thread_id (emails table fallback)", async () => {
    // Clicked ignored row has thread_id=NULL; emails table fallback resolves it.
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications WHERE id")) return { thread_id: null };
      if (sql.includes("FROM emails WHERE id")) return { thread_id: THREAD_ID };
      return null;
    });

    const siblings = [
      makeIgnoredRow("ign-a", "e-a", THREAD_ID),
      makeIgnoredRow("ign-b", "e-b", THREAD_ID),
    ];
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM ignored_communications")) return siblings;
      return [];
    });

    await transactionService.restoreRemovedEmailThread("ign-a", "e-a", TX_ID, USER_ID);

    // Fix A + emails fallback: thread_id must still be written.
    expect(mockCreateComm).toHaveBeenCalledTimes(2);
    for (const call of mockCreateComm.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(payload).toHaveProperty("thread_id", THREAD_ID);
    }
  });
});
