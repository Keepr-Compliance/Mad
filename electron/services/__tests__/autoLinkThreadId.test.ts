/**
 * @jest-environment node
 *
 * BACKLOG-1718 (R3): Verify that autoLinkService.linkEmailToTransaction
 * now populates communications.thread_id from the emails table.
 *
 * Before the fix, the SELECT only fetched user_id and the INSERT column list
 * omitted thread_id, so every auto-linked email had thread_id = NULL.
 * That prevented unlinkCommunication from expanding to thread siblings.
 */

const mockDbGet = jest.fn();
const mockDbAll = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

jest.mock("../databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../supabaseService", () => ({ __esModule: true, default: {} }));
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

import { autoLinkCommunicationsForContact } from "../autoLinkService";

const USER_ID = "u1";
const TX_ID = "tx-1";
const CONTACT_ID = "contact-1";
const EMAIL_ID = "email-abc";
const THREAD_ID = "thread-xyz";

function setupMocks({
  emailThreadId,
}: {
  emailThreadId: string | null;
}) {
  mockDbGet.mockImplementation((sql: string) => {
    if (sql.includes("FROM contacts")) return { id: CONTACT_ID };
    if (sql.includes("FROM transactions")) {
      return {
        user_id: USER_ID,
        started_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        closed_at: null,
        property_address: null,
        property_street: null,
      };
    }
    // communications check — not yet linked
    if (sql.includes("FROM communications") && sql.includes("email_id")) return null;
    // emails row: returns user_id + thread_id
    if (sql.includes("FROM emails WHERE id")) {
      return { user_id: USER_ID, thread_id: emailThreadId };
    }
    if (sql.includes("FROM users_local")) return { email: "user@test.com" };
    return null;
  });

  mockDbAll.mockImplementation((sql: string) => {
    if (sql.includes("FROM contact_emails")) return [{ email: "alice@example.com" }];
    if (sql.includes("FROM contact_phones")) return [];
    if (sql.includes("FROM email_participants ep")) return [{ id: EMAIL_ID }];
    return [];
  });
}

describe("autoLinkService — thread_id propagation into communications INSERT (BACKLOG-1718 R3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores thread_id in the INSERT when emails table has a thread", async () => {
    setupMocks({ emailThreadId: THREAD_ID });

    await autoLinkCommunicationsForContact({ contactId: CONTACT_ID, transactionId: TX_ID });

    const insertCall = mockDbRun.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("INSERT INTO communications"),
    );
    expect(insertCall).toBeDefined();
    const [insertSql, insertParams] = insertCall!;

    // Column list must name thread_id
    expect(insertSql).toContain("thread_id");
    // Params array must carry the thread value
    expect(insertParams).toContain(THREAD_ID);
    // And the other expected values must still be present
    expect(insertParams).toContain(EMAIL_ID);
    expect(insertParams).toContain(TX_ID);
  });

  it("stores NULL for thread_id when the email has no thread (solo email)", async () => {
    setupMocks({ emailThreadId: null });

    await autoLinkCommunicationsForContact({ contactId: CONTACT_ID, transactionId: TX_ID });

    const insertCall = mockDbRun.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("INSERT INTO communications"),
    );
    expect(insertCall).toBeDefined();
    const [insertSql, insertParams] = insertCall!;

    expect(insertSql).toContain("thread_id");
    // thread_id column placeholder must be null (not undefined, not missing)
    const emailIdIndex = (insertParams as unknown[]).indexOf(EMAIL_ID);
    // thread_id is the column immediately after email_id in the INSERT
    const threadIdValue = (insertParams as unknown[])[emailIdIndex + 1];
    expect(threadIdValue).toBeNull();
  });
});
