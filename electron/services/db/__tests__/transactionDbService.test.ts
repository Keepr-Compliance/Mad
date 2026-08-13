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
   * TASK-1403: Email count calculation tests
   * Verifies that email_count is correctly calculated using the new three-table architecture
   * (emails, messages, communications as junction table)
   */
  describe("email count calculation", () => {
    const TEST_USER_ID = "test-user-123";
    const TEST_TRANSACTION_ID = "test-transaction-456";

    beforeEach(() => {
      jest.clearAllMocks();
    });

    describe("getTransactions - email_count", () => {
      it("should return email_count of 0 when no emails are linked", async () => {
        mockDbAll.mockReturnValue([
          {
            id: TEST_TRANSACTION_ID,
            user_id: TEST_USER_ID,
            total_communications_count: 0,
            email_count: 0,
          },
        ]);

        const result = await getTransactions({ user_id: TEST_USER_ID });

        expect(result[0].email_count).toBe(0);
      });

      it("should return correct email_count when emails are linked", async () => {
        mockDbAll.mockReturnValue([
          {
            id: TEST_TRANSACTION_ID,
            user_id: TEST_USER_ID,
            total_communications_count: 5,
            email_count: 3,
          },
        ]);

        const result = await getTransactions({ user_id: TEST_USER_ID });

        expect(result[0].email_count).toBe(3);
      });

      it("should generate SQL that counts distinct email_id values", async () => {
        mockDbAll.mockReturnValue([]);

        await getTransactions({ user_id: TEST_USER_ID });

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify the email count subquery uses COUNT(DISTINCT c.email_id)
        expect(sqlCall).toContain("COUNT(DISTINCT c.email_id)");
        expect(sqlCall).toContain("c.email_id IS NOT NULL");
      });

      it("should NOT reference deprecated communication_type column", async () => {
        mockDbAll.mockReturnValue([]);

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
          email_count: 0,
        });

        const result = await getTransactionById(TEST_TRANSACTION_ID);

        expect(result?.email_count).toBe(0);
      });

      it("should return correct email_count when emails are linked", async () => {
        mockDbGet.mockReturnValue({
          id: TEST_TRANSACTION_ID,
          user_id: TEST_USER_ID,
          email_count: 7,
        });

        const result = await getTransactionById(TEST_TRANSACTION_ID);

        expect(result?.email_count).toBe(7);
      });

      it("should generate SQL that counts distinct email_id values", async () => {
        mockDbGet.mockReturnValue(null);

        await getTransactionById(TEST_TRANSACTION_ID);

        const sqlCall = mockDbGet.mock.calls[0][0] as string;

        // Verify the email count subquery uses COUNT(DISTINCT c.email_id)
        expect(sqlCall).toContain("COUNT(DISTINCT c.email_id)");
        expect(sqlCall).toContain("c.email_id IS NOT NULL");
      });

      it("should NOT reference deprecated communication_type column", async () => {
        mockDbGet.mockReturnValue(null);

        await getTransactionById(TEST_TRANSACTION_ID);

        const sqlCall = mockDbGet.mock.calls[0][0] as string;

        // Verify the old broken column is not used
        expect(sqlCall).not.toContain("communication_type");
        expect(sqlCall).not.toContain("COALESCE(m.channel");
      });

      it("should return null when transaction is not found", async () => {
        mockDbGet.mockReturnValue(undefined);

        const result = await getTransactionById("non-existent-id");

        expect(result).toBeNull();
      });
    });

    describe("email_count SQL query structure", () => {
      it("getTransactions email_count subquery should match expected pattern", async () => {
        mockDbAll.mockReturnValue([]);

        await getTransactions({ user_id: TEST_USER_ID });

        const sqlCall = mockDbAll.mock.calls[0][0] as string;

        // Verify the email_count subquery structure
        // (SELECT COUNT(DISTINCT c.email_id) FROM communications c WHERE c.transaction_id = t.id AND c.email_id IS NOT NULL)
        expect(sqlCall).toMatch(/SELECT COUNT\(DISTINCT c\.email_id\)/);
        expect(sqlCall).toMatch(/FROM communications c/);
        expect(sqlCall).toMatch(/WHERE c\.transaction_id = t\.id/);
        expect(sqlCall).toMatch(/AND c\.email_id IS NOT NULL/);
      });

      it("getTransactionById email_count subquery should match expected pattern", async () => {
        mockDbGet.mockReturnValue(null);

        await getTransactionById(TEST_TRANSACTION_ID);

        const sqlCall = mockDbGet.mock.calls[0][0] as string;

        // Verify the email_count subquery structure
        expect(sqlCall).toMatch(/SELECT COUNT\(DISTINCT c\.email_id\)/);
        expect(sqlCall).toMatch(/FROM communications c/);
        expect(sqlCall).toMatch(/WHERE c\.transaction_id = t\.id/);
        expect(sqlCall).toMatch(/AND c\.email_id IS NOT NULL/);
      });
    });
  });
});
