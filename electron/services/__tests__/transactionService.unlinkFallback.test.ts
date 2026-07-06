/**
 * @jest-environment node
 *
 * BACKLOG-1718 (R3): Verify the NULL thread_id fallback added to
 * TransactionService.unlinkCommunication.
 *
 * When a communications row was created by the pre-fix autoLinkService
 * (thread_id = NULL, email_id set), unlinkCommunication now falls back to
 * resolving thread_id via `SELECT thread_id FROM emails WHERE id = email_id`.
 * This ensures the full thread is still expanded correctly for legacy rows.
 *
 * Tests:
 *   1. 3 pre-fix email rows sharing a thread_id → all 3 deleted on unlink.
 *   2. Restore symmetry: each deleted row writes an ignored_communications entry.
 *   3. Solo pre-fix email (no siblings) → only 1 row deleted.
 *   4. SMS row (message_id set, email_id null) → fallback NOT invoked.
 */

const mockGetById = jest.fn();
const mockDelete = jest.fn();
const mockAddIgnored = jest.fn();
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getCommunicationById: (...args: unknown[]) => mockGetById(...args),
    deleteCommunication: (...args: unknown[]) => mockDelete(...args),
    addIgnoredCommunication: (...args: unknown[]) => mockAddIgnored(...args),
  },
}));

jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: jest.fn(),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
  logService: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import transactionService from "../transactionService";

const USER_ID = "u1";
const TX_ID = "tx-1";
const THREAD_ID = "thread-xyz";

/**
 * Builds a communications row as autoLinkService created BEFORE the fix:
 * email_id is populated, thread_id is NULL.
 */
function makePreFixEmailComm(id: string, emailId: string): Record<string, unknown> {
  return {
    id,
    user_id: USER_ID,
    transaction_id: TX_ID,
    email_id: emailId,
    thread_id: null,           // pre-fix: thread_id was never stored
    message_id: null,
    communication_type: "email",
    subject: "Re: 123 Main St deal",
    sender: "alice@broker.com",
    sent_at: "2026-01-01T00:00:00Z",
  };
}

describe("TransactionService.unlinkCommunication — NULL thread_id fallback (BACKLOG-1718 R3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves thread_id from emails table and removes ALL 3 sibling comms", async () => {
    const comms = [
      makePreFixEmailComm("comm-1", "email-1"),
      makePreFixEmailComm("comm-2", "email-2"),
      makePreFixEmailComm("comm-3", "email-3"),
    ];

    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(comms.find((c) => c.id === id) ?? null),
    );

    // Fallback: emails table returns THREAD_ID for any email_id lookup
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM emails WHERE id")) return { thread_id: THREAD_ID };
      return null;
    });

    // Sibling query returns all 3 comms for the resolved thread_id
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM communications") && sql.includes("thread_id")) {
        return comms.map((c) => ({ id: c.id }));
      }
      return [];
    });

    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-1");

    // All 3 rows must be deleted (not just the clicked one)
    expect(mockDelete).toHaveBeenCalledTimes(3);
    const deletedIds = mockDelete.mock.calls.map((c) => c[0]).sort();
    expect(deletedIds).toEqual(["comm-1", "comm-2", "comm-3"]);

    // Each removal must write an ignored_communications row (restore symmetry)
    expect(mockAddIgnored).toHaveBeenCalledTimes(3);
  });

  it("restore symmetry: each deleted sibling writes an ignored_communications entry", async () => {
    const comms = [
      makePreFixEmailComm("comm-a", "email-a"),
      makePreFixEmailComm("comm-b", "email-b"),
    ];

    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(comms.find((c) => c.id === id) ?? null),
    );
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM emails WHERE id")) return { thread_id: THREAD_ID };
      return null;
    });
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM communications") && sql.includes("thread_id")) {
        return comms.map((c) => ({ id: c.id }));
      }
      return [];
    });
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-a", "QA test removal");

    expect(mockAddIgnored).toHaveBeenCalledTimes(2);
    const ignoredArgs = mockAddIgnored.mock.calls.map((c) => c[0]) as Array<{
      original_communication_id: string;
      reason: string;
    }>;
    const ids = ignoredArgs.map((a) => a.original_communication_id).sort();
    expect(ids).toEqual(["comm-a", "comm-b"]);
    ignoredArgs.forEach((a) => expect(a.reason).toBe("QA test removal"));
  });

  it("solo pre-fix email (no siblings) → only 1 row deleted, no explosion", async () => {
    const solo = makePreFixEmailComm("comm-solo", "email-solo");

    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(id === "comm-solo" ? solo : null),
    );
    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes("FROM emails WHERE id")) return { thread_id: "thread-solo" };
      return null;
    });
    // No siblings
    mockDbAll.mockReturnValue([]);
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-solo");

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("comm-solo");
    expect(mockAddIgnored).toHaveBeenCalledTimes(1);
  });

  it("SMS row (message_id set, email_id null) does NOT invoke the emails fallback", async () => {
    const sms: Record<string, unknown> = {
      id: "comm-sms",
      user_id: USER_ID,
      transaction_id: TX_ID,
      message_id: "msg-1",
      email_id: null,
      thread_id: null,
      communication_type: "sms",
    };

    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(id === "comm-sms" ? sms : null),
    );
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-sms");

    // The fallback SELECT against emails must NOT have fired for an SMS row
    const emailsLookup = mockDbGet.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].includes("FROM emails WHERE id"),
    );
    expect(emailsLookup).toHaveLength(0);

    // Sibling enumeration must NOT run for SMS
    expect(mockDbAll).not.toHaveBeenCalled();

    // Only the SMS row itself is removed
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("comm-sms");
  });
});
