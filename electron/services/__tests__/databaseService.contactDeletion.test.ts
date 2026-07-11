/**
 * Unit tests for contact deletion prevention feature
 * Tests the getTransactionsByContact method in databaseService
 */

import type { Database, Statement } from "better-sqlite3";

interface MockStatement {
  get: jest.Mock;
  all: jest.Mock;
  run: jest.Mock;
}

interface TransactionResult {
  id: string;
  property_address: string;
  closed_at: string;
  transaction_type: string;
  status: string;
  role?: string;
  specific_role?: string | null;
  role_category?: string | null;
  roles?: string[];
}

// Mock statement that returns results
const createMockStatement = <T>(returnValue: T): MockStatement => ({
  get: jest.fn(() => returnValue),
  all: jest.fn(() => returnValue),
  run: jest.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
});

// Track mock statement calls
let mockStatementCalls: string[] = [];
let mockStatementReturnValues: TransactionResult[][] = [];
let callIndex = 0;

// Mock database with better-sqlite3 synchronous API
const mockDatabase = {
  prepare: jest.fn((sql: string) => {
    const returnValue = mockStatementReturnValues[callIndex] || [];
    callIndex++;
    mockStatementCalls.push(sql);
    return createMockStatement(returnValue);
  }),
  exec: jest.fn(),
  pragma: jest.fn(() => []),
  close: jest.fn(),
};

// Mock electron before requiring databaseService
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/app/path"),
  },
}));

// Mock better-sqlite3-multiple-ciphers
jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => mockDatabase);
});

// Mock databaseEncryptionService
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("mock-encryption-key"),
  },
}));

// Mock logService
jest.mock("../logService", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock fs
jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  renameSync: jest.fn(),
}));

