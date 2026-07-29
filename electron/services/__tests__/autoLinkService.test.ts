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

    // TASK-2087 / BACKLOG-2311 / BACKLOG-2319: Address-based classification tests
    describe("address-based filtering", () => {
      // BACKLOG-2319: The address filter is no longer a hard gate. Candidate
      // emails are fetched (participant + date) and ALL are linked; each is
      // classified via contentContainsAddress. In the MULTI-candidate case an
      // email that names THIS transaction's address links as 'address_found'
      // (Linked); one that does not links as 'address_missing' (Needs review) —
      // it is surfaced for review, not dropped.
      it("multi-candidate: links all candidates, classifying by address content (BACKLOG-2319)", async () => {
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 2 };
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
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            // Abbreviated address in the matching email still resolves.
            return [
              { id: "email-oak", subject: "Docs for 123 Oak St closing", body_plain: "" },
              { id: "email-elm", subject: "Re: 456 Elm Drive", body_plain: "different property" },
            ];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // BACKLOG-2319: BOTH candidates link now — the address is a classifier,
        // not a gate. Assert by identity → match_reason (INSERT params: [3]=email_id,
        // [7]=match_reason).
        expect(result.emailsLinked).toBe(2);
        const reasonByEmail = new Map<string, string>();
        for (const c of mockDbRun.mock.calls) {
          if (typeof c[0] === "string" && c[0].includes("INSERT INTO communications")) {
            const p = c[1] as unknown[];
            reasonByEmail.set(p[3] as string, p[7] as string);
          }
        }
        expect(reasonByEmail.get("email-oak")).toBe("address_found");
        expect(reasonByEmail.get("email-elm")).toBe("address_missing");
      });

      it("multi-candidate near-miss: links the unmatched email as address_missing (Needs review), no fallback re-query (BACKLOG-2319)", async () => {
        // BACKLOG-1364 dropped this email; BACKLOG-2311 widened via a second
        // (fallback) query; BACKLOG-2319 links it once and tags it for review.
        let epCallCount = 0;
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 2 };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "3414 Sapp Road Southwest",
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            epCallCount++;
            return [{ id: "email-nomatch", subject: "Quick question", body_plain: "call me" }];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(1);
        // Single candidate query — the fallback re-query is retired.
        expect(epCallCount).toBe(1);
        const insert = mockDbRun.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO communications")
        );
        expect((insert?.[1] as unknown[])?.[3]).toBe("email-nomatch");
        expect((insert?.[1] as unknown[])?.[7]).toBe("address_missing");
      });

      it("single-candidate: a non-address email is now Needs review (address_missing), no single-candidate bypass (BACKLOG-2338)", async () => {
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 1 };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "3414 Sapp Road Southwest",
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            // Pure scheduling email — never mentions the street.
            return [
              { id: "email-sched", subject: "Closing time confirmation", body_plain: "See you at 2pm" },
            ];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // BACKLOG-2338: the single-candidate confidence bypass is REMOVED. This
        // deal HAS an address ("3414 Sapp Road Southwest") and the email never
        // names it, so even though the contact is on only ONE non-archived deal
        // the email is classified address_missing (Needs review), NOT
        // address_found. It still attaches (nothing is dropped) — it just surfaces
        // for the user to confirm or remove.
        expect(result.emailsLinked).toBe(1);
        const insert = mockDbRun.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO communications")
        );
        expect((insert?.[1] as unknown[])?.[3]).toBe("email-sched");
        expect((insert?.[1] as unknown[])?.[7]).toBe("address_missing");
      });

      it("single-candidate: an email that DOES name the street still links confidently (address_found) (BACKLOG-2338)", async () => {
        // Guards against over-correction: removing the single-candidate bypass must
        // NOT stop a single-deal contact's on-topic email from linking as confident.
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 1 };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: "3414 Sapp Road Southwest",
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            // Names the street (abbreviated form still canonicalizes).
            return [
              { id: "email-named", subject: "3414 Sapp Rd SW inspection", body_plain: "" },
            ];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(1);
        const insert = mockDbRun.mock.calls.find(
          (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO communications")
        );
        expect((insert?.[1] as unknown[])?.[3]).toBe("email-named");
        expect((insert?.[1] as unknown[])?.[7]).toBe("address_found");
      });

      it("multi-deal: a shared contact's no-address email surfaces on ALL their transactions (address_missing on each) — guards exclusivity removal (BACKLOG-2338)", async () => {
        // Regression guard for the DROPPED cross-transaction exclusivity backstop
        // (a smart, address-aware variant is deferred to BACKLOG-2339). A contact on
        // TWO non-archived deals, each with a DISTINCT address, sends an email that
        // names NEITHER street. It must surface as Needs review (address_missing) on
        // BOTH deals — never claimed by only one. If blanket exclusivity ever creeps
        // back, the second deal would silently get 0 and this test goes red.
        const TXN_A = "txn-a-2338";
        const TXN_B = "txn-b-2338";
        const ADDR_A = "111 Aspen Court, Denver, CO 80202";
        const ADDR_B = "222 Birch Lane, Denver, CO 80203";

        mockDbGet.mockImplementation((sql: string, params?: unknown[]) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          // Multi-candidate: the contact is on TWO non-archived transactions.
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 2 };
          if (sql.includes("FROM transactions")) {
            const txnId = params?.[0];
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: txnId === TXN_B ? ADDR_B : ADDR_A,
              property_street: null,
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          // No pre-existing link for either transaction (post-2338: the candidate
          // query no longer excludes cross-transaction links).
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string, params?: unknown[]) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          // getOtherCandidateTransactionAddresses — the OTHER deal's address.
          // Params: [contactId, userId, currentTxnId]. Returned faithfully even
          // though the email names neither, so matchesOtherCandidate stays false.
          if (sql.includes("transaction_contacts tc") && sql.includes("property_address")) {
            const currentTxnId = params?.[2];
            return [{ address: currentTxnId === TXN_B ? ADDR_A : ADDR_B }];
          }
          if (sql.includes("FROM email_participants ep")) {
            // Names NEITHER address — no street number/name anywhere.
            return [
              {
                id: "email-shared",
                subject: "Re: paperwork timing",
                body_plain: "Let's confirm the schedule for next week.",
              },
            ];
          }
          return [];
        });

        const runA = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: TXN_A,
        });
        const runB = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: TXN_B,
        });

        // Linked on BOTH deals — the email is NOT excluded from the second.
        expect(runA.emailsLinked).toBe(1);
        expect(runB.emailsLinked).toBe(1);

        // Assert by exact identity → match_reason (INSERT params: [2]=transaction_id,
        // [3]=email_id, [7]=match_reason): address_missing on EACH transaction.
        const reasonByTxn = new Map<string, string>();
        for (const c of mockDbRun.mock.calls) {
          if (typeof c[0] === "string" && c[0].includes("INSERT INTO communications")) {
            const p = c[1] as unknown[];
            if (p[3] === "email-shared") reasonByTxn.set(p[2] as string, p[7] as string);
          }
        }
        expect(reasonByTxn.get(TXN_A)).toBe("address_missing");
        expect(reasonByTxn.get(TXN_B)).toBe("address_missing");
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

      it("uses property_street when property_address is null, filtering in JS (BACKLOG-2311)", async () => {
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 2 };
          if (sql.includes("FROM transactions")) {
            return {
              user_id: mockUserId,
              started_at: "2024-01-01T00:00:00Z",
              created_at: "2024-01-01T00:00:00Z",
              closed_at: null,
              property_address: null,
              property_street: "456 Elm Drive",
              skip_address_filter: 0,
            };
          }
          if (sql.includes("FROM users_local")) return { email: "user@example.com" };
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "john@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) {
            return [
              { id: "email-elm", subject: "456 Elm Dr paperwork", body_plain: "" },
              { id: "email-other", subject: "unrelated", body_plain: "no address here" },
            ];
          }
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        // BACKLOG-2319: property_street normalized to "456 elm". Multi-candidate,
        // so both link and are classified: the matcher → address_found, the other
        // → address_missing (Needs review). Assert by identity → match_reason.
        expect(result.emailsLinked).toBe(2);
        const reasonByEmail = new Map<string, string>();
        for (const c of mockDbRun.mock.calls) {
          if (typeof c[0] === "string" && c[0].includes("INSERT INTO communications")) {
            const p = c[1] as unknown[];
            reasonByEmail.set(p[3] as string, p[7] as string);
          }
        }
        expect(reasonByEmail.get("email-elm")).toBe("address_found");
        expect(reasonByEmail.get("email-other")).toBe("address_missing");
      });

      it("returns 0 when there are no candidate emails at all (fallback has nothing to widen to)", async () => {
        // BACKLOG-2311: With the fallback restored, 0 links only happens when
        // the contact genuinely has no unlinked in-window emails.
        mockDbGet.mockImplementation((sql: string) => {
          if (sql.includes("FROM contacts")) return { id: mockContactId };
          if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) return { cnt: 2 };
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
          if (sql.includes("FROM emails WHERE id")) return { user_id: mockUserId, thread_id: "t1" };
          if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
          return null;
        });

        mockDbAll.mockImplementation((sql: string) => {
          if (sql.includes("FROM contact_emails")) return [{ email: "bob@example.com" }];
          if (sql.includes("FROM contact_phones")) return [];
          if (sql.includes("FROM email_participants ep")) return []; // no candidates
          return [];
        });

        const result = await autoLinkCommunicationsForContact({
          contactId: mockContactId,
          transactionId: mockTransactionId,
        });

        expect(result.emailsLinked).toBe(0);
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
