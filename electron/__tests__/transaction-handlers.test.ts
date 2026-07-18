/**
 * Unit tests for Transaction Handlers
 * Tests transaction IPC handlers including:
 * - CRUD operations
 * - Email scanning
 * - Contact assignment
 * - Export functionality
 */

import type { IpcMainInvokeEvent } from "electron";

// Mock electron module
const mockIpcHandle = jest.fn();
const mockWebContentsSend = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  BrowserWindow: jest.fn(),
}));

// Mock services - inline factories since jest.mock is hoisted
jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: {
    scanAndExtractTransactions: jest.fn(),
    getTransactions: jest.fn(),
    createManualTransaction: jest.fn(),
    getTransactionDetails: jest.fn(),
    updateTransaction: jest.fn(),
    deleteTransaction: jest.fn(),
    createAuditedTransaction: jest.fn(),
    getTransactionWithContacts: jest.fn(),
    assignContactToTransaction: jest.fn(),
    removeContactFromTransaction: jest.fn(),
    reanalyzeProperty: jest.fn(),
  },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("../services/folderExportService", () => ({
  __esModule: true,
  default: {
    getDefaultExportPath: jest.fn().mockReturnValue("/exports/transaction"),
    exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/path/to/export.pdf"),
    exportTransactionToFolder: jest.fn().mockResolvedValue("/exports/transaction"),
  },
}));

jest.mock("../services/enhancedExportService", () => ({
  __esModule: true,
  default: {
    exportTransaction: jest.fn(),
  },
}));

// BACKLOG-2006a: export-mechanics suite — mock the paywall gate as UNLOCKED so
// these tests are not blocked by it (the gate has dedicated tests elsewhere).
jest.mock("../services/exportGate", () => ({
  __esModule: true,
  PaywallLockedError: class PaywallLockedError extends Error {
    code = "PAYWALL_LOCKED";
  },
  enforceExportGate: jest.fn(
    async ({ communications }: { communications: unknown[] }) => ({
      decision: { allowed: true, mode: "full" },
      communications,
    }),
  ),
  emitExportCompleted: jest.fn().mockResolvedValue(undefined),
}));

// Mock rate limiters to always allow in tests
jest.mock("../utils/rateLimit", () => ({
  rateLimiters: {
    scan: {
      canExecute: jest.fn().mockReturnValue({ allowed: true }),
      clearAll: jest.fn(),
    },
  },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    // The handler uses: const { databaseService: db } = require('./services/databaseService').default;
    // So we need to expose databaseService as a property of default
    databaseService: {
      updateTransaction: jest.fn(),
    },
    updateTransaction: jest.fn(),
    isInitialized: jest.fn().mockReturnValue(true),
  },
}));

// Import after mocks are set up
import { registerTransactionHandlers } from "../handlers/transactionHandlers";
import transactionService from "../services/transactionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import folderExportService from "../services/folderExportService";
import enhancedExportService from "../services/enhancedExportService";
import databaseService from "../services/databaseService";

// Get typed references to mocked services
const mockTransactionService = transactionService as jest.Mocked<
  typeof transactionService
>;
const mockAuditService = auditService as jest.Mocked<typeof auditService>;
const mockLogService = logService as jest.Mocked<typeof logService>;
const mockFolderExportService = folderExportService as jest.Mocked<
  typeof folderExportService
>;
const mockEnhancedExportService = enhancedExportService as jest.Mocked<
  typeof enhancedExportService
>;
const mockDatabaseServiceModule = {
  default: databaseService as jest.Mocked<typeof databaseService>,
};

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_TXN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_CONTACT_ID = "550e8400-e29b-41d4-a716-446655440002";
const TEST_NONEXISTENT_TXN_ID = "550e8400-e29b-41d4-a716-446655449999"; // Valid UUID format, but doesn't exist