// Mock dbConnection module for delegation support
jest.mock("../db/core/dbConnection", () => ({
  ensureDb: jest.fn(() => mockDatabase),
  dbGet: jest.fn((sql: string, params: unknown[]) => {
    const stmt = mockDatabase.prepare(sql);
    return stmt.get(...params);
  }),
  dbAll: jest.fn((sql: string, params: unknown[]) => {
    const stmt = mockDatabase.prepare(sql);
    return stmt.all(...params);
  }),
  dbRun: jest.fn((sql: string, params: unknown[]) => {
    const stmt = mockDatabase.prepare(sql);
    return stmt.run(...params);
  }),
  setDb: jest.fn(),
  setDbPath: jest.fn(),
  setEncryptionKey: jest.fn(),
  closeDb: jest.fn(),
  vacuumDb: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const databaseService = require("../databaseService").default;

describe("DatabaseService - Contact Deletion Prevention", () => {
  beforeEach(() => {
    // Reset mock state
    mockStatementCalls = [];
    mockStatementReturnValues = [];
    callIndex = 0;
    mockDatabase.prepare.mockClear();

    // Set the db directly to avoid initialization
    databaseService.db = mockDatabase;
  });

  describe("getTransactionsByContact", () => {
    const contactId = "contact-123";

    it("should return empty array when contact has no associated transactions", async () => {
      // Mock empty results for all three queries
      mockStatementReturnValues = [[], [], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toEqual([]);
      expect(mockDatabase.prepare).toHaveBeenCalledTimes(3);
    });

    it("should find transactions via direct FK references (buyer_agent_id)", async () => {
      const mockTransaction: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        role: "Buyer Agent",
      };

      // Direct FK returns transaction, junction and JSON return empty
      mockStatementReturnValues = [[mockTransaction], [], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "txn-1",
        property_address: "123 Main St",
        // BACKLOG-1930: roles is a string[] at the data boundary.
        roles: ["Buyer Agent"],
      });
    });

    it("should find transactions via junction table (transaction_contacts)", async () => {
      const mockTransaction: TransactionResult = {
        id: "txn-2",
        property_address: "456 Oak Ave",
        closed_at: "2024-02-20",
        transaction_type: "sale",
        status: "active",
        specific_role: "inspector",
        role_category: "inspection",
      };

      // Direct FK empty, junction returns transaction, JSON empty
      mockStatementReturnValues = [[], [mockTransaction], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "txn-2",
        property_address: "456 Oak Ave",
        roles: ["inspector"],
      });
    });

    it("should find transactions via JSON array (other_contacts)", async () => {
      const mockTransaction: TransactionResult = {
        id: "txn-3",
        property_address: "789 Elm St",
        closed_at: "2024-03-10",
        transaction_type: "purchase",
        status: "closed",
      };

      // Direct FK and junction empty, JSON returns transaction
      mockStatementReturnValues = [[], [], [mockTransaction]];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "txn-3",
        property_address: "789 Elm St",
        roles: ["Other Contact"],
      });
    });

    it("should deduplicate transactions found in multiple sources", async () => {
      const directTxn: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        role: "Buyer Agent",
      };

      const junctionTxn: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        specific_role: "escrow_officer",
        role_category: "title_escrow",
      };

      // Same transaction found in direct FK and junction
      mockStatementReturnValues = [[directTxn], [junctionTxn], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("txn-1");
      expect(result[0].roles).toContain("Buyer Agent");
      expect(result[0].roles).toContain("escrow_officer");
    });

    it("should combine multiple roles from the same transaction", async () => {
      const transactions: TransactionResult[] = [
        {
          id: "txn-1",
          property_address: "123 Main St",
          closed_at: "2024-01-15",
          transaction_type: "purchase",
          status: "active",
          role: "Buyer Agent",
        },
        {
          id: "txn-1",
          property_address: "123 Main St",
          closed_at: "2024-01-15",
          transaction_type: "purchase",
          status: "active",
          role: "Seller Agent",
        },
      ];

      mockStatementReturnValues = [transactions, [], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(1);
      // BACKLOG-1930: roles is a deduped string[] at the data boundary (no join).
      expect(result[0].roles).toEqual(["Buyer Agent", "Seller Agent"]);
    });

    it("should handle multiple transactions across different sources", async () => {
      const directTxn: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        role: "Buyer Agent",
      };

      const junctionTxn: TransactionResult = {
        id: "txn-2",
        property_address: "456 Oak Ave",
        closed_at: "2024-02-20",
        transaction_type: "sale",
        status: "active",
        specific_role: "inspector",
      };

      const jsonTxn: TransactionResult = {
        id: "txn-3",
        property_address: "789 Elm St",
        closed_at: "2024-03-10",
        transaction_type: "purchase",
        status: "closed",
      };

      mockStatementReturnValues = [[directTxn], [junctionTxn], [jsonTxn]];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(3);
      expect(result.map((t: TransactionResult) => t.id)).toEqual([
        "txn-1",
        "txn-2",
        "txn-3",
      ]);
    });

    it("should use role_category when specific_role is not available", async () => {
      const mockTransaction: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        specific_role: null,
        role_category: "inspection",
      };

      mockStatementReturnValues = [[], [mockTransaction], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      // BACKLOG-1930: roles is a string[] (no join at the data layer).
      expect(result[0].roles).toEqual(["inspection"]);
    });

    it('should use "Associated Contact" as fallback when no role is specified', async () => {
      const mockTransaction: TransactionResult = {
        id: "txn-1",
        property_address: "123 Main St",
        closed_at: "2024-01-15",
        transaction_type: "purchase",
        status: "active",
        specific_role: null,
        role_category: null,
      };

      mockStatementReturnValues = [[], [mockTransaction], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      // BACKLOG-1930: roles is a string[] (no join at the data layer).
      expect(result[0].roles).toEqual(["Associated Contact"]);
    });

    it("should handle all transaction types and statuses", async () => {
      const transactions: TransactionResult[] = [
        {
          id: "txn-1",
          property_address: "123 Main St",
          closed_at: "2024-01-15",
          transaction_type: "purchase",
          status: "active",
          role: "Buyer Agent",
        },
        {
          id: "txn-2",
          property_address: "456 Oak Ave",
          closed_at: "2024-02-20",
          transaction_type: "sale",
          status: "closed",
          role: "Seller Agent",
        },
      ];

      mockStatementReturnValues = [transactions, [], []];

      const result = await databaseService.getTransactionsByContact(contactId);

      expect(result).toHaveLength(2);
      expect(result[0].transaction_type).toBe("purchase");
      expect(result[0].status).toBe("active");
      expect(result[1].transaction_type).toBe("sale");
      expect(result[1].status).toBe("closed");
    });
  });
});
