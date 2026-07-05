/**
 * Tests for Auto-Link Service
 * TASK-1031: Auto-link communications when contact is added to transaction
 */

import {
  autoLinkCommunicationsForContact,
  autoLinkNewMessagesForUser,
  autoLinkNewMessagesForUserDebounced,
} from "../autoLinkService";

// Mock dependencies
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

jest.mock("../logService", () => {
  const mockLogFn = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: {
      info: mockLogFn,
      warn: mockLogFn,
      error: mockLogFn,
      debug: mockLogFn,
    },
  };
});

const mockCreateThreadCommunicationReference = jest.fn();
const mockIsThreadLinkedToTransaction = jest.fn();

jest.mock("../messageMatchingService", () => ({
  normalizePhone: jest.fn((phone) => {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }),
}));

// BACKLOG-502: Mock the thread-based linking functions from communicationDbService
// BACKLOG-1560: Added ignored email/thread ID lookups for suppression
jest.mock("../db/communicationDbService", () => ({
  createThreadCommunicationReference: (...args: unknown[]) => mockCreateThreadCommunicationReference(...args),
  isThreadLinkedToTransaction: (...args: unknown[]) => mockIsThreadLinkedToTransaction(...args),
  getIgnoredEmailIdsForTransaction: jest.fn().mockReturnValue(new Set()),
  getIgnoredThreadIdsForTransaction: jest.fn().mockReturnValue(new Set()),
  getIgnoredCommunicationIdsForTransaction: jest.fn().mockReturnValue(new Set()),
}));

// Note: isContactSourceEnabled was removed from autoLinkService.
// Auto-linking messages is always enabled for known contacts.
// The "inferred messages" preference only gates contact *discovery*.

