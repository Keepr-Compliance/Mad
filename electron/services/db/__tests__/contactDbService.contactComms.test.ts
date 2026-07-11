/**
 * @jest-environment node
 */

/**
 * Unit tests for the BACKLOG-1933 contact-scoped comms methods:
 *   - getEmailsForContact(contactId): Promise<Communication[]>
 *   - getMessagesForContact(contactId): Promise<ContactMessageThread[]>
 *
 * These aggregate a contact's emails/texts across ALL transactions (NOT
 * transaction-scoped) and return viewer-ready rows:
 *   - emails  -> hydrated Communication (= Message), ready for EmailViewModal
 *   - texts   -> thread groups { thread_id, phoneNumber, messages, transaction_id? },
 *                ready for ConversationViewModal
 *
 * CRITICAL (Phase 1 lesson): the mocks below return the REAL `emails` /
 * `messages` column shapes (e.g. `body_html`/`body_plain`/`sender` on emails,
 * `participants_flat`/`duplicate_of`/`transaction_id` on messages). A mock that
 * used the wrong shape is exactly how the Phase 1 boundary bug hid.
 */

import { jest } from "@jest/globals";

const mockDbAll = jest.fn();
const mockDbGet = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbAll: mockDbAll,
  dbGet: mockDbGet,
  dbRun: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock("../../logService", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// contactDbService pulls these in at import time; stub to keep the node env light.
jest.mock("../../contactsService", () => ({ getContactNames: jest.fn() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn().mockReturnValue(false),
}));

// NOTE: messageMatchingService is intentionally NOT mocked — getMessagesForContact
// uses its REAL pure helpers (normalizePhone/phonesMatch). toE164 is real too.

import { getEmailsForContact, getMessagesForContact } from "../contactDbService";

const USER_ID = "user-1";
const CONTACT_ID = "contact-1";

/** A raw `emails`-table row as returned by the getEmailsForContact SELECT. */
function emailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "email-1",
    user_id: USER_ID,
    subject: "Closing docs",
    body: "<p>hi</p>", // aliased from e.body_html
    body_html: "<p>hi</p>",
    body_text: "hi", // aliased from e.body_plain
    body_plain: "hi",
    sender: "agent@example.com",
    recipients: "client@example.com",
    cc: null,
    bcc: null,
    sent_at: "2024-05-01T10:00:00Z",
    received_at: "2024-05-01T10:00:01Z",
    has_attachments: 0,
    attachment_count: 0,
    thread_id: "thread-e1",
    external_id: "ext-1",
    source: "gmail",
    direction: "inbound",
    channel: "email",
    transaction_id: null, // LEFT JOIN communications -> NULL when non-linked
    ...overrides,
  };
}

/** A raw `messages`-table row as returned by the getMessagesForContact SELECT. */
function messageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg-1",
    user_id: USER_ID,
    channel_account_id: null,
    external_id: "sms-ext-1",
    channel: "sms",
    direction: "inbound",
    subject: null,
    body_html: null,
    body_text: "hello there",
    participants: JSON.stringify({ from: "+14155550001", to: ["+14155550002"] }),
    participants_flat: "+14155550001, +14155550002",
    thread_id: "thread-m1",
    sent_at: "2024-05-02T09:00:00Z",
    received_at: "2024-05-02T09:00:01Z",
    has_attachments: 0,
    transaction_id: null,
    message_type: "text",
    created_at: "2024-05-02T09:00:00Z",
    ...overrides,
  };
}

