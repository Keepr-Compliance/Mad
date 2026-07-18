/**
 * @jest-environment node
 */

/**
 * Unit tests for TransactionService
 * Tests the fixed database service method calls
 */

import transactionService from "../transactionService";
import databaseService from "../databaseService";
import logService from "../logService";
import type { Transaction, NewTransaction } from "../../types";

// Mock the dependencies
jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../logService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

// BACKLOG-2013: the freeze guard reads the marker via dbGet. Default it to
// "not exported" (null) so pre-existing behaviour (remove/unlink allowed) holds.
jest.mock("../db/core/dbConnection", () => ({
  dbGet: jest.fn(() => ({ first_exported_at: null })),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
}));

// TASK-1951: Mock preferenceHelper
const mockIsContactSourceEnabled = jest.fn();
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: (...args: unknown[]) => mockIsContactSourceEnabled(...args),
}));

describe("TransactionService - Database Method Fixes", () => {
  const mockUserId = "test-user-id";
  const mockTransactionId = "test-transaction-id";
  const mockContactId = "test-contact-id";

  const mockTransaction: Transaction = {
    id: mockTransactionId,
    user_id: mockUserId,
    property_address: "123 Test St",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getTransactions", () => {
    it("should call databaseService.getTransactions with user_id filter", async () => {
      const mockTransactions = [mockTransaction];
      (databaseService.getTransactions as jest.Mock).mockResolvedValue(
        mockTransactions,
      );

      const result = await transactionService.getTransactions(mockUserId);

      expect(databaseService.getTransactions).toHaveBeenCalledWith({
        user_id: mockUserId,
      });
      expect(result).toEqual(mockTransactions);
    });

    it("should return empty array when no transactions found", async () => {
      (databaseService.getTransactions as jest.Mock).mockResolvedValue([]);

      const result = await transactionService.getTransactions(mockUserId);

      expect(result).toEqual([]);
      expect(databaseService.getTransactions).toHaveBeenCalledTimes(1);
    });
  });

  describe("createManualTransaction", () => {
    it("should include user_id in transaction data object", async () => {
      const transactionData: Partial<NewTransaction> = {
        property_address: "123 Test St",
        transaction_type: "purchase",
        status: "active",
      };

      (databaseService.createTransaction as jest.Mock).mockResolvedValue(
        mockTransaction,
      );

      const result = await transactionService.createManualTransaction(
        mockUserId,
        transactionData,
      );

      expect(databaseService.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          property_address: "123 Test St",
          transaction_type: "purchase",
          status: "active",
        }),
      );
      expect(result).toEqual(mockTransaction);
    });

    it("should use default values when not provided", async () => {
      const transactionData: Partial<NewTransaction> = {
        property_address: "456 Oak Ave",
      };

      (databaseService.createTransaction as jest.Mock).mockResolvedValue(
        mockTransaction,
      );

      await transactionService.createManualTransaction(
        mockUserId,
        transactionData,
      );

      expect(databaseService.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          property_address: "456 Oak Ave",
          status: "active",
          closing_date_verified: false,
        }),
      );
    });
  });

  describe("getTransactionDetails", () => {
    it("should call getCommunicationsByTransaction and getTransactionContactsWithRoles", async () => {
      const mockCommunications = [{ id: "comm-1", subject: "Test" }];
      const mockContactsWithRoles = [{ id: mockContactId, contact_name: "Test Contact", specific_role: "Buyer" }];

      (databaseService.getTransactionById as jest.Mock).mockResolvedValue(
        mockTransaction,
      );
      (
        databaseService.getCommunicationsByTransaction as jest.Mock
      ).mockResolvedValue(mockCommunications);
      (databaseService.getTransactionContactsWithRoles as jest.Mock).mockResolvedValue(
        mockContactsWithRoles,
      );

      const result =
        await transactionService.getTransactionDetails(mockTransactionId);

      expect(
        databaseService.getCommunicationsByTransaction,
      ).toHaveBeenCalledWith(mockTransactionId, undefined, undefined);
      expect(
        databaseService.getTransactionContactsWithRoles,
      ).toHaveBeenCalledWith(mockTransactionId);
      expect(result).toEqual({
        ...mockTransaction,
        communications: mockCommunications,
        contact_assignments: mockContactsWithRoles,
      });
    });

    it("should return null when transaction not found", async () => {
      (databaseService.getTransactionById as jest.Mock).mockResolvedValue(null);

      const result =
        await transactionService.getTransactionDetails(mockTransactionId);

      expect(result).toBeNull();
      expect(
        databaseService.getCommunicationsByTransaction,
      ).not.toHaveBeenCalled();
    });
  });

  describe("removeContactFromTransaction", () => {
    it("should call unlinkContactFromTransaction instead of removeContactFromTransaction", async () => {
      (
        databaseService.unlinkContactFromTransaction as jest.Mock
      ).mockResolvedValue(undefined);

      await transactionService.removeContactFromTransaction(
        mockTransactionId,
        mockContactId,
      );

      expect(databaseService.unlinkContactFromTransaction).toHaveBeenCalledWith(
        mockTransactionId,
        mockContactId,
      );
    });
  });

  describe("createAuditedTransaction", () => {
    it("should include user_id in transaction data and extract id from result", async () => {
      const auditedData = {
        property_address: "789 Pine Rd",
        property_street: "789 Pine Rd",
        property_city: "San Francisco",
        property_state: "CA",
        property_zip: "94102",
        transaction_type: "purchase" as const,
        contact_assignments: [],
      };

      const mockCreatedTransaction = {
        ...mockTransaction,
        id: "new-transaction-id",
      };

      (databaseService.createTransaction as jest.Mock).mockResolvedValue(
        mockCreatedTransaction,
      );
      (databaseService.getTransactionById as jest.Mock).mockResolvedValue(
        mockCreatedTransaction,
      );
      (
        databaseService.getTransactionContactsWithRoles as jest.Mock
      ).mockResolvedValue([]);

      const result = await transactionService.createAuditedTransaction(
        mockUserId,
        auditedData,
      );

      expect(databaseService.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          property_address: "789 Pine Rd",
          status: "active",
        }),
      );
      expect(result).toBeDefined();
    });

    it("should handle errors and log them properly", async () => {
      const auditedData = {
        property_address: "789 Pine Rd",
        contact_assignments: [],
      };

      const error = new Error("Database error");
      (databaseService.createTransaction as jest.Mock).mockRejectedValue(error);

      await expect(
        transactionService.createAuditedTransaction(mockUserId, auditedData),
      ).rejects.toThrow("Database error");
    });
  });

  describe("updateTransaction", () => {
    it("should call databaseService.updateTransaction with correct parameters", async () => {
      const updates = { property_address: "999 New St" };
      (databaseService.updateTransaction as jest.Mock).mockResolvedValue(
        undefined,
      );

      await transactionService.updateTransaction(mockTransactionId, updates);

      expect(databaseService.updateTransaction).toHaveBeenCalledWith(
        mockTransactionId,
        updates,
      );
    });
  });

  describe("deleteTransaction", () => {
    it("should call databaseService.deleteTransaction", async () => {
      (databaseService.deleteTransaction as jest.Mock).mockResolvedValue(
        undefined,
      );

      await transactionService.deleteTransaction(mockTransactionId);

      expect(databaseService.deleteTransaction).toHaveBeenCalledWith(
        mockTransactionId,
      );
    });
  });

  describe("Logging", () => {
    describe("createAuditedTransaction error logging", () => {
      it("should log errors when transaction creation fails", async () => {
        const auditedData = {
          property_address: "789 Pine Rd",
          contact_assignments: [],
        };

        const error = new Error("Database error");
        (databaseService.createTransaction as jest.Mock).mockRejectedValue(
          error,
        );

        await expect(
          transactionService.createAuditedTransaction(mockUserId, auditedData),
        ).rejects.toThrow("Database error");

        expect(logService.error).toHaveBeenCalledWith(
          "Failed to create audited transaction",
          "TransactionService.createAuditedTransaction",
          expect.objectContaining({
            error: "Database error",
            userId: mockUserId,
            propertyAddress: "789 Pine Rd",
          }),
        );
      });
    });
  });
});

