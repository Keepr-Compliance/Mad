/**
 * @jest-environment node
 */

/**
 * Additional tests for TransactionService
 * Covers scanning workflow, contact assignments, and address parsing
 */

import transactionService from "../transactionService";
import databaseService from "../databaseService";
import gmailFetchService from "../gmailFetchService";
import outlookFetchService from "../outlookFetchService";
import transactionExtractorService from "../transactionExtractorService";
import logService from "../logService";
import type { Transaction, NewTransaction } from "../../types";
import type { TransactionWithDetails } from "../transactionService/types";

// Mock the dependencies
jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../logService");

// BACKLOG-506: Mock emailDbService for email content store
jest.mock("../db/emailDbService", () => ({
  createEmail: jest.fn().mockResolvedValue({
    id: "mock-email-id",
    user_id: "test-user-id",
    external_id: "mock-external-id",
    subject: "Test Subject",
    sender: "test@example.com",
  }),
  getEmailByExternalId: jest.fn().mockResolvedValue(null), // No existing email by default
}));

// TASK-1031: Mock autoLinkService
jest.mock("../autoLinkService", () => ({
  autoLinkCommunicationsForContact: jest.fn().mockResolvedValue({
    emailsLinked: 0,
    messagesLinked: 0,
    alreadyLinked: 0,
    errors: 0,
  }),
}));

// Mock hybrid extraction services
jest.mock("../extraction/extractionStrategyService", () => ({
  ExtractionStrategyService: jest.fn().mockImplementation(() => ({
    selectStrategy: jest.fn().mockResolvedValue({
      method: "pattern",
      reason: "Test: LLM not available",
      fallbackMethod: "pattern",
    }),
  })),
}));

jest.mock("../llm/llmConfigService", () => ({
  LLMConfigService: jest.fn().mockImplementation(() => ({
    getUserConfig: jest.fn().mockResolvedValue({
      hasConsent: false,
      hasOpenAI: false,
      hasAnthropic: false,
    }),
  })),
}));

jest.mock("../extraction/hybridExtractorService", () => ({
  HybridExtractorService: jest.fn().mockImplementation(() => ({
    extract: jest.fn(),
  })),
}));