describe("autoLinkService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // BACKLOG-502: Default behavior for thread linking mocks
    mockCreateThreadCommunicationReference.mockResolvedValue("comm-ref-id");
    mockIsThreadLinkedToTransaction.mockResolvedValue(false);
    // Note: isContactSourceEnabled was removed from autoLinkService
  });

  describe("autoLinkCommunicationsForContact", () => {
    const mockContactId = "contact-123";
    const mockTransactionId = "txn-456";
    const mockUserId = "user-789";

    // Helper to set up standard mocks
    // Note: Since TASK-1037 fix, emails are queried from 'communications' table
    // and text messages from 'messages' table
    const setupMocks = (options: {
      contactExists?: boolean;
      emails?: string[];
      phones?: string[];
      transactionExists?: boolean;
      foundEmailIds?: string[];
      foundMessageIds?: string[];
      emailAlreadyLinked?: Set<string>;
    }) => {
      const {
        contactExists = true,
        emails = [],
        phones = [],
        transactionExists = true,
        foundEmailIds = [],
        foundMessageIds = [],
        emailAlreadyLinked = new Set<string>(),
      } = options;

      mockDbGet.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("FROM contacts")) {
          return contactExists ? { id: mockContactId } : null;
        }
        if (sql.includes("FROM transactions")) {
          return transactionExists
            ? {
                user_id: mockUserId,
                started_at: "2024-01-01T00:00:00Z",
                created_at: "2024-01-01T00:00:00Z",
                closed_at: null,
                property_address: null,
                property_street: null,
              }
            : null;
        }
        // For linkEmailToTransaction - check if already linked via communications
        if (sql.includes("FROM communications") && sql.includes("email_id")) {
          const emailId = params?.[0] as string;
          if (emailAlreadyLinked.has(emailId)) {
            return { id: "existing-comm", transaction_id: mockTransactionId };
          }
          return null;
        }
        // For linkEmailToTransaction - get email's user_id and thread_id
        // BACKLOG-1718 (R3): thread_id is now fetched so it can be stored in
        // the communications row for proper thread-expansion on unlink.
        if (sql.includes("FROM emails WHERE id")) {
          return { user_id: mockUserId, thread_id: "thread-test-1" };
        }
        // For user email lookup (TEST-051-007 fix)
        if (sql.includes("FROM users_local")) {
          return { email: "user@example.com" };
        }
        return null;
      });

      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM contact_emails")) {
          return emails.map((email) => ({ email }));
        }
        if (sql.includes("FROM contact_phones")) {
          return phones.map((phone) => ({ phone_e164: phone }));
        }
        // BACKLOG-506: Emails are now queried from emails table
        if (sql.includes("FROM email_participants ep")) {
          return foundEmailIds.map((id) => ({ id }));
        }
        // Text messages from messages table (BACKLOG-502: includes thread_id for thread-level linking)
        if (sql.includes("FROM messages") && sql.includes("sms")) {
          return foundMessageIds.map((id, idx) => ({ id, thread_id: `thread-${idx + 1}` }));
        }
        return [];
      });
    };

    it("should return zeros when contact is not found", async () => {
      setupMocks({ contactExists: false });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result).toEqual({
        emailsLinked: 0,
        messagesLinked: 0,
        alreadyLinked: 0,
        errors: 0,
      });
    });

    it("should return zeros when contact has no email or phone", async () => {
      setupMocks({
        contactExists: true,
        emails: [],
        phones: [],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result).toEqual({
        emailsLinked: 0,
        messagesLinked: 0,
        alreadyLinked: 0,
        errors: 0,
      });
    });

    it("should return zeros when transaction is not found", async () => {
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: [],
        transactionExists: false,
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result).toEqual({
        emailsLinked: 0,
        messagesLinked: 0,
        alreadyLinked: 0,
        errors: 0,
      });
    });

    it("should link emails matching contact email addresses", async () => {
      // With the TASK-1037 fix, emails come from the communications table
      // and are linked using UPDATE (dbRun) instead of createCommunicationReference
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: [],
        transactionExists: true,
        foundEmailIds: ["email-1", "email-2"],
        foundMessageIds: [],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result.emailsLinked).toBe(2);
      expect(result.messagesLinked).toBe(0);
      // Emails use linkExistingCommunication (dbRun for UPDATE)
      expect(mockDbRun).toHaveBeenCalledTimes(2);
      // createCommunicationReference is NOT used for emails anymore
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledTimes(0);
    });

    it("should link text messages matching contact phone numbers", async () => {
      setupMocks({
        contactExists: true,
        emails: [],
        phones: ["+14155551234"],
        transactionExists: true,
        foundEmailIds: [],
        foundMessageIds: ["msg-1", "msg-2", "msg-3"],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result.emailsLinked).toBe(0);
      // BACKLOG-502: Each message has a unique thread_id (thread-1, thread-2, thread-3),
      // so 3 threads are linked
      expect(result.messagesLinked).toBe(3);
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledTimes(3);
    });

    it("should count already-linked communications", async () => {
      // email-2 is already linked to this transaction
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: [],
        transactionExists: true,
        foundEmailIds: ["email-1", "email-2"],
        foundMessageIds: [],
        emailAlreadyLinked: new Set(["email-2"]),
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result.emailsLinked).toBe(1);
      expect(result.alreadyLinked).toBe(1);
      // Only one dbRun call because email-2 is already linked
      expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it("should count errors during linking", async () => {
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: [],
        transactionExists: true,
        foundEmailIds: ["email-1", "email-2"],
        foundMessageIds: [],
      });

      // First succeeds, second fails
      mockDbRun
        .mockImplementationOnce(() => {}) // First email succeeds
        .mockImplementationOnce(() => {
          throw new Error("Database error");
        });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result.emailsLinked).toBe(1);
      expect(result.errors).toBe(1);
    });

    it("should link both emails and messages for a contact with both", async () => {
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: ["+14155551234"],
        transactionExists: true,
        foundEmailIds: ["email-1"],
        foundMessageIds: ["msg-1", "msg-2"],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      expect(result.emailsLinked).toBe(1);
      // BACKLOG-502: Each message has unique thread_id (thread-1, thread-2), so 2 threads linked
      expect(result.messagesLinked).toBe(2);
      // Emails use dbRun (1 call for UPDATE), messages use createThreadCommunicationReference (2 calls)
      expect(mockDbRun).toHaveBeenCalledTimes(1);
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledTimes(2);
    });

    it("should create communication record with correct transaction_id for emails", async () => {
      setupMocks({
        contactExists: true,
        emails: ["john@example.com"],
        phones: [],
        transactionExists: true,
        foundEmailIds: ["email-1"],
        foundMessageIds: [],
      });

      await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // Verify dbRun was called to INSERT a communication linking email to transaction.
      // BACKLOG-1718 (R3): thread_id must now be present in the params so that
      // unlinkCommunication can expand the deletion to the full thread.
      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO communications"),
        expect.arrayContaining([
          mockTransactionId,
          "email-1",
          "thread-test-1", // thread_id sourced from emails row
          "auto",
          0.85, // Email confidence
        ])
      );
    });

    it("should use higher confidence for phone matches than email matches", async () => {
      setupMocks({
        contactExists: true,
        emails: [],
        phones: ["+14155551234"],
        transactionExists: true,
        foundEmailIds: [],
        foundMessageIds: ["msg-1"],
      });

      await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // BACKLOG-502: Verify thread-based linking with phone match confidence (0.9 vs 0.85 for email)
      // First param is thread_id (from our mock: "thread-1"), not message_id
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledWith(
        "thread-1",  // thread_id from the mock
        mockTransactionId,
        mockUserId,
        "auto",
        0.9 // Phone confidence
      );
    });

    it("should NOT link emails when contact's only email is the user's own email (TEST-051-007)", async () => {
      // TEST-051-007: User's email should never be treated as a contact
      // Mock returns user@example.com as the user's email
      setupMocks({
        contactExists: true,
        emails: ["user@example.com"], // Contact's email is the user's own email
        phones: [],
        transactionExists: true,
        foundEmailIds: [], // No emails should be found since we filter out user's email
        foundMessageIds: [],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // Should not link any emails because contact's email is the user's email
      expect(result.emailsLinked).toBe(0);
      expect(result.messagesLinked).toBe(0);
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it("should only link emails for actual contacts, not user's email (TEST-051-007)", async () => {
      // TEST-051-007: Contact has multiple emails, one is user's email
      setupMocks({
        contactExists: true,
        emails: ["user@example.com", "contact@example.com"], // Mix of user and contact emails
        phones: [],
        transactionExists: true,
        foundEmailIds: ["email-1"], // Should only find emails for contact@example.com
        foundMessageIds: [],
      });

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // Should link emails only for contact@example.com, not user@example.com
      expect(result.emailsLinked).toBe(1);

      // BACKLOG-1722: After the junction migration, parameters are exact
      // lowercased email addresses (not LIKE patterns).
      const dbAllCalls = mockDbAll.mock.calls;
      const emailQueryCall = dbAllCalls.find(call =>
        call[0] && typeof call[0] === 'string' && call[0].includes("FROM email_participants ep")
      );

      if (emailQueryCall) {
        const params = emailQueryCall[1] as unknown[];
        // Should have contact@example.com (exact) only — never the user's email
        expect(params).toContain("contact@example.com");
        expect(params).not.toContain("user@example.com");
        // No LIKE patterns either — we now use indexed exact match
        expect(params).not.toContain("%contact@example.com%");
        expect(params).not.toContain("%user@example.com%");
      }
    });

    // TASK-2087: Address-based filtering tests
    describe("address-based filtering", () => {
      it("should pass separate address parts to email query when transaction has property_address", async () => {
        // Set up mocks with a property address on the transaction
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "123 Oak Street, Portland, OR 97201",
              property_street: null,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) return [{ id: "email-1" }];
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(1);

        // Verify the email query included separate address filter params (%123% and %oak%)
        const emailQueryCalls = mockDbAll.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].includes("FROM email_participants ep")
        );
        expect(emailQueryCalls.length).toBeGreaterThanOrEqual(1);
        // The first call should include address filter with separate parts
        const firstCallParams = emailQueryCalls[0][1] as string[];
        expect(firstCallParams).toContain("%123%");
        expect(firstCallParams).toContain("%oak%");
      });

      it("should return 0 results when address filter matches nothing (no silent fallback - BACKLOG-1364)", async () => {
        // BACKLOG-1364: No more silent fallback — when address filter returns 0, return 0
        let emailCallCount = 0;
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "123 Oak Street, Portland, OR 97201",
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            emailCallCount++;
            // Address filter returns no results
            return [];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // BACKLOG-1364: No fallback — 0 results when address filter finds nothing
        expect(result.emailsLinked).toBe(0);
        // Email query called once (no fallback retry)
        expect(emailCallCount).toBe(1);
      });

      it("should skip address filter when transaction has no property_address", async () => {
        // No property_address or property_street
        setupMocks({
          contactExists: true,
          emails: ["john@example.com"],
          phones: [],
          transactionExists: true,
          foundEmailIds: ["email-1"],
          foundMessageIds: [],
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(1);

        // Verify the email query did NOT include address filter params
        const emailQueryCalls = mockDbAll.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].includes("FROM email_participants ep")
        );
        expect(emailQueryCalls.length).toBe(1);
        // Query should only be called once (no fallback needed)
        const callParams = emailQueryCalls[0][1] as string[];
        expect(callParams).not.toContain("%123%");
        expect(callParams).not.toContain("%oak%");
      });

      it("should use property_street as fallback when property_address is null", async () => {
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: null,
              property_street: "456 Elm Drive",
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) return [{ id: "email-1" }];
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(1);

        // Verify the query used the normalized property_street parts ("456" and "elm")
        const emailQueryCalls = mockDbAll.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].includes("FROM email_participants ep")
        );
        const firstCallParams = emailQueryCalls[0][1] as string[];
        expect(firstCallParams).toContain("%456%");
        expect(firstCallParams).toContain("%elm%");
      });

      it("should NOT fall back when matching emails are already linked (BACKLOG-1364)", async () => {
        // BACKLOG-1364: No fallback behavior — address filter ON, 0 unlinked results = 0 linked
        let findEmailCallCount = 0;

        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "456 Maple Drive, Portland, OR",
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "bob@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            findEmailCallCount++;
            // Address filter returns 0 unlinked results (all emails already linked)
            return [];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // Should NOT have linked anything (all matching emails are already linked)
        expect(result.emailsLinked).toBe(0);
        // BACKLOG-1364: findEmailsByContactEmails called once (no fallback)
        expect(findEmailCallCount).toBe(1);
        // No dbRun calls (no emails to link)
        expect(mockDbRun).not.toHaveBeenCalled();
      });

      it("should NOT apply address filter to text messages", async () => {
        // Transaction has an address, but text messages should not be filtered by it
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "123 Oak Street, Portland, OR 97201",
              property_street: null,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [];
          if (sql.includes("FROM contact_phones")) return [{ phone_e164: "+14155551234" }];
          if (sql.includes("FROM messages") && sql.includes("sms")) {
            return [
              { id: "msg-1", thread_id: "thread-1" },
              { id: "msg-2", thread_id: "thread-2" },
            ];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // All messages should be linked (no address filtering)
        expect(result.messagesLinked).toBe(2);

        // Verify the messages query did NOT include address-related columns
        const msgQueryCalls = mockDbAll.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].includes("FROM messages")
        );
        for (const call of msgQueryCalls) {
          const sql = call[0] as string;
          // Should not reference body or body_text columns (address filtering columns)
          expect(sql).not.toContain("body");
          expect(sql).not.toContain("body_text");
          // The SQL should only have LIKE for participants_flat (phone matching),
          // not for address content filtering
          expect(sql).not.toContain("subject");
        }
      });
    });
  });

  // BACKLOG-1546: Tests for autoLinkNewMessagesForUser
  describe("autoLinkNewMessagesForUser", () => {
    const mockUserId = "user-789";

    beforeEach(() => {
      jest.clearAllMocks();
      mockCreateThreadCommunicationReference.mockResolvedValue("comm-ref-id");
      mockIsThreadLinkedToTransaction.mockResolvedValue(false);
    });

    it("should return zeros when no contact-transaction pairs exist", async () => {
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("transaction_contacts")) {
          return []; // No contact-transaction pairs
        }
        return [];
      });

      const result = await autoLinkNewMessagesForUser(mockUserId);

      expect(result.pairsProcessed).toBe(0);
      expect(result.totalEmailsLinked).toBe(0);
      expect(result.totalMessagesLinked).toBe(0);
      expect(result.totalAlreadyLinked).toBe(0);
      expect(result.totalErrors).toBe(0);
    });

    it("should process all contact-transaction pairs", async () => {
      // First call returns contact-transaction pairs, subsequent calls return contact/transaction data
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("transaction_contacts") && sql.includes("DISTINCT")) {
          return [
            { contact_id: "c1", transaction_id: "t1" },
            { contact_id: "c2", transaction_id: "t1" },
          ];
        }
        if (sql.includes("FROM contact_emails")) {
          return []; // No emails
        }
        if (sql.includes("FROM contact_phones")) {
          return []; // No phones
        }
        return [];
      });

      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM contacts")) {
          return { id: "c1" };
        }
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) {
          return { email: "user@example.com" };
        }
        return null;
      });

      const result = await autoLinkNewMessagesForUser(mockUserId);

      expect(result.pairsProcessed).toBe(2);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should accumulate results across multiple pairs", async () => {
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("transaction_contacts") && sql.includes("DISTINCT")) {
          return [
            { contact_id: "c1", transaction_id: "t1" },
          ];
        }
        if (sql.includes("FROM contact_emails")) {
          return [{ email: "john@example.com" }];
        }
        if (sql.includes("FROM contact_phones")) {
          return [];
        }
        if (sql.includes("FROM email_participants ep")) {
          return [{ id: "email-1" }, { id: "email-2" }];
        }
        return [];
      });

      mockDbGet.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("FROM contacts")) return { id: "c1" };
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) return { email: "user@example.com" };
        if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
        if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
        return null;
      });

      const result = await autoLinkNewMessagesForUser(mockUserId);

      expect(result.pairsProcessed).toBe(1);
      expect(result.totalEmailsLinked).toBe(2);
    });

    it("should handle errors for individual pairs without stopping", async () => {
      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("transaction_contacts") && sql.includes("DISTINCT")) {
          return [
            { contact_id: "c1", transaction_id: "t1" },
            { contact_id: "c2", transaction_id: "t2" },
          ];
        }
        if (sql.includes("FROM contact_emails")) return [];
        if (sql.includes("FROM contact_phones")) return [];
        return [];
      });

      let contactCallCount = 0;
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM contacts")) {
          contactCallCount++;
          // Both contacts exist but have no emails/phones, so they complete without linking
          return { id: contactCallCount === 1 ? "c1" : "c2" };
        }
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) return { email: "user@example.com" };
        return null;
      });

      const result = await autoLinkNewMessagesForUser(mockUserId);

      // Both pairs processed (contacts have no emails/phones so 0 linked but no errors)
      expect(result.pairsProcessed).toBe(2);
      expect(result.totalErrors).toBe(0);
      expect(result.totalEmailsLinked).toBe(0);
      expect(result.totalMessagesLinked).toBe(0);
    });
  });

  // BACKLOG-1560: Tests for auto-link suppression of previously unlinked conversations
  describe("suppression of unlinked conversations (BACKLOG-1560)", () => {
    const mockContactId = "contact-123";
    const mockTransactionId = "txn-456";
    const mockUserId = "user-789";

    const {
      getIgnoredEmailIdsForTransaction,
      getIgnoredThreadIdsForTransaction,
    } = jest.requireMock("../db/communicationDbService") as {
      getIgnoredEmailIdsForTransaction: jest.Mock;
      getIgnoredThreadIdsForTransaction: jest.Mock;
    };

    it("should suppress emails that were previously unlinked by user", async () => {
      // Set up mocks for contact with emails
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM contacts")) return { id: mockContactId };
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) return { email: "user@example.com" };
        if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
        if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
        return null;
      });

      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
        if (sql.includes("FROM contact_phones")) return [];
        // Return 3 emails, one of which will be suppressed
        if (sql.includes("FROM email_participants ep")) return [
          { id: "email-1" },
          { id: "email-2" },
          { id: "email-3" },
        ];
        return [];
      });

      // Simulate email-2 being previously unlinked
      getIgnoredEmailIdsForTransaction.mockReturnValue(new Set(["email-2"]));
      getIgnoredThreadIdsForTransaction.mockReturnValue(new Set());

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // email-1 and email-3 should be linked, email-2 should be suppressed
      expect(result.emailsLinked).toBe(2);
      expect(result.errors).toBe(0);

      // Verify dbRun was called for email-1 and email-3 but NOT email-2
      const insertCalls = mockDbRun.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO communications")
      );
      expect(insertCalls.length).toBe(2);

      // Verify the suppressed email was not in any insert
      const allInsertParams = insertCalls.flatMap((call) => call[1] || []);
      expect(allInsertParams).not.toContain("email-2");
    });

    it("should suppress message threads that were previously unlinked by user", async () => {
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM contacts")) return { id: mockContactId };
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) return { email: "user@example.com" };
        return null;
      });

      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM contact_emails")) return [];
        if (sql.includes("FROM contact_phones")) return [{ phone_e164: "+14155550000" }];
        // Return 2 message threads
        if (sql.includes("FROM messages") && sql.includes("sms")) return [
          { id: "msg-1", thread_id: "thread-A" },
          { id: "msg-2", thread_id: "thread-B" },
        ];
        return [];
      });

      // Simulate thread-A being previously unlinked
      getIgnoredEmailIdsForTransaction.mockReturnValue(new Set());
      getIgnoredThreadIdsForTransaction.mockReturnValue(new Set(["thread-A"]));

      mockIsThreadLinkedToTransaction.mockResolvedValue(false);

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // Only thread-B should be linked, thread-A should be suppressed
      expect(result.messagesLinked).toBe(1);
      expect(result.errors).toBe(0);

      // Verify createThreadCommunicationReference was called only for thread-B
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledTimes(1);
      expect(mockCreateThreadCommunicationReference).toHaveBeenCalledWith(
        "thread-B",
        mockTransactionId,
        mockUserId,
        "auto",
        0.9
      );
    });

    it("should not suppress anything when there are no ignored records", async () => {
      mockDbGet.mockImplementation((sql: string) => {
        if (sql.includes("FROM contacts")) return { id: mockContactId };
        if (sql.includes("FROM transactions")) {
          return {
            user_id: mockUserId,
            started_at: "2024-01-01T00:00:00Z",
            created_at: "2024-01-01T00:00:00Z",
            closed_at: null,
            property_address: null,
            property_street: null,
            skip_address_filter: 0,
          };
        }
        if (sql.includes("FROM users_local")) return { email: "user@example.com" };
        if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId };
        if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
        return null;
      });

      mockDbAll.mockImplementation((sql: string) => {
        if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
        if (sql.includes("FROM contact_phones")) return [{ phone_e164: "+14155550000" }];
        if (sql.includes("FROM email_participants ep")) return [{ id: "email-1" }];
        if (sql.includes("FROM messages") && sql.includes("sms")) return [
          { id: "msg-1", thread_id: "thread-A" },
        ];
        return [];
      });

      // No ignored records
      getIgnoredEmailIdsForTransaction.mockReturnValue(new Set());
      getIgnoredThreadIdsForTransaction.mockReturnValue(new Set());

      mockIsThreadLinkedToTransaction.mockResolvedValue(false);

      const result = await autoLinkCommunicationsForContact({
        contactId: mockContactId,
        transactionId: mockTransactionId,
      });

      // Both should be linked -- nothing suppressed
      expect(result.emailsLinked).toBe(1);
      expect(result.messagesLinked).toBe(1);
    });
  });

  // BACKLOG-1546: Tests for autoLinkNewMessagesForUserDebounced
  describe("autoLinkNewMessagesForUserDebounced", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.clearAllMocks();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should debounce multiple rapid calls", () => {
      // Set up minimal mocks so the eventual call doesn't fail badly
      mockDbAll.mockReturnValue([]);

      // Call multiple times rapidly
      autoLinkNewMessagesForUserDebounced("user-1");
      autoLinkNewMessagesForUserDebounced("user-1");
      autoLinkNewMessagesForUserDebounced("user-1");

      // The first query (transaction_contacts) should not have been called yet
      const transactionContactsCalls = mockDbAll.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("transaction_contacts")
      );
      expect(transactionContactsCalls.length).toBe(0);

      // Advance timers past the debounce window
      jest.advanceTimersByTime(2100);

      // Now the query should have been made (once, not three times)
      const afterCalls = mockDbAll.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("transaction_contacts")
      );
      expect(afterCalls.length).toBe(1);
    });
  });
});
