/**
 * @jest-environment node
 */

/**
 * Unit tests for Transaction Database Service
 * Tests the validateTransactionStatus function for proper validation behavior
 * TASK-1403: Added tests for email count calculation
 */

import { DatabaseError } from "../../../types";

// Mock the dbConnection module for email count tests
const mockDbGet = jest.fn();
const mockDbAll = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: jest.fn(),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
}));

// Import after mocking
import {
  validateTransactionStatus,
  VALID_TRANSACTION_STATUSES,
  getTransactions,
  getTransactionById,
} from "../transactionDbService";

describe("transactionDbService", () => {
  describe("VALID_TRANSACTION_STATUSES", () => {
    it("should contain exactly the four canonical status values", () => {
      expect(VALID_TRANSACTION_STATUSES).toEqual(["pending", "active", "closed", "rejected"]);
    });

    it("should be readonly", () => {
      // TypeScript enforces this at compile time, but we can verify the array exists
      expect(Array.isArray(VALID_TRANSACTION_STATUSES)).toBe(true);
      expect(VALID_TRANSACTION_STATUSES.length).toBe(4);
    });
  });

  describe("validateTransactionStatus", () => {
    describe("valid status values", () => {
      it("should return 'pending' when given 'pending'", () => {
        expect(validateTransactionStatus("pending")).toBe("pending");
      });

      it("should return 'active' when given 'active'", () => {
        expect(validateTransactionStatus("active")).toBe("active");
      });

      it("should return 'closed' when given 'closed'", () => {
        expect(validateTransactionStatus("closed")).toBe("closed");
      });

      it("should return 'rejected' when given 'rejected'", () => {
        expect(validateTransactionStatus("rejected")).toBe("rejected");
      });
    });

    describe("default behavior for null/undefined/empty", () => {
      it("should return 'active' when given null", () => {
        expect(validateTransactionStatus(null)).toBe("active");
      });

      it("should return 'active' when given undefined", () => {
        expect(validateTransactionStatus(undefined)).toBe("active");
      });

      it("should return 'active' when given empty string", () => {
        expect(validateTransactionStatus("")).toBe("active");
      });
    });

    describe("invalid status values - should throw", () => {
      it("should throw DatabaseError for legacy 'completed' status", () => {
        expect(() => validateTransactionStatus("completed")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("completed")).toThrow(
          'Invalid transaction status: "completed". Valid values are: pending, active, closed, rejected'
        );
      });

      it("should throw DatabaseError for legacy 'open' status", () => {
        expect(() => validateTransactionStatus("open")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("open")).toThrow(
          'Invalid transaction status: "open". Valid values are: pending, active, closed, rejected'
        );
      });

      it("should throw DatabaseError for legacy 'cancelled' status", () => {
        expect(() => validateTransactionStatus("cancelled")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("cancelled")).toThrow(
          'Invalid transaction status: "cancelled". Valid values are: pending, active, closed, rejected'
        );
      });

      it("should throw DatabaseError for legacy 'archived' status", () => {
        expect(() => validateTransactionStatus("archived")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("archived")).toThrow(
          'Invalid transaction status: "archived". Valid values are: pending, active, closed, rejected'
        );
      });

      it("should throw DatabaseError for unknown status values", () => {
        expect(() => validateTransactionStatus("unknown")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("invalid")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("foo")).toThrow(DatabaseError);
      });

      it("should throw DatabaseError for non-string values", () => {
        expect(() => validateTransactionStatus(123)).toThrow(DatabaseError);
        expect(() => validateTransactionStatus(true)).toThrow(DatabaseError);
        expect(() => validateTransactionStatus({})).toThrow(DatabaseError);
        expect(() => validateTransactionStatus([])).toThrow(DatabaseError);
      });

      it("should include the invalid value in the error message", () => {
        expect(() => validateTransactionStatus("badvalue")).toThrow(
          'Invalid transaction status: "badvalue"'
        );
      });

      it("should include valid values in the error message", () => {
        expect(() => validateTransactionStatus("bad")).toThrow(
          "Valid values are: pending, active, closed, rejected"
        );
      });
    });

    describe("case sensitivity", () => {
      it("should be case sensitive - reject uppercase valid values", () => {
        expect(() => validateTransactionStatus("Active")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("ACTIVE")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("Closed")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("PENDING")).toThrow(DatabaseError);
      });
    });

    describe("whitespace handling", () => {
      it("should reject values with leading/trailing whitespace", () => {
        expect(() => validateTransactionStatus(" active")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus("active ")).toThrow(DatabaseError);
        expect(() => validateTransactionStatus(" active ")).toThrow(DatabaseError);
      });
    });
  });

  /**
   * TASK-1403 / BACKLOG-2865: how `email_count` is produced.
   *
   * BACKLOG-2865 MOVED THIS NUMBER OUT OF SQL. It used to be a
   * `COUNT(DISTINCT c.email_id)` subquery over every attached email; once
   * BACKLOG-2861 scoped the Emails tab to its linked conversations, that count
   * described a different set from the tab and the founder saw 9 on the card
   * over "0 conversations (0 emails)" in the deal. It is now derived from the
   * scoped rows by `countLinkedEmailsByTransaction`.
   *
   * These are MOCK tests: they pin the SHAPE of the queries and the wiring. What
   * the number actually comes to, against real rows and the real Emails-tab
   * classification, is `transactionDbService.cardScope-2865.test.ts` — a mocked
   * driver cannot tell a correct count from a plausible one.
   */
  describe("email count calculation", () => {
    const TEST_USER_ID = "test-user-123";
    const TEST_TRANSACTION_ID = "test-transaction-456";

    beforeEach(() => {
      jest.clearAllMocks();
    });

    /** dbAll is called twice: the transaction rows, then their attached emails. */
    function mockListWith(scopedRows: unknown[]): void {
      mockDbAll
        .mockReturnValueOnce([
          {
            id: TEST_TRANSACTION_ID,
            user_id: TEST_USER_ID,
            total_communications_count: scopedRows.length,
          },
        ])
        .mockReturnValueOnce(scopedRows);
    }

    const emailRow = (
      email_id: string,
      thread_id: string | null,
      match_reason: string | null,
    ) => ({
      transaction_id: TEST_TRANSACTION_ID,
      email_id,
      thread_id,
      subject: "Closing docs",
      match_reason,
    });

    describe("getTransactions - email_count", () => {
      it("should return email_count of 0 when no emails are linked", async () => {
        mockListWith([]);

        const result = await getTransactions({ user_id: TEST_USER_ID });

        expect(result[0].email_count).toBe(0);
      });

      it("counts the emails of linked conversations", async () => {
        mockListWith([
          emailRow("e-1", "th-1", "address_found"),
          emailRow("e-2", "th-1", "address_missing"),
          emailRow("e-3", "th-2", "manual"),
        ]);

        const result = await getTransactions({ user_id: TEST_USER_ID });

        // th-1 is MIXED, so both of its emails count; th-2 contributes its one.
        expect(result[0].email_count).toBe(3);
      });

      it("excludes a conversation whose every email is address_missing", async () => {
        mockListWith([
          emailRow("e-1", "th-1", "address_found"),
          emailRow("e-2", "th-2", "address_missing"),
          emailRow("e-3", "th-2", "address_missing"),
        ]);

        const result = await getTransactions({ user_id: TEST_USER_ID });

        // The founder's shape in miniature: th-2 is wholly in review and the card
        // must not count it, because the Emails tab does not list it.
        expect(result[0].email_count).toBe(1);
      });

      it("no longer computes the count in SQL", async () => {
        mockListWith([]);

        await getTransactions({ user_id: TEST_USER_ID });

        const transactionSql = mockDbAll.mock.calls[0][0] as string;

        // Two producers of one number is the shape BACKLOG-2865 removed. If a
        // subquery comes back here it will diverge from the tab again, silently.
        expect(transactionSql).not.toContain("COUNT(DISTINCT c.email_id)");
        expect(transactionSql).not.toContain("as email_count");
      });

      it("fetches the scoped rows the count needs, joined to emails", async () => {
        mockListWith([]);

        await getTransactions({ user_id: TEST_USER_ID });

        const rowSql = mockDbAll.mock.calls[1][0] as string;

        // INNER, not LEFT: it mirrors getCommunicationsWithMessages, which derives
        // channel from this join and drops rows that do not make it.
        expect(rowSql).toContain("INNER JOIN emails e ON e.id = c.email_id");
        expect(rowSql).toContain("c.match_reason");
        expect(rowSql).toContain("e.thread_id");
        expect(rowSql).toContain("e.subject");
        expect(rowSql).toContain("c.email_id IS NOT NULL");
        // The loader's order, which the de-duplication depends on.
        expect(rowSql).toContain("ORDER BY e.sent_at DESC");
      });

      it("scopes the row fetch by the SAME filter the transactions were selected by", async () => {
        mockListWith([]);

        await getTransactions({ user_id: TEST_USER_ID, status: "active" });

        const rowSql = mockDbAll.mock.calls[1][0] as string;
        const rowParams = mockDbAll.mock.calls[1][1] as unknown[];

        // A subselect rather than an IN list of ids — a user with a thousand deals
        // would blow SQLite's bound-variable limit. Re-deriving the filter by hand
        // is how the two halves drift apart, so the same clause and params are reused.
        expect(rowSql).toContain("SELECT t.id FROM transactions t WHERE 1=1");
        expect(rowSql).toContain("AND t.user_id = ?");
        expect(rowSql).toContain("AND t.status = ?");
        expect(rowParams).toEqual([TEST_USER_ID, "active"]);
      });

      it("should NOT reference deprecated communication_type column", async () => {
        mockListWith([]);

        await getTransactions({ user_id: TEST_USER_ID });

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify the old broken column is not used
        expect(sqlCall).not.toContain("communication_type");
        expect(sqlCall).not.toContain("COALESCE(m.channel");
      });
    });

    describe("getTransactionById - email_count", () => {
      it("should return email_count of 0 when no emails are linked", async () => {
        mockDbGet.mockReturnValue({
          id: TEST_TRANSACTION_ID,
          user_id: TEST_USER_ID,
        });
        mockDbAll.mockReturnValue([]);

        const result = await getTransactionById(TEST_TRANSACTION_ID);

        expect(result?.email_count).toBe(0);
      });

      it("counts the emails of linked conversations", async () => {
        mockDbGet.mockReturnValue({
          id: TEST_TRANSACTION_ID,
          user_id: TEST_USER_ID,
        });
        mockDbAll.mockReturnValue([
          emailRow("e-1", "th-1", "address_found"),
          emailRow("e-2", "th-1", "address_missing"),
          emailRow("e-3", "th-2", "address_missing"),
        ]);

        const result = await getTransactionById(TEST_TRANSACTION_ID);

        expect(result?.email_count).toBe(2);
      });

      it("is scoped too — this is the producer getOverview returns", async () => {
        mockDbGet.mockReturnValue({
          id: TEST_TRANSACTION_ID,
          user_id: TEST_USER_ID,
        });
        mockDbAll.mockReturnValue([]);

        await getTransactionById(TEST_TRANSACTION_ID);

        const transactionSql = mockDbGet.mock.calls[0][0] as string;
        const rowSql = mockDbAll.mock.calls[0][0] as string;

        // TransactionDetails re-reads email_count from getOverview after every
        // auto-sync (BACKLOG-2838). Scoping only the list producer would show the
        // right number on load and the wrong one after the first refresh — and
        // every static test would still pass.
        expect(transactionSql).not.toContain("COUNT(DISTINCT c.email_id)");
        expect(rowSql).toContain("INNER JOIN emails e ON e.id = c.email_id");
      });

      it("should NOT reference deprecated communication_type column", async () => {
        mockDbGet.mockReturnValue(null);
        mockDbAll.mockReturnValue([]);

        await getTransactionById(TEST_TRANSACTION_ID);

        const sqlCall = mockDbGet.mock.calls[0][0] as string;

        expect(sqlCall).not.toContain("communication_type");
        expect(sqlCall).not.toContain("COALESCE(m.channel");
      });
    });
  });
});
