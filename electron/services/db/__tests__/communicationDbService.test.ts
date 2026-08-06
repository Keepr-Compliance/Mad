/**
 * @jest-environment node
 */

/**
 * Unit tests for Communication Database Service
 * Tests the text thread counting logic for transactions
 *
 * TASK-1404: Verify text thread count calculation is correct.
 * Based on Phase 1 investigation (TASK-1400), the counting logic is verified
 * to be correct. These tests document and verify the expected behavior.
 */


// Mock the dbConnection module
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
}));

// Import after mocking
import {
  countTextThreadsForTransaction,
  updateTransactionThreadCount,
  createCommunication,
  addIgnoredCommunication,
  confirmEmailLinksByEmailIds,
} from "../communicationDbService";

describe("communicationDbService", () => {
  const TEST_TRANSACTION_ID = "test-transaction-123";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("countTextThreadsForTransaction", () => {
    describe("basic counting", () => {
      it("should return 0 when no text messages are linked to the transaction", () => {
        mockDbAll.mockReturnValue([]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        expect(result).toBe(0);
        expect(mockDbAll).toHaveBeenCalledWith(
          expect.stringContaining("FROM communications c"),
          [TEST_TRANSACTION_ID]
        );
      });

      it("should return 1 when a single text thread is linked", () => {
        mockDbAll.mockReturnValue([
          { id: "msg-1", thread_id: "thread-abc", participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        expect(result).toBe(1);
      });

      it("should return correct count with multiple different threads", () => {
        mockDbAll.mockReturnValue([
          { id: "msg-1", thread_id: "thread-abc", participants: null },
          { id: "msg-2", thread_id: "thread-abc", participants: null },
          { id: "msg-3", thread_id: "thread-xyz", participants: null },
          { id: "msg-4", thread_id: "thread-xyz", participants: null },
          { id: "msg-5", thread_id: "thread-xyz", participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // 2 unique threads: thread-abc and thread-xyz
        expect(result).toBe(2);
      });

      it("should count unique threads, not total messages", () => {
        // 10 messages but only 3 unique threads
        mockDbAll.mockReturnValue([
          { id: "msg-1", thread_id: "thread-1", participants: null },
          { id: "msg-2", thread_id: "thread-1", participants: null },
          { id: "msg-3", thread_id: "thread-1", participants: null },
          { id: "msg-4", thread_id: "thread-2", participants: null },
          { id: "msg-5", thread_id: "thread-2", participants: null },
          { id: "msg-6", thread_id: "thread-2", participants: null },
          { id: "msg-7", thread_id: "thread-2", participants: null },
          { id: "msg-8", thread_id: "thread-3", participants: null },
          { id: "msg-9", thread_id: "thread-3", participants: null },
          { id: "msg-10", thread_id: "thread-3", participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Should count distinct threads, not messages
        expect(result).toBe(3);
      });
    });

    describe("NULL thread_id handling", () => {
      it("should treat each message with NULL thread_id as its own thread (fallback to message id)", () => {
        // When thread_id is NULL, each message becomes its own "thread"
        mockDbAll.mockReturnValue([
          { id: "msg-1", thread_id: null, participants: null },
          { id: "msg-2", thread_id: null, participants: null },
          { id: "msg-3", thread_id: null, participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Each message with NULL thread_id becomes its own thread: msg-msg-1, msg-msg-2, msg-msg-3
        expect(result).toBe(3);
      });

      it("should count NULL thread_id messages separately from regular threads", () => {
        mockDbAll.mockReturnValue([
          { id: "msg-1", thread_id: "thread-abc", participants: null },
          { id: "msg-2", thread_id: "thread-abc", participants: null },
          { id: "msg-3", thread_id: null, participants: null },
          { id: "msg-4", thread_id: null, participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // 1 real thread (thread-abc) + 2 "threads" from NULL messages
        expect(result).toBe(3);
      });
    });

    describe("participant-based grouping fallback", () => {
      it("should group messages by participants when thread_id is NULL", () => {
        // Messages with same participants but NULL thread_id should group together
        mockDbAll.mockReturnValue([
          {
            id: "msg-1",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["+15555550112"] }),
          },
          {
            id: "msg-2",
            thread_id: null,
            participants: JSON.stringify({ from: "+15555550112", to: ["me"] }),
          },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Both messages share the same participant set, should be 1 thread
        expect(result).toBe(1);
      });

      it("should separate messages with different participants when thread_id is NULL", () => {
        mockDbAll.mockReturnValue([
          {
            id: "msg-1",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["+15555550112"] }),
          },
          {
            id: "msg-2",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["+15555550121"] }),
          },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Different participants = different threads
        expect(result).toBe(2);
      });

      it("should normalize phone numbers for participant grouping", () => {
        // Phone numbers with different formats should normalize to same key
        mockDbAll.mockReturnValue([
          {
            id: "msg-1",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["+1 (555) 555-0112"] }),
          },
          {
            id: "msg-2",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["5555550112"] }),
          },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Both normalize to same phone number, should be 1 thread
        expect(result).toBe(1);
      });
    });

    describe("mixed scenarios", () => {
      it("should handle mix of thread_id, participants, and neither", () => {
        mockDbAll.mockReturnValue([
          // Messages in a real thread
          { id: "msg-1", thread_id: "thread-abc", participants: null },
          { id: "msg-2", thread_id: "thread-abc", participants: null },
          // Messages grouped by participants
          {
            id: "msg-3",
            thread_id: null,
            participants: JSON.stringify({ from: "me", to: ["+15555550112"] }),
          },
          {
            id: "msg-4",
            thread_id: null,
            participants: JSON.stringify({ from: "+15555550112", to: ["me"] }),
          },
          // Message with no thread_id or participants (becomes its own thread)
          { id: "msg-5", thread_id: null, participants: null },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // 1 (thread-abc) + 1 (participant group) + 1 (standalone) = 3 threads
        expect(result).toBe(3);
      });

      it("should prioritize thread_id over participant grouping", () => {
        // Even if participants differ, thread_id takes precedence
        mockDbAll.mockReturnValue([
          {
            id: "msg-1",
            thread_id: "same-thread",
            participants: JSON.stringify({ from: "me", to: ["+15555550112"] }),
          },
          {
            id: "msg-2",
            thread_id: "same-thread",
            participants: JSON.stringify({ from: "me", to: ["+15555550121"] }),
          },
        ]);

        const result = countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        // Same thread_id = 1 thread, regardless of participant difference
        expect(result).toBe(1);
      });
    });

    describe("SQL query verification", () => {
      it("should query communications joined with messages", () => {
        mockDbAll.mockReturnValue([]);

        countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify the query joins communications with messages
        expect(sqlCall).toContain("FROM communications c");
        expect(sqlCall).toContain("LEFT JOIN messages m");
        expect(sqlCall).toContain("WHERE c.transaction_id = ?");
      });

      it("should filter for text message channels", () => {
        mockDbAll.mockReturnValue([]);

        countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify text channel filtering
        expect(sqlCall).toContain("m.channel IN ('text', 'sms', 'imessage')");
      });

      it("should handle thread-based linking (c.thread_id IS NOT NULL)", () => {
        mockDbAll.mockReturnValue([]);

        countTextThreadsForTransaction(TEST_TRANSACTION_ID);

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify thread-based linking is handled
        expect(sqlCall).toContain("c.thread_id IS NOT NULL");
      });
    });
  });

  describe("updateTransactionThreadCount", () => {
    it("should count threads and update the transaction", () => {
      // Mock the count query
      mockDbAll.mockReturnValue([
        { id: "msg-1", thread_id: "thread-abc", participants: null },
        { id: "msg-2", thread_id: "thread-xyz", participants: null },
      ]);

      updateTransactionThreadCount(TEST_TRANSACTION_ID);

      // Verify the count was queried
      expect(mockDbAll).toHaveBeenCalledWith(
        expect.any(String),
        [TEST_TRANSACTION_ID]
      );

      // Verify the transaction was updated with the correct count
      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE transactions SET text_thread_count"),
        [2, TEST_TRANSACTION_ID]
      );
    });

    it("should set count to 0 when no threads are linked", () => {
      mockDbAll.mockReturnValue([]);

      updateTransactionThreadCount(TEST_TRANSACTION_ID);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE transactions SET text_thread_count"),
        [0, TEST_TRANSACTION_ID]
      );
    });

    it("should update with correct SQL syntax", () => {
      mockDbAll.mockReturnValue([]);

      updateTransactionThreadCount(TEST_TRANSACTION_ID);

      const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];

      expect(sql).toContain("UPDATE transactions");
      expect(sql).toContain("text_thread_count = ?");
      expect(sql).toContain("WHERE id = ?");
      expect(params[0]).toBe(0);
      expect(params[1]).toBe(TEST_TRANSACTION_ID);
    });
  });

  // BACKLOG-2319: match_reason persistence
  describe("match_reason persistence (BACKLOG-2319)", () => {
    it("createCommunication writes match_reason into the INSERT (column + param)", async () => {
      mockDbRun.mockReturnValue({ changes: 1 });

      await createCommunication({
        user_id: "u-1",
        transaction_id: "txn-1",
        email_id: "email-1",
        thread_id: "thread-1",
        link_source: "auto",
        link_confidence: 0.5,
        match_reason: "address_missing",
      } as Parameters<typeof createCommunication>[0]);

      const insert = mockDbRun.mock.calls.find(
        ([sql]) => typeof sql === "string" && (sql as string).includes("INSERT INTO communications")
      ) as [string, unknown[]];
      expect(insert).toBeDefined();
      expect(insert[0]).toContain("match_reason");
      // Param order: id, user_id, transaction_id, message_id, email_id, thread_id,
      //              link_source, link_confidence, match_reason, linked_at
      expect(insert[1][8]).toBe("address_missing");
    });

    it("createCommunication defaults match_reason to null when omitted", async () => {
      mockDbRun.mockReturnValue({ changes: 1 });

      await createCommunication({
        user_id: "u-1",
        transaction_id: "txn-1",
        email_id: "email-2",
        thread_id: "thread-2",
        link_source: "manual",
      } as Parameters<typeof createCommunication>[0]);

      const insert = mockDbRun.mock.calls.find(
        ([sql]) => typeof sql === "string" && (sql as string).includes("INSERT INTO communications")
      ) as [string, unknown[]];
      expect(insert[1][8]).toBeNull();
    });

    it("addIgnoredCommunication persists match_reason so it survives removal", async () => {
      mockDbRun.mockReturnValue({ changes: 1 });

      await addIgnoredCommunication({
        user_id: "u-1",
        transaction_id: "txn-1",
        email_id: "email-1",
        thread_id: "thread-1",
        reason: "Manually unlinked by user",
        match_reason: "user_confirmed",
      });

      const insert = mockDbRun.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" && (sql as string).includes("INSERT INTO ignored_communications")
      ) as [string, unknown[]];
      expect(insert).toBeDefined();
      expect(insert[0]).toContain("match_reason");
      // match_reason is the LAST param (after reason).
      expect(insert[1][insert[1].length - 1]).toBe("user_confirmed");
    });

    it("confirmEmailLinksByEmailIds updates only the given emails on the given transaction", () => {
      mockDbRun.mockReturnValue({ changes: 2 });

      const changed = confirmEmailLinksByEmailIds(["email-a", "email-b"], "txn-9");

      expect(changed).toBe(2);
      const [sql, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE communications");
      expect(sql).toContain("match_reason = 'user_confirmed'");
      expect(sql).toContain("transaction_id = ?");
      expect(sql).toContain("email_id IN (?, ?)");
      // transactionId first, then the email ids in order.
      expect(params).toEqual(["txn-9", "email-a", "email-b"]);
    });

    it("confirmEmailLinksByEmailIds is a no-op (0) for an empty id list — no SQL run", () => {
      const changed = confirmEmailLinksByEmailIds([], "txn-9");
      expect(changed).toBe(0);
      expect(mockDbRun).not.toHaveBeenCalled();
    });
  });
});
