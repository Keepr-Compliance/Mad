/**
 * @jest-environment node
 *
 * BACKLOG-1718: unlinkCommunication thread-aware behaviour.
 *
 * Verifies:
 *   1. Clicking unlink on one email in a multi-email thread removes ALL
 *      thread emails from the transaction (atomic per-row).
 *   2. Single-email threads still work (1 in, 1 out).
 *   3. Restore symmetry: each removed row writes an ignored_communications
 *      entry, so restore-from-removed can reverse it.
 *   4. SMS messages (message_id set, email_id null) do NOT trigger thread
 *      expansion — only emails do.
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

interface FakeCommunication {
  id: string;
  user_id: string;
  transaction_id: string;
  thread_id?: string;
  email_id?: string;
  message_id?: string;
  communication_type?: string;
  subject?: string;
  sender?: string;
  sent_at?: string;
}

function makeEmailComm(id: string, threadId: string): FakeCommunication {
  return {
    id,
    user_id: USER_ID,
    transaction_id: TX_ID,
    thread_id: threadId,
    email_id: `email-of-${id}`,
    communication_type: "email",
    subject: "Re: thread",
    sender: "alice@x.com",
    sent_at: "2026-01-01T00:00:00Z",
  };
}

describe("TransactionService.unlinkCommunication — thread expansion (BACKLOG-1718)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("removes ALL thread sibling communications when one is unlinked", async () => {
    // 5-email thread; we click unlink on comm-3.
    const comms = ["comm-1", "comm-2", "comm-3", "comm-4", "comm-5"].map((id) =>
      makeEmailComm(id, "thread-A"),
    );

    mockGetById.mockImplementation((id: string) => {
      return Promise.resolve(comms.find((c) => c.id === id) ?? null);
    });
    mockDbAll.mockReturnValue(comms.map((c) => ({ id: c.id })));
    mockDbGet.mockReturnValue(null);
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-3");

    // Each sibling should be removed exactly once.
    expect(mockDelete).toHaveBeenCalledTimes(5);
    const removedIds = mockDelete.mock.calls.map((c) => c[0]).sort();
    expect(removedIds).toEqual(["comm-1", "comm-2", "comm-3", "comm-4", "comm-5"]);

    // Each removal writes an ignored_communications row (restore symmetry).
    expect(mockAddIgnored).toHaveBeenCalledTimes(5);
  });

  it("single-email thread: still removes exactly one row", async () => {
    const only = makeEmailComm("comm-solo", "thread-B");
    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(id === "comm-solo" ? only : null),
    );
    mockDbAll.mockReturnValue([{ id: "comm-solo" }]);
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-solo");

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("comm-solo");
  });

  it("SMS message (message_id set, no thread_id) does NOT trigger thread expansion", async () => {
    const sms: FakeCommunication = {
      id: "comm-sms",
      user_id: USER_ID,
      transaction_id: TX_ID,
      message_id: "msg-1",
      communication_type: "sms",
    };
    mockGetById.mockImplementation((id: string) =>
      Promise.resolve(id === "comm-sms" ? sms : null),
    );
    mockDbAll.mockReturnValue([]);
    mockDelete.mockResolvedValue(undefined);
    mockAddIgnored.mockResolvedValue(undefined);

    await transactionService.unlinkCommunication("comm-sms");

    // dbAll should NOT have been invoked (we never enumerate siblings for SMS)
    expect(mockDbAll).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("comm-sms");
  });

  it("throws when communication is not found", async () => {
    mockGetById.mockResolvedValueOnce(null);
    await expect(transactionService.unlinkCommunication("missing")).rejects.toThrow(
      /not found/i,
    );
  });

  it("throws when communication is not linked to a transaction", async () => {
    mockGetById.mockResolvedValueOnce({
      id: "comm-x",
      user_id: USER_ID,
      transaction_id: null,
    });
    await expect(transactionService.unlinkCommunication("comm-x")).rejects.toThrow(
      /not linked/i,
    );
  });
});