describe("contactDbService.getEmailsForContact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns [] for an unknown contact (no user_id)", async () => {
    mockDbGet.mockReturnValueOnce(undefined); // getContactUserId -> not found
    const result = await getEmailsForContact(CONTACT_ID);
    expect(result).toEqual([]);
    // Must not run the participant query when the contact doesn't exist.
    expect(mockDbAll).not.toHaveBeenCalled();
  });

  it("returns [] when the contact has no email addresses", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID }); // getContactUserId
    mockDbAll.mockReturnValueOnce([]); // getContactEmailEntries -> none
    const result = await getEmailsForContact(CONTACT_ID);
    expect(result).toEqual([]);
  });

  it("returns hydrated Communication rows matching the contact's addresses", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID }); // getContactUserId
    mockDbAll
      // getContactEmailEntries
      .mockReturnValueOnce([
        { id: "ce-1", email: "client@example.com", is_primary: 1 },
      ])
      // main email query
      .mockReturnValueOnce([emailRow()]);

    const result = await getEmailsForContact(CONTACT_ID);

    expect(result).toHaveLength(1);
    const email = result[0];
    // Viewer-facing fields (EmailViewModal reads these).
    expect(email.id).toBe("email-1");
    expect(email.subject).toBe("Closing docs");
    expect(email.body_html).toBe("<p>hi</p>");
    expect(email.body_text).toBe("hi");
    expect(email.sender).toBe("agent@example.com");
    expect(email.recipients).toBe("client@example.com");
    // has_attachments must be a real boolean (SQLite 0/1 -> false/true).
    expect(email.has_attachments).toBe(false);
    // Non-transaction-linked email -> transaction_id null (expected, not a bug).
    expect(email.transaction_id).toBeNull();
  });

  it("lowercases + passes every contact address into the WHERE IN clause", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll
      .mockReturnValueOnce([
        { id: "ce-1", email: "Client@Example.com", is_primary: 1 },
        { id: "ce-2", email: "  ALT@Example.com ", is_primary: 0 },
      ])
      .mockReturnValueOnce([emailRow()]);

    await getEmailsForContact(CONTACT_ID);

    // Second dbAll call is the main email query; params = [userId, ...addresses].
    const mainCallArgs = mockDbAll.mock.calls[1];
    const params = mainCallArgs[1] as unknown[];
    expect(params[0]).toBe(USER_ID);
    expect(params).toContain("client@example.com");
    expect(params).toContain("alt@example.com"); // trimmed + lowercased
  });

  it("dedupes by email id when a contact has multiple addresses/participants matching the same email", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll
      // Contact has TWO addresses...
      .mockReturnValueOnce([
        { id: "ce-1", email: "client@example.com", is_primary: 1 },
        { id: "ce-2", email: "client.alt@example.com", is_primary: 0 },
      ])
      // ...and the SAME email row comes back twice (both addresses are
      // participants; the communications LEFT JOIN can also multiply rows).
      .mockReturnValueOnce([
        emailRow({ id: "email-dup" }),
        emailRow({ id: "email-dup" }),
        emailRow({ id: "email-2", subject: "Second" }),
      ]);

    const result = await getEmailsForContact(CONTACT_ID);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(["email-dup", "email-2"]);
  });
});