describe("Transaction Handlers", () => {
  let registeredHandlers: Map<string, Function>;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockMainWindow = {
    webContents: {
      send: mockWebContentsSend,
    },
    isDestroyed: () => false,
  };

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = new Map();
    mockIpcHandle.mockImplementation((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    registerTransactionHandlers(mockMainWindow as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("transactions:scan", () => {
    it("should scan and extract transactions successfully", async () => {
      const scanResult = {
        success: true,
        transactionsFound: 5,
        emailsScanned: 100,
        realEstateEmailsFound: 20,
      };
      mockTransactionService.scanAndExtractTransactions.mockResolvedValue(
        scanResult,
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(true);
      expect(result.transactionsFound).toBe(5);
      expect(mockLogService.info).toHaveBeenCalledWith(
        "Starting transaction scan",
        "Transactions",
        expect.any(Object),
      );
    });

    it("should send progress updates to renderer", async () => {
      mockTransactionService.scanAndExtractTransactions.mockImplementation(
        async (userId: string, options: { onProgress?: Function }) => {
          if (options.onProgress) {
            options.onProgress({ progress: 50 });
          }
          return { success: true };
        },
      );

      const handler = registeredHandlers.get("transactions:scan");
      await handler(mockEvent, TEST_USER_ID, {});

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        "transactions:scan-progress",
        { progress: 50 },
      );
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, "", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle scan failure", async () => {
      mockTransactionService.scanAndExtractTransactions.mockRejectedValue(
        new Error("Scan failed"),
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Scan failed");
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("transactions:get-all", () => {
    it("should return all transactions for user", async () => {
      const mockTransactions = [
        { id: "txn-1", property_address: "123 Main St" },
        { id: "txn-2", property_address: "456 Oak Ave" },
      ];
      mockTransactionService.getTransactions.mockResolvedValue(
        mockTransactions,
      );

      const handler = registeredHandlers.get("transactions:get-all");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("transactions:get-all");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle database error", async () => {
      mockTransactionService.getTransactions.mockRejectedValue(
        new Error("Database error"),
      );

      const handler = registeredHandlers.get("transactions:get-all");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database error");
    });
  });

  describe("transactions:create", () => {
    const validTransactionData = {
      property_address: "123 Main St",
      transaction_type: "purchase",
      status: "pending",
    };

    it("should create transaction successfully", async () => {
      const createdTransaction = {
        id: "txn-new",
        ...validTransactionData,
      };
      mockTransactionService.createManualTransaction.mockResolvedValue(
        createdTransaction,
      );

      const handler = registeredHandlers.get("transactions:create");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        validTransactionData,
      );

      expect(result.success).toBe(true);
      expect(result.transaction).toEqual(createdTransaction);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TRANSACTION_CREATE",
          success: true,
        }),
      );
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("transactions:create");
      const result = await handler(mockEvent, "", validTransactionData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should validate transaction data", async () => {
      const handler = registeredHandlers.get("transactions:create");
      const result = await handler(mockEvent, TEST_USER_ID, {
        // Missing required fields
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle creation failure", async () => {
      mockTransactionService.createManualTransaction.mockRejectedValue(
        new Error("Creation failed"),
      );

      const handler = registeredHandlers.get("transactions:create");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        validTransactionData,
      );

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("transactions:get-details", () => {
    it("should return transaction details", async () => {
      const mockDetails = {
        id: TEST_TXN_ID,
        property_address: "123 Main St",
        communications: [],
      };
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );

      const handler = registeredHandlers.get("transactions:get-details");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(result.transaction).toEqual(mockDetails);
    });

    it("should handle transaction not found", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(null);

      const handler = registeredHandlers.get("transactions:get-details");
      const result = await handler(mockEvent, TEST_NONEXISTENT_TXN_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:get-details");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("transactions:update", () => {
    const existingTransaction = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St",
    };

    it("should update transaction successfully", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        existingTransaction,
      );
      mockTransactionService.updateTransaction.mockResolvedValue({
        ...existingTransaction,
        status: "closed",
      });

      const handler = registeredHandlers.get("transactions:update");
      // Valid statuses: 'active', 'pending', 'closed', 'cancelled'
      const result = await handler(mockEvent, TEST_TXN_ID, {
        status: "closed",
      });

      expect(result.success).toBe(true);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TRANSACTION_UPDATE",
          success: true,
        }),
      );
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:update");
      const result = await handler(mockEvent, "", { status: "closed" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle update failure", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        existingTransaction,
      );
      mockTransactionService.updateTransaction.mockRejectedValue(
        new Error("Update failed"),
      );

      const handler = registeredHandlers.get("transactions:update");
      const result = await handler(mockEvent, TEST_TXN_ID, {
        status: "closed",
      });

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("transactions:delete", () => {
    const existingTransaction = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St",
    };

    it("should delete transaction successfully", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        existingTransaction,
      );
      mockTransactionService.deleteTransaction.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("transactions:delete");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "TRANSACTION_DELETE",
          success: true,
        }),
      );
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:delete");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle delete failure", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        existingTransaction,
      );
      mockTransactionService.deleteTransaction.mockRejectedValue(
        new Error("Delete failed"),
      );

      const handler = registeredHandlers.get("transactions:delete");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("transactions:create-audited", () => {
    const validData = {
      property_address: "123 Main St",
      transaction_type: "purchase",
    };

    it("should create audited transaction successfully", async () => {
      const createdTransaction = { id: "txn-new", ...validData };
      mockTransactionService.createAuditedTransaction.mockResolvedValue(
        createdTransaction,
      );

      const handler = registeredHandlers.get("transactions:create-audited");
      const result = await handler(mockEvent, TEST_USER_ID, validData);

      expect(result.success).toBe(true);
      expect(result.transaction).toEqual(createdTransaction);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("transactions:create-audited");
      const result = await handler(mockEvent, "", validData);

      expect(result.success).toBe(false);
    });

    it("should handle creation failure", async () => {
      mockTransactionService.createAuditedTransaction.mockRejectedValue(
        new Error("Creation failed"),
      );

      const handler = registeredHandlers.get("transactions:create-audited");
      const result = await handler(mockEvent, TEST_USER_ID, validData);

      expect(result.success).toBe(false);
    });
  });

  describe("transactions:get-with-contacts", () => {
    it("should return transaction with contacts", async () => {
      const mockTransaction = {
        id: TEST_TXN_ID,
        property_address: "123 Main St",
        contacts: [{ id: "contact-1", name: "John Doe" }],
      };
      mockTransactionService.getTransactionWithContacts.mockResolvedValue(
        mockTransaction,
      );

      const handler = registeredHandlers.get("transactions:get-with-contacts");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(result.transaction.contacts).toHaveLength(1);
    });

    it("should handle transaction not found", async () => {
      mockTransactionService.getTransactionWithContacts.mockResolvedValue(null);

      const handler = registeredHandlers.get("transactions:get-with-contacts");
      const result = await handler(mockEvent, TEST_NONEXISTENT_TXN_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("transactions:assign-contact", () => {
    it("should assign contact to transaction successfully", async () => {
      // TASK-1031: assignContactToTransaction now returns AssignContactResult
      mockTransactionService.assignContactToTransaction.mockResolvedValue({
        success: true,
        autoLink: { emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0, errors: 0 },
      });

      const handler = registeredHandlers.get("transactions:assign-contact");
      const result = await handler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "buyer",
        "client",
        true,
        "Primary buyer",
      );

      expect(result.success).toBe(true);
      expect(
        mockTransactionService.assignContactToTransaction,
      ).toHaveBeenCalledWith(
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "buyer",
        "client",
        true,
        "Primary buyer",
      );
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:assign-contact");
      const result = await handler(
        mockEvent,
        "",
        TEST_CONTACT_ID,
        "buyer",
        "client",
        true,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid role", async () => {
      const handler = registeredHandlers.get("transactions:assign-contact");
      const result = await handler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "", // Empty role
        "client",
        true,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid isPrimary type", async () => {
      const handler = registeredHandlers.get("transactions:assign-contact");
      const result = await handler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "buyer",
        "client",
        "yes" as any, // Should be boolean
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("transactions:remove-contact", () => {
    it("should remove contact from transaction successfully", async () => {
      mockTransactionService.removeContactFromTransaction.mockResolvedValue(
        undefined,
      );

      const handler = registeredHandlers.get("transactions:remove-contact");
      const result = await handler(mockEvent, TEST_TXN_ID, TEST_CONTACT_ID);

      expect(result.success).toBe(true);
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:remove-contact");
      const result = await handler(mockEvent, "", TEST_CONTACT_ID);

      expect(result.success).toBe(false);
    });

    it("should handle removal failure", async () => {
      mockTransactionService.removeContactFromTransaction.mockRejectedValue(
        new Error("Removal failed"),
      );

      const handler = registeredHandlers.get("transactions:remove-contact");
      const result = await handler(mockEvent, TEST_TXN_ID, TEST_CONTACT_ID);

      expect(result.success).toBe(false);
    });
  });

  describe("transactions:reanalyze", () => {
    it("should reanalyze property successfully", async () => {
      mockTransactionService.reanalyzeProperty.mockResolvedValue({
        emailsScanned: 50,
        updatesFound: 3,
      });

      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "google",
        "123 Main St, City, State 12345",
      );

      expect(result.success).toBe(true);
      expect(result.emailsScanned).toBe(50);
    });

    it("should handle invalid property address", async () => {
      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(mockEvent, TEST_USER_ID, "google", "ab"); // Too short

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid provider", async () => {
      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "invalid-provider",
        "123 Main St, City, State 12345",
      );

      expect(result.success).toBe(false);
    });
  });

  describe("transactions:export-pdf", () => {
    const mockDetails = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St",
      communications: [],
    };

    it("should export transaction to PDF successfully", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );
      mockFolderExportService.exportTransactionToCombinedPDF.mockResolvedValue(
        "/path/to/export.pdf",
      );

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(result.path).toBe("/path/to/export.pdf");
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DATA_EXPORT",
          success: true,
        }),
      );
    });

    it("should use custom output path if provided", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );
      mockFolderExportService.exportTransactionToCombinedPDF.mockResolvedValue(
        "/custom/path.pdf",
      );

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, TEST_TXN_ID, "/custom/path.pdf");

      expect(result.success).toBe(true);
      expect(mockFolderExportService.exportTransactionToCombinedPDF).toHaveBeenCalledWith(
        mockDetails,
        expect.any(Array),
        "/custom/path.pdf",
      );
    });

    it("should handle transaction not found", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(null);

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle export failure", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );
      mockFolderExportService.exportTransactionToCombinedPDF.mockRejectedValue(
        new Error("Export failed"),
      );

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(false);
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("transactions:export-enhanced", () => {
    const mockDetails = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St",
      communications: [],
      export_count: 0,
    };

    it("should export with enhanced options successfully", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );
      mockEnhancedExportService.exportTransaction.mockResolvedValue(
        "/path/to/export.pdf",
      );
      mockDatabaseServiceModule.default.updateTransaction.mockResolvedValue(
        undefined,
      );

      const handler = registeredHandlers.get("transactions:export-enhanced");
      const result = await handler(mockEvent, TEST_TXN_ID, {
        exportFormat: "pdf",
      });

      expect(result.success).toBe(true);
      expect(result.path).toBe("/path/to/export.pdf");
      expect(mockAuditService.log).toHaveBeenCalled();
    });

    it("should handle transaction not found", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(null);

      const handler = registeredHandlers.get("transactions:export-enhanced");
      const result = await handler(mockEvent, TEST_TXN_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should handle export failure", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockDetails,
      );
      mockEnhancedExportService.exportTransaction.mockRejectedValue(
        new Error("Export failed"),
      );

      const handler = registeredHandlers.get("transactions:export-enhanced");
      const result = await handler(mockEvent, TEST_TXN_ID, {});

      expect(result.success).toBe(false);
    });
  });
});
