/**
 * BACKLOG-1870: attachment METADATA persistence at sync.
 *
 * Verifies that storing parsed emails through the canonical fetchStoreAndDedup
 * path (via the exported storeParsedEmailsForAccount wrapper):
 *   - persists attachment filename/mime/size for NEWLY inserted emails,
 *   - downloads NO file bytes (Gmail metadata is already present; Outlook uses a
 *     metadata-only lookup),
 *   - is idempotent: re-syncing an already-stored email does not re-persist.
 *
 * The DB layer is mocked so no native modules run.
 */

const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockGetRawDatabase = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...a: unknown[]) => mockDbAll(...a),
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a),
}));

const mockGetOAuthToken = jest.fn();
const mockUpsertEmailAttachmentMetadata = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: (...a: unknown[]) =>
      mockUpsertEmailAttachmentMetadata(...a),
  },
}));

import {
  storeParsedEmailsForAccount,
  type StoreableEmail,
} from "../emailSyncService";

/** A fake prepared-statement DB whose INSERTs always succeed and are recorded. */
function makeFakeDb() {
  const insertRuns: unknown[][] = [];
  const stmt = (sink: unknown[][]) => ({
    run: (...args: unknown[]) => sink.push(args),
  });
  const db = {
    prepare: jest.fn((sql: string) => {
      if (sql.includes("UPDATE emails SET external_id")) return stmt([]);
      if (sql.includes("INSERT INTO emails")) return stmt(insertRuns);
      return stmt([]); // participants
    }),
    transaction: (fn: () => void) => () => fn(),
  };
  return { db, insertRuns };
}

function mkEmail(overrides: Partial<StoreableEmail>): StoreableEmail {
  return {
    id: "g1",
    threadId: "t-g1",
    from: "sender@example.com",
    to: "me@example.com",
    cc: null,
    bcc: null,
    messageIdHeader: null,
    subject: "Closing docs",
    body: "see attached",
    bodyPlain: "see attached",
    date: new Date("2026-02-15T10:00:00Z"),
    hasAttachments: false,
    attachmentCount: 0,
    participants: [],
    ingestSource: "filter",
    ...overrides,
  };
}

describe("BACKLOG-1870 sync attachment metadata persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOAuthToken.mockResolvedValue({
      id: "acct-1",
      connected_email_address: "me@example.com",
    });
    mockDbAll.mockReturnValue([]); // nothing pre-existing → all inserts are new
  });

  it("Gmail: persists attachment metadata (exact filename/mime/size) with NO extra fetch and NO bytes", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);
    const getAttachmentsFn = jest.fn(); // must NOT be called (metadata already present)

    const email = mkEmail({
      id: "g1",
      hasAttachments: true,
      attachmentCount: 1,
      // Gmail's ParsedEmail parses these from the message payload — no bytes.
      attachments: [
        {
          filename: "wire-instructions.pdf",
          mimeType: "application/pdf",
          size: 12345,
          attachmentId: "att-1",
        },
      ],
    });

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [email],
      getAttachmentsFn,
    });

    // The internal email id is the first column of the emails INSERT.
    const internalEmailId = insertRuns[0][0] as string;
    expect(typeof internalEmailId).toBe("string");

    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith({
      emailId: internalEmailId,
      externalEmailId: "g1",
      filename: "wire-instructions.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 12345,
    });

    // No provider round-trip for filenames, no byte download.
    expect(getAttachmentsFn).not.toHaveBeenCalled();
  });

  it("Outlook: fetches metadata-only via getAttachmentsFn (no contentBytes) and persists it", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);
    // Metadata-only shape: id/name/contentType/size — NO contentBytes.
    const getAttachmentsFn = jest.fn().mockResolvedValue([
      { id: "o-att-1", name: "disclosure.docx", contentType: "application/msword", size: 6789 },
    ]);

    const email = mkEmail({
      id: "o1",
      threadId: "t-o1",
      hasAttachments: true,
      attachmentCount: 1,
      attachments: undefined, // Outlook list response carries no filenames
    });

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [email],
      getAttachmentsFn,
    });

    const internalEmailId = insertRuns[0][0] as string;

    expect(getAttachmentsFn).toHaveBeenCalledTimes(1);
    expect(getAttachmentsFn).toHaveBeenCalledWith("o1");
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith({
      emailId: internalEmailId,
      externalEmailId: "o1",
      filename: "disclosure.docx",
      mimeType: "application/msword",
      fileSizeBytes: 6789,
    });
  });

  it("does NOT fetch or persist when the email has no attachments", async () => {
    const { db } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);
    const getAttachmentsFn = jest.fn();

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkEmail({ id: "o-none", hasAttachments: false })],
      getAttachmentsFn,
    });

    expect(getAttachmentsFn).not.toHaveBeenCalled();
    expect(mockUpsertEmailAttachmentMetadata).not.toHaveBeenCalled();
  });

  it("idempotent: re-syncing an already-stored email does not re-persist metadata", async () => {
    // Second sync: the external_id already exists → the email is a duplicate, not
    // inserted, so no attachment metadata is persisted again (no duplicate rows).
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("external_id IN")) return [{ external_id: "g1" }];
      return [];
    });
    const { db } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const email = mkEmail({
      id: "g1",
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [
        {
          filename: "wire-instructions.pdf",
          mimeType: "application/pdf",
          size: 12345,
          attachmentId: "att-1",
        },
      ],
    });

    const result = await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [email],
    });

    expect(result.stored).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(mockUpsertEmailAttachmentMetadata).not.toHaveBeenCalled();
  });
});