/**
 * TASK-1951: Tests for inferred contact preference gating
 * These test the scanAndExtractTransactions contact inference behavior
 */
describe("TransactionService - Inferred Contact Preferences (TASK-1951)", () => {
  const mockUserId = "test-user-id";

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all inferred sources OFF (the safe default)
    mockIsContactSourceEnabled.mockResolvedValue(false);
  });

  it("should call isContactSourceEnabled for all three inferred sources during scan", async () => {
    // TASK-2072: supabaseService.getPreferences no longer called (smart scan window)
    (databaseService.getOAuthToken as jest.Mock).mockResolvedValue({ access_token: "token" });
    (databaseService.getOAuthTokenSyncTime as jest.Mock).mockResolvedValue(null);

    // Mock gmail fetch
    const gmailFetchService = require("../gmailFetchService").default;
    gmailFetchService.initialize = jest.fn().mockResolvedValue(undefined);
    gmailFetchService.searchEmails = jest.fn().mockResolvedValue([]);

    // Mock strategy service
    const { ExtractionStrategyService } = require("../extraction/extractionStrategyService");
    ExtractionStrategyService.prototype.selectStrategy = jest.fn().mockResolvedValue({
      method: "pattern",
      reason: "test",
    });

    // Mock extractor
    const transactionExtractorService = require("../transactionExtractorService").default;
    transactionExtractorService.batchAnalyze = jest.fn().mockReturnValue([]);

    (databaseService.updateOAuthTokenSyncTime as jest.Mock).mockResolvedValue(undefined);

    try {
      await transactionService.scanAndExtractTransactions(mockUserId);
    } catch {
      // May fail due to incomplete mocking -- we only care about the preference calls
    }

    // Verify that isContactSourceEnabled was called for all three inferred sources
    expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
      mockUserId, "inferred", "outlookEmails", false
    );
    expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
      mockUserId, "inferred", "gmailEmails", false
    );
    expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
      mockUserId, "inferred", "messages", false
    );
  });
});