describe("TransactionService - Additional Coverage", () => {
  const mockUserId = "test-user-id";
  const mockTransactionId = "test-transaction-id";
  const mockContactId = "test-contact-id";

  // Partial Transaction row: status/message_count/attachment_count/export_status/
  // export_count are required on the model but are never read on the paths under
  // test, so they are asserted away rather than invented. Present fields stay
  // type-checked against the model.
  const mockTransaction = {
    id: mockTransactionId,
    user_id: mockUserId,
    property_address: "123 Test St, San Francisco, CA 94102",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Transaction;

  beforeEach(() => {
    jest.clearAllMocks();
    // TASK-964: Default mock for deduplication lookup (returns empty Map = no duplicates)
    (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(new Map());
  });

  describe("scanAndExtractTransactions", () => {
    const mockEmails = [
      {
        subject: "RE: 123 Main St Offer",
        from: "agent@realty.com",
        date: "2024-01-15",
        to: "client@email.com",
      },
      {
        subject: "Closing Documents",
        from: "title@company.com",
        date: "2024-01-20",
        to: "agent@realty.com",
      },
    ];

    const mockAnalyzedEmails = [
      {
        subject: "RE: 123 Main St Offer",
        from: "agent@realty.com",
        date: "2024-01-15",
        isRealEstateRelated: true,
        keywords: "offer, closing",
        confidence: 85,
      },
      {
        subject: "Closing Documents",
        from: "title@company.com",
        date: "2024-01-20",
        isRealEstateRelated: true,
        keywords: "title, closing",
        confidence: 90,
      },
    ];

    const mockGrouped = {
      "123 Main St, City, ST 12345": mockAnalyzedEmails,
    };

    const mockSummary = {
      propertyAddress: "123 Main St, City, ST 12345",
      transactionType: "purchase",
      closingDate: "2024-02-15",
      communicationsCount: 2,
      confidence: 87,
      firstCommunication: "2024-01-15",
      lastCommunication: "2024-01-20",
      salePrice: 500000,
    };

    it("should scan and extract transactions from Gmail", async () => {
      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzedEmails,
      );
      (
        transactionExtractorService.groupByProperty as jest.Mock
      ).mockReturnValue(mockGrouped);
      (
        transactionExtractorService.generateTransactionSummary as jest.Mock
      ).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({
        id: "new-txn-id",
      });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      const result = await transactionService.scanAndExtractTransactions(
        mockUserId,
        {
          provider: "google",
          startDate: new Date("2024-01-01"),
          endDate: new Date("2024-02-01"),
        },
      );

      expect(gmailFetchService.initialize).toHaveBeenCalledWith(mockUserId);
      expect(result.success).toBe(true);
      expect(result.emailsScanned).toBe(2);
      expect(result.realEstateEmailsFound).toBe(2);
    });

    it("should scan and extract transactions from Outlook", async () => {
      (outlookFetchService.initialize as jest.Mock).mockResolvedValue(
        undefined,
      );
      (outlookFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzedEmails,
      );
      (
        transactionExtractorService.groupByProperty as jest.Mock
      ).mockReturnValue(mockGrouped);
      (
        transactionExtractorService.generateTransactionSummary as jest.Mock
      ).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({
        id: "new-txn-id",
      });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      const result = await transactionService.scanAndExtractTransactions(
        mockUserId,
        {
          provider: "microsoft",
        },
      );

      expect(outlookFetchService.initialize).toHaveBeenCalledWith(mockUserId);
      expect(result.success).toBe(true);
    });

    it("should call progress callback during scan", async () => {
      const onProgress = jest.fn();

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzedEmails,
      );
      (
        transactionExtractorService.groupByProperty as jest.Mock
      ).mockReturnValue(mockGrouped);
      (
        transactionExtractorService.generateTransactionSummary as jest.Mock
      ).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({
        id: "new-txn-id",
      });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith({
        step: "fetching",
        message: "Fetching emails...",
      });
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ step: "analyzing" }),
      );
      expect(onProgress).toHaveBeenCalledWith({
        step: "grouping",
        message: "Grouping by property...",
      });
      expect(onProgress).toHaveBeenCalledWith({
        step: "saving",
        message: "Saving transactions...",
      });
      expect(onProgress).toHaveBeenCalledWith({
        step: "complete",
        message: "Scan complete!",
      });
    });

    it("should throw error for unknown provider", async () => {
      await expect(
        transactionService.scanAndExtractTransactions(mockUserId, {
          provider: "unknown" as any,
        }),
      ).rejects.toThrow("Unknown provider: unknown");
    });

    it("should filter out non-real-estate emails", async () => {
      const mixedEmails = [
        ...mockEmails,
        {
          subject: "Your Amazon Order",
          from: "noreply@amazon.com",
          date: "2024-01-18",
        },
      ];

      const mixedAnalyzed = [
        ...mockAnalyzedEmails,
        {
          subject: "Your Amazon Order",
          from: "noreply@amazon.com",
          date: "2024-01-18",
          isRealEstateRelated: false,
        },
      ];

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mixedEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mixedAnalyzed,
      );
      (
        transactionExtractorService.groupByProperty as jest.Mock
      ).mockReturnValue(mockGrouped);
      (
        transactionExtractorService.generateTransactionSummary as jest.Mock
      ).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({
        id: "new-txn-id",
      });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      const result = await transactionService.scanAndExtractTransactions(
        mockUserId,
        {
          provider: "google",
        },
      );

      expect(result.emailsScanned).toBe(3);
      expect(result.realEstateEmailsFound).toBe(2); // Only 2 real estate emails
    });

    it("should skip properties with no valid summary", async () => {
      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzedEmails,
      );
      (
        transactionExtractorService.groupByProperty as jest.Mock
      ).mockReturnValue(mockGrouped);
      (
        transactionExtractorService.generateTransactionSummary as jest.Mock
      ).mockReturnValue(null); // No valid summary
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      const result = await transactionService.scanAndExtractTransactions(
        mockUserId,
        {
          provider: "google",
        },
      );

      expect(result.transactionsFound).toBe(0);
      expect(databaseService.createTransaction).not.toHaveBeenCalled();
    });

    it("should handle scan errors and log them", async () => {
      const scanError = new Error("Network error");
      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockRejectedValue(
        scanError,
      );
      (logService.error as jest.Mock).mockResolvedValue(undefined);

      await expect(
        transactionService.scanAndExtractTransactions(mockUserId, {
          provider: "google",
        }),
      ).rejects.toThrow("Network error");

      expect(logService.error).toHaveBeenCalledWith(
        "Transaction scan failed",
        "TransactionService.scanAndExtractTransactions",
        expect.objectContaining({
          error: "Network error",
          userId: mockUserId,
          providers: ["google"],
        }),
      );
    });
  });

  describe("getTransactionWithContacts", () => {
    it("should return transaction with contact assignments", async () => {
      const mockContacts = [
        { id: "contact-1", role: "buyer", is_primary: true },
        { id: "contact-2", role: "seller_agent", is_primary: false },
      ];

      (databaseService.getTransactionById as jest.Mock).mockResolvedValue(
        mockTransaction,
      );
      (databaseService.getTransactionContactsWithRoles as jest.Mock).mockResolvedValue(
        mockContacts,
      );

      const result =
        await transactionService.getTransactionWithContacts(mockTransactionId);

      expect(result).toEqual({
        ...mockTransaction,
        contact_assignments: mockContacts,
      });
    });

    it("should return null when transaction not found", async () => {
      (databaseService.getTransactionById as jest.Mock).mockResolvedValue(null);

      const result =
        await transactionService.getTransactionWithContacts("non-existent");

      expect(result).toBeNull();
      expect(databaseService.getTransactionContactsWithRoles).not.toHaveBeenCalled();
    });
  });

  describe("assignContactToTransaction", () => {
    it("should assign contact with all role details", async () => {
      const mockAssignment = { id: "assignment-1", contact_id: mockContactId };
      (
        databaseService.assignContactToTransaction as jest.Mock
      ).mockResolvedValue(mockAssignment);

      const result = await transactionService.assignContactToTransaction(
        mockTransactionId,
        mockContactId,
        "buyer",
        "client",
        true,
        "Primary buyer",
      );

      expect(databaseService.assignContactToTransaction).toHaveBeenCalledWith(
        mockTransactionId,
        {
          contact_id: mockContactId,
          role: "buyer",
          role_category: "client",
          specific_role: "buyer",
          is_primary: 1,
          notes: "Primary buyer",
        },
      );
      // TASK-1031: Now returns AssignContactResult with success and autoLink
      expect(result.success).toBe(true);
      expect(result.autoLink).toBeDefined();
    });

    it("should handle null notes", async () => {
      (
        databaseService.assignContactToTransaction as jest.Mock
      ).mockResolvedValue({});

      const result = await transactionService.assignContactToTransaction(
        mockTransactionId,
        mockContactId,
        "seller",
        "client",
        false,
        null,
      );

      expect(databaseService.assignContactToTransaction).toHaveBeenCalledWith(
        mockTransactionId,
        expect.objectContaining({
          notes: undefined,
        }),
      );
      // TASK-1031: Result should still indicate success
      expect(result.success).toBe(true);
    });

    it("should skip auto-link when skipAutoLink is true", async () => {
      (
        databaseService.assignContactToTransaction as jest.Mock
      ).mockResolvedValue({});

      const result = await transactionService.assignContactToTransaction(
        mockTransactionId,
        mockContactId,
        "seller",
        "client",
        false,
        null,
        true, // skipAutoLink = true
      );

      expect(result.success).toBe(true);
      expect(result.autoLink).toBeUndefined();
    });
  });

  describe("reanalyzeProperty", () => {
    const mockEmails = [
      {
        subject: "RE: 123 Main St",
        from: "agent@realty.com",
        date: "2024-01-15",
      },
    ];

    const mockAnalyzed = [
      {
        subject: "RE: 123 Main St",
        from: "agent@realty.com",
        date: "2024-01-15",
        isRealEstateRelated: true,
      },
    ];

    it("should reanalyze property with Gmail provider", async () => {
      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzed,
      );

      const result = await transactionService.reanalyzeProperty(
        mockUserId,
        "google",
        "123 Main St",
        { start: new Date("2024-01-01"), end: new Date("2024-02-01") },
      );

      expect(result.emailsFound).toBe(1);
      expect(result.realEstateEmailsFound).toBe(1);
      expect(result.analyzed).toEqual(mockAnalyzed);
    });

    it("should reanalyze property with Outlook provider", async () => {
      (outlookFetchService.initialize as jest.Mock).mockResolvedValue(
        undefined,
      );
      (outlookFetchService.searchEmails as jest.Mock).mockResolvedValue(
        mockEmails,
      );
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        mockAnalyzed,
      );

      const result = await transactionService.reanalyzeProperty(
        mockUserId,
        "microsoft",
        "456 Oak Ave",
      );

      expect(outlookFetchService.searchEmails).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "456 Oak Ave",
        }),
      );
      expect(result.emailsFound).toBe(1);
    });

    it("should use default date range when not provided", async () => {
      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue([]);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(
        [],
      );

      await transactionService.reanalyzeProperty(
        mockUserId,
        "google",
        "123 Main St",
        {},
      );

      expect(gmailFetchService.searchEmails).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.any(Date),
          before: expect.any(Date),
        }),
      );
    });
  });

  describe("createAuditedTransaction with contacts", () => {
    it("should create transaction and assign multiple contacts", async () => {
      const auditedData = {
        property_address: "789 Pine Rd, Oakland, CA 94612",
        property_street: "789 Pine Rd",
        property_city: "Oakland",
        property_state: "CA",
        property_zip: "94612",
        transaction_type: "sale" as const,
        contact_assignments: [
          {
            contact_id: "contact-1",
            role: "seller",
            role_category: "client",
            is_primary: true,
          },
          {
            contact_id: "contact-2",
            role: "buyer_agent",
            role_category: "agent",
            is_primary: false,
          },
        ],
      };

      const mockCreatedTransaction = { ...mockTransaction, id: "new-txn-id" };

      (databaseService.createTransactionWithContactsSync as jest.Mock).mockReturnValue(
        mockCreatedTransaction,
      );
      (
        databaseService.assignContactToTransaction as jest.Mock
      ).mockReturnValue({});
      (databaseService.getTransactionById as jest.Mock).mockReturnValue(
        mockCreatedTransaction,
      );
      (databaseService.getTransactionContactsWithRoles as jest.Mock).mockReturnValue(
        auditedData.contact_assignments,
      );

      const result = await transactionService.createAuditedTransaction(
        mockUserId,
        auditedData,
      );

      // BACKLOG-2538: the deal and its parties are now written by ONE call, so
      // the assertion moves up to that call — and gets stronger for it. It no
      // longer says "two assignments happened at some point"; it says the deal
      // and both parties were handed to the same atomic write, in order.
      expect(
        databaseService.createTransactionWithContactsSync,
      ).toHaveBeenCalledTimes(1);
      expect(
        databaseService.createTransactionWithContactsSync,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: mockUserId }),
        [
          expect.objectContaining({ contact_id: "contact-1", role: "seller" }),
          expect.objectContaining({
            contact_id: "contact-2",
            role: "buyer_agent",
          }),
        ],
      );
      // createAuditedTransaction is DECLARED `Promise<Transaction | null>` but
      // actually returns getTransactionWithContacts()'s TransactionWithDetails,
      // which is where contact_assignments lives. Narrowing here, not changing
      // the assertion.
      expect((result as TransactionWithDetails | null)?.contact_assignments).toHaveLength(2);
    });

    it("should handle transaction with property coordinates", async () => {
      const auditedData = {
        property_address: "123 Verified St",
        property_coordinates: "37.7749,-122.4194",
        contact_assignments: [],
      };

      const mockCreatedTransaction = { ...mockTransaction, id: "verified-txn" };

      (databaseService.createTransactionWithContactsSync as jest.Mock).mockReturnValue(
        mockCreatedTransaction,
      );
      (databaseService.getTransactionById as jest.Mock).mockReturnValue(
        mockCreatedTransaction,
      );
      (databaseService.getTransactionContactsWithRoles as jest.Mock).mockReturnValue(
        [],
      );

      await transactionService.createAuditedTransaction(
        mockUserId,
        auditedData,
      );

      expect(databaseService.createTransactionWithContactsSync).toHaveBeenCalledWith(
        expect.objectContaining({
          property_coordinates: "37.7749,-122.4194",
          closing_date_verified: true, // Should be true when coordinates present
        }),
      
        [],
      );
    });
  });

  describe("Address Parsing", () => {
    it("should parse full address correctly in createManualTransaction", async () => {
      // We can indirectly test address parsing through the transaction creation
      const transactionData: Partial<NewTransaction> = {
        property_address: "123 Main St, San Francisco, CA 94102",
        property_street: "123 Main St",
        property_city: "San Francisco",
        property_state: "CA",
        property_zip: "94102",
      };

      (databaseService.createTransaction as jest.Mock).mockResolvedValue({
        ...mockTransaction,
        ...transactionData,
      });

      await transactionService.createManualTransaction(
        mockUserId,
        transactionData,
      );

      expect(databaseService.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          property_street: "123 Main St",
          property_city: "San Francisco",
          property_state: "CA",
          property_zip: "94102",
        }),
      );
    });
  });

  // TASK-964: Duplicate Transaction Prevention Tests
  describe("Duplicate Transaction Prevention (TASK-964)", () => {
    const mockEmails = [
      {
        subject: "RE: 123 Main St Offer",
        from: "agent@realty.com",
        date: "2024-01-15",
        to: "client@email.com",
      },
    ];

    const mockAnalyzedEmails = [
      {
        subject: "RE: 123 Main St Offer",
        from: "agent@realty.com",
        date: "2024-01-15",
        isRealEstateRelated: true,
        keywords: "offer, closing",
        confidence: 85,
      },
    ];

    beforeEach(() => {
      // Reset mocks for each test
      (databaseService.findExistingTransactionsByAddresses as jest.Mock)?.mockReset();
    });

    it("should skip importing duplicate transactions", async () => {
      const mockGrouped = {
        "123 Main St, City, ST 12345": mockAnalyzedEmails,
      };

      const mockSummary = {
        propertyAddress: "123 Main St, City, ST 12345",
        transactionType: "purchase",
        closingDate: "2024-02-15",
        communicationsCount: 1,
        confidence: 85,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(mockEmails);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(mockAnalyzedEmails);
      (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue(mockGrouped);
      (transactionExtractorService.generateTransactionSummary as jest.Mock).mockReturnValue(mockSummary);
      (logService.info as jest.Mock).mockResolvedValue(undefined);
      (logService.debug as jest.Mock).mockResolvedValue(undefined);

      // Simulate existing transaction for this address
      const existingTxMap = new Map<string, string>();
      existingTxMap.set("123 main st, city, st 12345", "existing-tx-id");
      (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(existingTxMap);

      const result = await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
      });

      // Should NOT create a new transaction
      expect(databaseService.createTransaction).not.toHaveBeenCalled();
      expect(result.transactionsFound).toBe(0);

      // Should log the duplicate skip
      expect(logService.debug).toHaveBeenCalledWith(
        "Skipping duplicate transaction import",
        "TransactionService._saveDetectedTransactions",
        expect.objectContaining({
          propertyAddress: "123 Main St, City, ST 12345",
          existingTransactionId: "existing-tx-id",
        }),
      );
    });

    it("should create new transactions that do not exist", async () => {
      const mockGrouped = {
        "456 Oak Ave, City, ST 12345": mockAnalyzedEmails,
      };

      const mockSummary = {
        propertyAddress: "456 Oak Ave, City, ST 12345",
        transactionType: "sale",
        closingDate: "2024-03-01",
        communicationsCount: 1,
        confidence: 90,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(mockEmails);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(mockAnalyzedEmails);
      (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue(mockGrouped);
      (transactionExtractorService.generateTransactionSummary as jest.Mock).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({ id: "new-tx-id" });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);

      // No existing transactions
      (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(new Map());

      const result = await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
      });

      // Should create the new transaction
      expect(databaseService.createTransaction).toHaveBeenCalledTimes(1);
      expect(result.transactionsFound).toBe(1);
    });

    it("should handle batch import with mix of new and duplicate transactions", async () => {
      const mixedGrouped = {
        "123 Main St, City, ST 12345": mockAnalyzedEmails, // Duplicate
        "789 Pine Rd, City, ST 12345": mockAnalyzedEmails, // New
      };

      const mockSummary = {
        propertyAddress: "123 Main St, City, ST 12345",
        transactionType: "purchase",
        closingDate: "2024-02-15",
        communicationsCount: 1,
        confidence: 85,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      const mockSummary2 = {
        propertyAddress: "789 Pine Rd, City, ST 12345",
        transactionType: "sale",
        closingDate: "2024-03-01",
        communicationsCount: 1,
        confidence: 90,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(mockEmails);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(mockAnalyzedEmails);
      (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue(mixedGrouped);
      (transactionExtractorService.generateTransactionSummary as jest.Mock)
        .mockReturnValueOnce(mockSummary)
        .mockReturnValueOnce(mockSummary2);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({ id: "new-tx-id" });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);
      (logService.debug as jest.Mock).mockResolvedValue(undefined);

      // One existing transaction (123 Main St is duplicate)
      const existingTxMap = new Map<string, string>();
      existingTxMap.set("123 main st, city, st 12345", "existing-tx-id");
      (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(existingTxMap);

      const result = await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
      });

      // Should only create 1 transaction (789 Pine Rd)
      expect(databaseService.createTransaction).toHaveBeenCalledTimes(1);
      expect(result.transactionsFound).toBe(1);

      // Should log the duplicate skip
      expect(logService.debug).toHaveBeenCalledWith(
        "Skipping duplicate transaction import",
        "TransactionService._saveDetectedTransactions",
        expect.objectContaining({
          existingTransactionId: "existing-tx-id",
        }),
      );

      // Should log the import summary
      expect(logService.info).toHaveBeenCalledWith(
        "Transaction import completed",
        "TransactionService._saveDetectedTransactions",
        expect.objectContaining({
          totalDetected: 2,
          created: 1,
          skippedDuplicates: 1,
        }),
      );
    });

    it("should handle case-insensitive address matching for deduplication", async () => {
      const mockGrouped = {
        "123 MAIN ST, CITY, ST 12345": mockAnalyzedEmails, // Uppercase
      };

      const mockSummary = {
        propertyAddress: "123 MAIN ST, CITY, ST 12345",
        transactionType: "purchase",
        closingDate: "2024-02-15",
        communicationsCount: 1,
        confidence: 85,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(mockEmails);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(mockAnalyzedEmails);
      (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue(mockGrouped);
      (transactionExtractorService.generateTransactionSummary as jest.Mock).mockReturnValue(mockSummary);
      (logService.info as jest.Mock).mockResolvedValue(undefined);
      (logService.debug as jest.Mock).mockResolvedValue(undefined);

      // Existing transaction with lowercase address
      const existingTxMap = new Map<string, string>();
      existingTxMap.set("123 main st, city, st 12345", "existing-tx-id");
      (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(existingTxMap);

      const result = await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
      });

      // Should skip due to case-insensitive match
      expect(databaseService.createTransaction).not.toHaveBeenCalled();
      expect(result.transactionsFound).toBe(0);
    });

    it("should use batch lookup for efficiency (no N+1 queries)", async () => {
      const multipleGrouped = {
        "123 Main St, City, ST 12345": mockAnalyzedEmails,
        "456 Oak Ave, City, ST 12345": mockAnalyzedEmails,
        "789 Pine Rd, City, ST 12345": mockAnalyzedEmails,
      };

      const mockSummary = {
        propertyAddress: "123 Main St, City, ST 12345",
        transactionType: "purchase",
        closingDate: "2024-02-15",
        communicationsCount: 1,
        confidence: 85,
        firstCommunication: "2024-01-15",
        lastCommunication: "2024-01-15",
      };

      (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
      (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue(mockEmails);
      (transactionExtractorService.batchAnalyze as jest.Mock).mockReturnValue(mockAnalyzedEmails);
      (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue(multipleGrouped);
      (transactionExtractorService.generateTransactionSummary as jest.Mock).mockReturnValue(mockSummary);
      (databaseService.createTransaction as jest.Mock).mockResolvedValue({ id: "new-tx-id" });
      (databaseService.createCommunication as jest.Mock).mockResolvedValue({});
      (logService.info as jest.Mock).mockResolvedValue(undefined);
      (databaseService.findExistingTransactionsByAddresses as jest.Mock).mockResolvedValue(new Map());

      await transactionService.scanAndExtractTransactions(mockUserId, {
        provider: "google",
      });

      // Should only call findExistingTransactionsByAddresses ONCE (batch lookup)
      expect(databaseService.findExistingTransactionsByAddresses).toHaveBeenCalledTimes(1);
      // Should be called with all 3 addresses
      expect(databaseService.findExistingTransactionsByAddresses).toHaveBeenCalledWith(
        mockUserId,
        expect.arrayContaining([
          "123 Main St, City, ST 12345",
          "456 Oak Ave, City, ST 12345",
          "789 Pine Rd, City, ST 12345",
        ]),
      );
    });
  });
});