describe("contactDbService.getMessagesForContact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns [] for an unknown contact (no user_id)", async () => {
    mockDbGet.mockReturnValueOnce(undefined); // getContactUserId
    const result = await getMessagesForContact(CONTACT_ID);
    expect(result).toEqual([]);
    expect(mockDbAll).not.toHaveBeenCalled();
  });

  it("returns [] when the contact has no phone numbers", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll.mockReturnValueOnce([]); // getContactPhoneEntries -> none
    const result = await getMessagesForContact(CONTACT_ID);
    expect(result).toEqual([]);
  });

  it("groups matched messages into a thread with a representative phoneNumber", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID }); // getContactUserId
    mockDbAll
      // getContactPhoneEntries (E.164)
      .mockReturnValueOnce([
        { id: "cp-1", phone: "+14155550001", is_primary: 1 },
      ])
      // main messages query (two messages in the same thread)
      .mockReturnValueOnce([
        messageRow({ id: "msg-1", thread_id: "thread-m1" }),
        messageRow({ id: "msg-2", thread_id: "thread-m1", sent_at: "2024-05-02T09:05:00Z" }),
      ]);

    const result = await getMessagesForContact(CONTACT_ID);

    expect(result).toHaveLength(1);
    const thread = result[0];
    expect(thread.thread_id).toBe("thread-m1");
    // Representative phoneNumber (required by ConversationViewModal) = the
    // matched contact phone.
    expect(thread.phoneNumber).toBe("+14155550001");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    // has_attachments coerced to boolean on each message.
    expect(thread.messages[0].has_attachments).toBe(false);
    // Non-linked thread -> undefined transaction_id. The communications
    // fallback IS queried (row carried no transaction_id) but returns nothing
    // here (mocked dbGet default = undefined), so it stays undefined.
    expect(thread.transaction_id).toBeUndefined();
    expect(mockDbGet).toHaveBeenCalledTimes(2); // getContactUserId + communications fallback
  });

  it("prefers messages.transaction_id directly off the row", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll
      .mockReturnValueOnce([{ id: "cp-1", phone: "+14155550001", is_primary: 1 }])
      .mockReturnValueOnce([
        messageRow({ id: "msg-1", thread_id: "thread-m1", transaction_id: "txn-42" }),
      ]);

    const result = await getMessagesForContact(CONTACT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe("txn-42");
    // Direct row value present -> no communications fallback lookup.
    expect(mockDbGet).toHaveBeenCalledTimes(1);
  });

  it("falls back to the communications junction when the row has no transaction_id", async () => {
    mockDbGet
      .mockReturnValueOnce({ user_id: USER_ID }) // getContactUserId
      .mockReturnValueOnce({ transaction_id: "txn-linked" }); // communications fallback
    mockDbAll
      .mockReturnValueOnce([{ id: "cp-1", phone: "+14155550001", is_primary: 1 }])
      .mockReturnValueOnce([
        messageRow({ id: "msg-1", thread_id: "thread-m1", transaction_id: null }),
      ]);

    const result = await getMessagesForContact(CONTACT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].transaction_id).toBe("txn-linked");
    expect(mockDbGet).toHaveBeenCalledTimes(2); // user_id + fallback
  });

  it("skips messages whose participants_flat does not involve the contact", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll
      .mockReturnValueOnce([{ id: "cp-1", phone: "+14155550001", is_primary: 1 }])
      .mockReturnValueOnce([
        // involves the contact
        messageRow({ id: "msg-1", thread_id: "thread-a", participants_flat: "+14155550001, +14155559999" }),
        // does NOT involve the contact
        messageRow({ id: "msg-2", thread_id: "thread-b", participants_flat: "+14155558888, +14155557777" }),
      ]);

    const result = await getMessagesForContact(CONTACT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].thread_id).toBe("thread-a");
  });

  it("dedups/groups across multiple contact phones and multiple threads", async () => {
    mockDbGet.mockReturnValueOnce({ user_id: USER_ID });
    mockDbAll
      // Contact has TWO phones
      .mockReturnValueOnce([
        { id: "cp-1", phone: "+14155550001", is_primary: 1 },
        { id: "cp-2", phone: "+14155550055", is_primary: 0 },
      ])
      .mockReturnValueOnce([
        // Thread A, matched by phone 1
        messageRow({ id: "m1", thread_id: "thread-a", participants_flat: "+14155550001, +1 (415) 555-9999", sent_at: "2024-05-01T00:00:00Z" }),
        messageRow({ id: "m2", thread_id: "thread-a", participants_flat: "+14155550001, +14155559999", sent_at: "2024-05-01T00:05:00Z" }),
        // Thread B, matched by phone 2 (different format in participants_flat)
        messageRow({ id: "m3", thread_id: "thread-b", participants_flat: "(415) 555-0055, +14155551234", sent_at: "2024-05-03T00:00:00Z" }),
      ]);

    const result = await getMessagesForContact(CONTACT_ID);

    // Two distinct threads.
    expect(result).toHaveLength(2);
    // Newest-activity-first: thread-b (May 3) before thread-a (May 1).
    expect(result.map((t) => t.thread_id)).toEqual(["thread-b", "thread-a"]);

    const threadA = result.find((t) => t.thread_id === "thread-a")!;
    expect(threadA.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(threadA.phoneNumber).toBe("+14155550001");

    const threadB = result.find((t) => t.thread_id === "thread-b")!;
    expect(threadB.messages).toHaveLength(1);
    // phonesMatch normalizes "(415) 555-0055" to the contact's +14155550055.
    expect(threadB.phoneNumber).toBe("+14155550055");
  });
});
