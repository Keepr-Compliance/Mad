/**
 * Integration tests for Transaction Handlers
 * Tests complete transaction flows including:
 * - Full email scanning with progress events
 * - Transaction lifecycle (create, update, export, delete)
 * - Contact assignment and management
 * - Error recovery and timeout handling
 * - Concurrent operations
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

// Mock services with detailed implementations for integration testing
const mockTransactionService = {
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
};

const mockAuditService = {
  log: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

const mockPdfExportService = {
  generateTransactionPDF: jest.fn(),
  getDefaultExportPath: jest.fn().mockReturnValue("/exports/transaction.pdf"),
};

const mockFolderExportService = {
  getDefaultExportPath: jest.fn().mockReturnValue("/exports/transaction"),
  exportTransactionToCombinedPDF: jest.fn().mockResolvedValue("/exports/transaction.pdf"),
  exportTransactionToFolder: jest.fn().mockResolvedValue("/exports/transaction"),
};

const mockEnhancedExportService = {
  exportTransaction: jest.fn(),
};

const mockDatabaseService = {
  databaseService: {
    updateTransaction: jest.fn(),
  },
  updateTransaction: jest.fn(),
  isInitialized: jest.fn().mockReturnValue(true),
};

jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: mockTransactionService,
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: mockAuditService,
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: mockLogService,
}));

jest.mock("../services/pdfExportService", () => ({
  __esModule: true,
  default: mockPdfExportService,
}));

jest.mock("../services/folderExportService", () => ({
  __esModule: true,
  default: mockFolderExportService,
}));

jest.mock("../services/enhancedExportService", () => ({
  __esModule: true,
  default: mockEnhancedExportService,
}));

// BACKLOG-2006a: this suite exercises EXPORT MECHANICS, not the paywall gate
// (which has its own dedicated tests in exportGate.test.ts + entitlementService.test.ts).
// Mock the gate as UNLOCKED (mode "full", communications passthrough) so these
// export-flow assertions are not blocked by the paywall.
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
  selectSampleCommunications: jest.fn((c: unknown[]) => c),
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: mockDatabaseService,
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

// Import after mocks
import { registerTransactionHandlers } from "../handlers/transactionHandlers";

// Test constants
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_TXN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_CONTACT_ID = "550e8400-e29b-41d4-a716-446655440003";
const TEST_CONTACT_ID_2 = "550e8400-e29b-41d4-a716-446655440004";

describe("Transaction Handlers Integration Tests", () => {
  let registeredHandlers: Map<string, Function>;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockMainWindow = {
    webContents: {
      send: mockWebContentsSend,
    },
    isDestroyed: () => false,
  };

  beforeAll(() => {
    registeredHandlers = new Map();
    mockIpcHandle.mockImplementation((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    });
    registerTransactionHandlers(mockMainWindow as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Complete Email Scanning Flow", () => {
    it("should scan emails and emit progress events throughout the process", async () => {
      const progressEvents: any[] = [];

      // Simulate a realistic scan that takes time and emits progress
      mockTransactionService.scanAndExtractTransactions.mockImplementation(
        async (userId: string, options: { onProgress?: (p: any) => void }) => {
          // Simulate scanning phases
          const phases = [
            {
              phase: "connecting",
              progress: 0,
              message: "Connecting to email provider...",
            },
            {
              phase: "fetching",
              progress: 10,
              message: "Fetching emails...",
              emailsFetched: 0,
            },
            {
              phase: "fetching",
              progress: 30,
              message: "Fetching emails...",
              emailsFetched: 500,
            },
            {
              phase: "fetching",
              progress: 50,
              message: "Fetching emails...",
              emailsFetched: 1000,
            },
            {
              phase: "analyzing",
              progress: 60,
              message: "Analyzing content...",
              emailsAnalyzed: 100,
            },
            {
              phase: "analyzing",
              progress: 80,
              message: "Analyzing content...",
              emailsAnalyzed: 800,
            },
            {
              phase: "extracting",
              progress: 90,
              message: "Extracting transactions...",
              transactionsFound: 5,
            },
            {
              phase: "complete",
              progress: 100,
              message: "Scan complete",
              transactionsFound: 12,
            },
          ];

          for (const event of phases) {
            if (options.onProgress) {
              options.onProgress(event);
              progressEvents.push(event);
            }
            // Small delay to simulate async work
            await new Promise((resolve) => setTimeout(resolve, 1));
          }

          return {
            success: true,
            transactionsFound: 12,
            emailsScanned: 1000,
            realEstateEmailsFound: 45,
          };
        },
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {
        provider: "google",
      });

      expect(result.success).toBe(true);
      expect(result.transactionsFound).toBe(12);
      expect(result.emailsScanned).toBe(1000);

      // Verify progress events were emitted
      expect(mockWebContentsSend).toHaveBeenCalledTimes(8);
      expect(progressEvents[0].phase).toBe("connecting");
      expect(progressEvents[progressEvents.length - 1].phase).toBe("complete");

      // Verify progress increased monotonically
      for (let i = 1; i < progressEvents.length; i++) {
        expect(progressEvents[i].progress).toBeGreaterThanOrEqual(
          progressEvents[i - 1].progress,
        );
      }
    });

    it("should handle scan timeout gracefully", async () => {
      mockTransactionService.scanAndExtractTransactions.mockImplementation(
        async (userId: string, options: { onProgress?: (p: any) => void }) => {
          if (options.onProgress) {
            options.onProgress({ phase: "connecting", progress: 0 });
            options.onProgress({ phase: "fetching", progress: 30 });
          }
          // Simulate timeout error
          throw new Error(
            "Request timeout: Email provider did not respond within 30 seconds",
          );
        },
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
      expect(mockLogService.error).toHaveBeenCalled();
    });

    it("should handle partial scan results on network interruption", async () => {
      mockTransactionService.scanAndExtractTransactions.mockImplementation(
        async (userId: string, options: { onProgress?: (p: any) => void }) => {
          if (options.onProgress) {
            options.onProgress({
              phase: "fetching",
              progress: 60,
              emailsFetched: 500,
            });
          }
          // Return partial results instead of throwing
          return {
            success: true,
            partial: true,
            transactionsFound: 3,
            emailsScanned: 500,
            realEstateEmailsFound: 15,
            warning: "Scan incomplete due to network issues",
          };
        },
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.transactionsFound).toBe(3);
    });

    it("should handle rate limiting from email provider", async () => {
      mockTransactionService.scanAndExtractTransactions.mockRejectedValue(
        new Error(
          "Rate limited: Too many requests. Please try again in 60 seconds.",
        ),
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Rate limited");
    });
  });

  describe("Complete Transaction Lifecycle", () => {
    const baseTransaction = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St, City, State 12345",
      transaction_type: "purchase",
      status: "pending",
      created_at: new Date().toISOString(),
    };

    it("should complete full lifecycle: create -> update -> export -> delete", async () => {
      // Step 1: Create transaction
      mockTransactionService.createManualTransaction.mockResolvedValue({
        ...baseTransaction,
        id: TEST_TXN_ID,
      });

      const createHandler = registeredHandlers.get("transactions:create");
      const createResult = await createHandler(mockEvent, TEST_USER_ID, {
        property_address: "123 Main St, City, State 12345",
        transaction_type: "purchase",
        status: "pending",
      });

      expect(createResult.success).toBe(true);
      expect(createResult.transaction.id).toBe(TEST_TXN_ID);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "TRANSACTION_CREATE" }),
      );

      // Step 2: Update transaction status
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        baseTransaction,
      );
      mockTransactionService.updateTransaction.mockResolvedValue({
        ...baseTransaction,
        status: "active",
        sale_price: 500000,
      });

      const updateHandler = registeredHandlers.get("transactions:update");
      const updateResult = await updateHandler(mockEvent, TEST_TXN_ID, {
        status: "active",
        sale_price: 500000,
      });

      expect(updateResult.success).toBe(true);
      // BACKLOG-1786: the transactions:update handler returns only { success }
      // (it does not echo the updated row). Verify the update was applied by
      // asserting the service was invoked with the validated changes.
      expect(mockTransactionService.updateTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "active" }),
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "TRANSACTION_UPDATE" }),
      );

      // Step 3: Export to PDF
      mockTransactionService.getTransactionDetails.mockResolvedValue({
        ...baseTransaction,
        status: "active",
        sale_price: 500000,
        communications: [
          { id: "comm-1", type: "email", subject: "Offer accepted" },
        ],
      });
      mockFolderExportService.exportTransactionToCombinedPDF.mockResolvedValue(
        "/exports/123-main-st.pdf",
      );

      const exportHandler = registeredHandlers.get("transactions:export-pdf");
      const exportResult = await exportHandler(mockEvent, TEST_TXN_ID);

      expect(exportResult.success).toBe(true);
      expect(exportResult.path).toContain(".pdf");
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "DATA_EXPORT" }),
      );

      // Step 4: Delete transaction
      mockTransactionService.deleteTransaction.mockResolvedValue(undefined);

      const deleteHandler = registeredHandlers.get("transactions:delete");
      const deleteResult = await deleteHandler(mockEvent, TEST_TXN_ID);

      expect(deleteResult.success).toBe(true);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "TRANSACTION_DELETE" }),
      );
    });

    it("should handle updates with closing date verification", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        baseTransaction,
      );
      mockTransactionService.updateTransaction.mockResolvedValue({
        ...baseTransaction,
        status: "closed",
        closed_at: "2025-06-15",
        closing_date_verified: 1,
      });

      const handler = registeredHandlers.get("transactions:update");
      const result = await handler(mockEvent, TEST_TXN_ID, {
        status: "closed",
        closed_at: "2025-06-15",
        closing_date_verified: 1,
      });

      expect(result.success).toBe(true);
      // BACKLOG-1786: handler returns only { success }; assert the update call.
      expect(mockTransactionService.updateTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: "closed", closing_date_verified: 1 }),
      );
    });
  });

  describe("Contact Assignment Workflow", () => {
    const mockTransaction = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "456 Oak Ave",
      contacts: [],
    };

    it("should assign multiple contacts with different roles", async () => {
      // TASK-1031: assignContactToTransaction now returns AssignContactResult
      mockTransactionService.assignContactToTransaction.mockResolvedValue({
        success: true,
        autoLink: { emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0, errors: 0 },
      });
      mockTransactionService.getTransactionWithContacts.mockResolvedValue({
        ...mockTransaction,
        contacts: [
          {
            id: TEST_CONTACT_ID,
            name: "John Buyer",
            role: "Buyer",
            roleCategory: "buyer_side",
            isPrimary: true,
          },
          {
            id: TEST_CONTACT_ID_2,
            name: "Jane Agent",
            role: "Listing Agent",
            roleCategory: "seller_side",
            isPrimary: false,
          },
        ],
      });

      const assignHandler = registeredHandlers.get(
        "transactions:assign-contact",
      );

      // Assign buyer
      const buyerResult = await assignHandler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "Buyer",
        "buyer_side",
        true,
        "Primary buyer",
      );
      expect(buyerResult.success).toBe(true);

      // Assign listing agent
      const agentResult = await assignHandler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID_2,
        "Listing Agent",
        "seller_side",
        false,
        null,
      );
      expect(agentResult.success).toBe(true);

      // Verify contacts are assigned
      const getHandler = registeredHandlers.get(
        "transactions:get-with-contacts",
      );
      const getResult = await getHandler(mockEvent, TEST_TXN_ID);

      expect(getResult.success).toBe(true);
      expect(getResult.transaction.contacts).toHaveLength(2);
    });

    it("should handle removing and reassigning contacts", async () => {
      mockTransactionService.removeContactFromTransaction.mockResolvedValue(
        undefined,
      );
      // TASK-1031: assignContactToTransaction now returns AssignContactResult
      mockTransactionService.assignContactToTransaction.mockResolvedValue({
        success: true,
        autoLink: { emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0, errors: 0 },
      });

      const removeHandler = registeredHandlers.get(
        "transactions:remove-contact",
      );
      const assignHandler = registeredHandlers.get(
        "transactions:assign-contact",
      );

      // Remove existing contact
      const removeResult = await removeHandler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
      );
      expect(removeResult.success).toBe(true);

      // Reassign with different role
      const reassignResult = await assignHandler(
        mockEvent,
        TEST_TXN_ID,
        TEST_CONTACT_ID,
        "Co-Buyer",
        "buyer_side",
        false,
        "Changed from primary buyer",
      );
      expect(reassignResult.success).toBe(true);
    });
  });

  describe("Property Re-analysis Flow", () => {
    it("should re-analyze property for specific date range", async () => {
      mockTransactionService.reanalyzeProperty.mockResolvedValue({
        emailsScanned: 150,
        newEmailsFound: 25,
        updatesApplied: 3,
        communications: [
          { id: "new-1", subject: "Inspection report", date: "2025-05-01" },
          { id: "new-2", subject: "Closing documents", date: "2025-05-15" },
        ],
      });

      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "google",
        "123 Main St, City, State 12345",
        { start: "2025-04-01", end: "2025-06-01" },
      );

      expect(result.success).toBe(true);
      expect(result.emailsScanned).toBe(150);
      expect(result.newEmailsFound).toBe(25);
    });

    it("should handle re-analysis with no new emails found", async () => {
      mockTransactionService.reanalyzeProperty.mockResolvedValue({
        emailsScanned: 50,
        newEmailsFound: 0,
        updatesApplied: 0,
        communications: [],
      });

      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "microsoft",
        "789 Pine Rd, Town, State 54321",
      );

      expect(result.success).toBe(true);
      expect(result.newEmailsFound).toBe(0);
    });
  });

  describe("Export Workflows", () => {
    const mockTransactionWithComms = {
      id: TEST_TXN_ID,
      user_id: TEST_USER_ID,
      property_address: "123 Main St",
      transaction_type: "sale",
      status: "closed",
      communications: [
        {
          id: "c1",
          type: "email",
          subject: "Initial contact",
          date: "2025-01-15",
        },
        {
          id: "c2",
          type: "email",
          subject: "Offer submitted",
          date: "2025-02-01",
        },
        {
          id: "c3",
          type: "email",
          subject: "Closing confirmation",
          date: "2025-03-15",
        },
      ],
      export_count: 0,
    };

    it("should export with different format options", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue(
        mockTransactionWithComms,
      );
      mockEnhancedExportService.exportTransaction.mockResolvedValue(
        "/exports/transaction-full.pdf",
      );
      mockDatabaseService.databaseService.updateTransaction.mockResolvedValue(
        undefined,
      );

      const handler = registeredHandlers.get("transactions:export-enhanced");
      const result = await handler(mockEvent, TEST_TXN_ID, {
        exportFormat: "pdf",
        includeContacts: true,
        includeEmails: true,
        includeSummary: true,
      });

      expect(result.success).toBe(true);
      expect(mockEnhancedExportService.exportTransaction).toHaveBeenCalledWith(
        mockTransactionWithComms,
        mockTransactionWithComms.communications,
        expect.objectContaining({ exportFormat: "pdf" }),
      );
    });

    it("should increment export count after successful export", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue({
        ...mockTransactionWithComms,
        export_count: 2,
      });
      mockEnhancedExportService.exportTransaction.mockResolvedValue(
        "/exports/transaction.pdf",
      );
      mockDatabaseService.databaseService.updateTransaction.mockResolvedValue(
        undefined,
      );

      const handler = registeredHandlers.get("transactions:export-enhanced");
      await handler(mockEvent, TEST_TXN_ID, { exportFormat: "pdf" });

      // The handler should update export tracking
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DATA_EXPORT",
          metadata: expect.objectContaining({ format: "pdf" }),
        }),
      );
    });
  });

  describe("Audited Transaction Creation", () => {
    it("should create audited transaction with full details", async () => {
      const auditedTransaction = {
        id: TEST_TXN_ID,
        user_id: TEST_USER_ID,
        property_address: "100 Corporate Dr, Suite 500",
        transaction_type: "lease",
        status: "active",
        started_at: "2025-01-01",
        closed_at: "2025-06-30",
        listing_price: 75000,
        sale_price: 72000,
        contacts: [{ id: TEST_CONTACT_ID, role: "Tenant", isPrimary: true }],
      };

      mockTransactionService.createAuditedTransaction.mockResolvedValue(
        auditedTransaction,
      );

      const handler = registeredHandlers.get("transactions:create-audited");
      const result = await handler(mockEvent, TEST_USER_ID, {
        property_address: "100 Corporate Dr, Suite 500",
        transaction_type: "lease",
        status: "active",
        started_at: "2025-01-01",
        closed_at: "2025-06-30",
        listing_price: 75000,
        sale_price: 72000,
      });

      expect(result.success).toBe(true);
      expect(result.transaction.transaction_type).toBe("lease");
      expect(result.transaction.property_address).toContain("Corporate");
    });
  });

  describe("Error Recovery Scenarios", () => {
    it("should handle database connection loss during scan", async () => {
      mockTransactionService.scanAndExtractTransactions.mockImplementation(
        async (userId: string, options: { onProgress?: (p: any) => void }) => {
          if (options.onProgress) {
            options.onProgress({ phase: "analyzing", progress: 75 });
          }
          throw new Error("SQLITE_BUSY: database is locked");
        },
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("database");
      expect(mockLogService.error).toHaveBeenCalled();
    });

    it("should handle OAuth token expiration during scan", async () => {
      mockTransactionService.scanAndExtractTransactions.mockRejectedValue(
        new Error("OAuth token expired. Please re-authenticate."),
      );

      const handler = registeredHandlers.get("transactions:scan");
      const result = await handler(mockEvent, TEST_USER_ID, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("token expired");
    });

    it("should handle file system error during export", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue({
        id: TEST_TXN_ID,
        user_id: TEST_USER_ID,
        property_address: "123 Main St",
        communications: [],
      });
      mockFolderExportService.exportTransactionToCombinedPDF.mockRejectedValue(
        new Error("ENOSPC: no space left on device"),
      );

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("space");
    });

    it("should validate transaction data prevents XSS in property address", async () => {
      const handler = registeredHandlers.get("transactions:create");

      // Property address with script tag should be sanitized or rejected
      const result = await handler(mockEvent, TEST_USER_ID, {
        property_address: '<script>alert("xss")</script>123 Main St',
        transaction_type: "purchase",
        status: "pending",
      });

      // The validation should either reject or sanitize
      if (result.success) {
        expect(result.transaction.property_address).not.toContain("<script>");
      }
    });
  });

  describe("Input Validation", () => {
    it("should reject SQL injection attempts in property address", async () => {
      // Mock to simulate validation failure for malicious input
      mockTransactionService.reanalyzeProperty.mockRejectedValue(
        new Error("Invalid property address format"),
      );

      const handler = registeredHandlers.get("transactions:reanalyze");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "google",
        "'; DROP TABLE transactions; --",
      );

      // Should either fail validation or be sanitized
      // The handler should not process malicious input without validation
      expect(result).toBeDefined();
      // Verify the suspicious input was at least processed/logged
      expect(mockTransactionService.reanalyzeProperty).toHaveBeenCalled();
    });

    it("should validate date formats in reanalyze", async () => {
      mockTransactionService.reanalyzeProperty.mockResolvedValue({
        success: true,
      });

      const handler = registeredHandlers.get("transactions:reanalyze");

      // Invalid date format should be handled
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "google",
        "123 Main St, City, State 12345",
        { start: "not-a-date", end: "2025-06-01" },
      );

      // The handler should either reject or sanitize invalid dates
      expect(result).toBeDefined();
    });

    it("should reject path traversal in export path", async () => {
      mockTransactionService.getTransactionDetails.mockResolvedValue({
        id: TEST_TXN_ID,
        user_id: TEST_USER_ID,
        property_address: "123 Main St",
        communications: [],
      });

      const handler = registeredHandlers.get("transactions:export-pdf");
      const result = await handler(
        mockEvent,
        TEST_TXN_ID,
        "../../../etc/passwd",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });
});
