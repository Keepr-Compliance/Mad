/**
 * @jest-environment node
 *
 * BACKLOG-2250: one-time, metadata-ONLY attachment backfill.
 *
 * Verifies backfillAttachmentMetadata:
 *   - populates attachment metadata (exact filename / mime / size) for emails that
 *     have `has_attachments` but no attachment rows, for BOTH providers,
 *   - downloads NO file bytes (the byte-fetching `getAttachment` is never called;
 *     Outlook uses `getAttachments` $select, Gmail uses `getEmailById` full parse),
 *   - is idempotent: re-running creates zero duplicate rows,
 *   - skips emails that already have rows (NOT EXISTS),
 *   - is bounded by `maxEmails` and reports `remaining`,
 *   - isolates per-email failures and leaves not-ready providers for a later run.
 *
 * The DB and provider fetch services are mocked — no native modules, no network.
 */

interface MissingEmailRow {
  id: string;
  external_id: string;
  source: string;
}

const mockGetRawDatabase = jest.fn();
const mockUpsertEmailAttachmentMetadata = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a),
    upsertEmailAttachmentMetadata: (...a: unknown[]) =>
      mockUpsertEmailAttachmentMetadata(...a),
  },
}));

const mockOutlookInit = jest.fn();
const mockOutlookGetAttachments = jest.fn();
const mockOutlookGetAttachment = jest.fn(); // byte download — MUST NOT be called
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockOutlookInit(...a),
    getAttachments: (...a: unknown[]) => mockOutlookGetAttachments(...a),
    getAttachment: (...a: unknown[]) => mockOutlookGetAttachment(...a),
  },
}));

const mockGmailInit = jest.fn();
const mockGmailGetEmailById = jest.fn();
const mockGmailGetAttachment = jest.fn(); // byte download — MUST NOT be called
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInit(...a),
    getEmailById: (...a: unknown[]) => mockGmailGetEmailById(...a),
    getAttachment: (...a: unknown[]) => mockGmailGetAttachment(...a),
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { backfillAttachmentMetadata } from "../emailAttachmentBackfillService";

/**
 * A stateful fake `emails` table. `preIndexed` marks emails that ALREADY have
 * attachment rows (so the NOT EXISTS filter excludes them). The upsert mock adds an
 * email's id to the indexed set, so a re-run's query no longer returns it — exactly
 * the real idempotency behavior.
 */
function setup(missing: MissingEmailRow[], preIndexed: string[] = []): void {
  const indexed = new Set<string>(preIndexed);
  const currentMissing = () => missing.filter((e) => !indexed.has(e.id));

  const db = {
    prepare(sql: string) {
      if (sql.includes("COUNT(*)")) {
        return { get: (_userId: string) => ({ n: currentMissing().length }) };
      }
      if (sql.includes("SELECT e.id")) {
        return {
          all: (_userId: string, limit: number) =>
            currentMissing().slice(0, limit),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  mockGetRawDatabase.mockReturnValue(db);
  mockUpsertEmailAttachmentMetadata.mockImplementation(
    (p: { emailId: string }) => {
      indexed.add(p.emailId);
      return `row-${p.emailId}`;
    },
  );
}

function expectNoBytesDownloaded(): void {
  expect(mockOutlookGetAttachment).not.toHaveBeenCalled();
  expect(mockGmailGetAttachment).not.toHaveBeenCalled();
}

describe("BACKLOG-2250 backfillAttachmentMetadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOutlookInit.mockResolvedValue(true);
    mockGmailInit.mockResolvedValue(true);
  });

  it("Outlook: indexes exact filename/mime/size via metadata-only fetch, no bytes", async () => {
    setup([{ id: "e1", external_id: "o1", source: "outlook" }]);
    mockOutlookGetAttachments.mockResolvedValue([
      {
        id: "a1",
        name: "Purchase Agreement (final).pdf",
        contentType: "application/pdf",
        size: 5555,
      },
    ]);

    const result = await backfillAttachmentMetadata("u1");

    expect(mockOutlookGetAttachments).toHaveBeenCalledTimes(1);
    expect(mockOutlookGetAttachments).toHaveBeenCalledWith("o1");
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith({
      emailId: "e1",
      externalEmailId: "o1",
      filename: "Purchase Agreement (final).pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 5555,
    });
    expectNoBytesDownloaded();
    expect(result).toMatchObject({
      totalMissing: 1,
      processed: 1,
      indexed: 1,
      attachments: 1,
      errors: 0,
      remaining: 0,
    });
  });

  it("Gmail: indexes exact filename/mime/size via getEmailById, no attachment bytes", async () => {
    setup([{ id: "e2", external_id: "g1", source: "gmail" }]);
    mockGmailGetEmailById.mockResolvedValue({
      attachments: [
        {
          filename: "disclosure.docx",
          mimeType: "application/msword",
          size: 6789,
          attachmentId: "att-1",
        },
      ],
    });

    const result = await backfillAttachmentMetadata("u1");

    expect(mockGmailGetEmailById).toHaveBeenCalledTimes(1);
    expect(mockGmailGetEmailById).toHaveBeenCalledWith("g1");
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith({
      emailId: "e2",
      externalEmailId: "g1",
      filename: "disclosure.docx",
      mimeType: "application/msword",
      fileSizeBytes: 6789,
    });
    expectNoBytesDownloaded();
    expect(result).toMatchObject({ processed: 1, indexed: 1, attachments: 1 });
  });

  it("skips emails that already have attachment rows (NOT EXISTS)", async () => {
    // e-has-rows is pre-indexed → excluded from the missing set entirely.
    setup(
      [
        { id: "e-missing", external_id: "o1", source: "outlook" },
        { id: "e-has-rows", external_id: "o2", source: "outlook" },
      ],
      ["e-has-rows"],
    );
    mockOutlookGetAttachments.mockResolvedValue([
      { id: "a1", name: "ok.pdf", contentType: "application/pdf", size: 10 },
    ]);

    const result = await backfillAttachmentMetadata("u1");

    expect(result.totalMissing).toBe(1);
    expect(result.processed).toBe(1);
    expect(mockOutlookGetAttachments).toHaveBeenCalledTimes(1);
    expect(mockOutlookGetAttachments).toHaveBeenCalledWith("o1");
    // Only the missing email was upserted; the already-indexed one was never touched.
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: "e-missing" }),
    );
  });

  it("is idempotent: a second run creates no duplicate rows", async () => {
    setup([{ id: "e1", external_id: "o1", source: "outlook" }]);
    mockOutlookGetAttachments.mockResolvedValue([
      { id: "a1", name: "contract.pdf", contentType: "application/pdf", size: 100 },
    ]);

    const first = await backfillAttachmentMetadata("u1");
    expect(first).toMatchObject({ processed: 1, indexed: 1, attachments: 1 });

    const second = await backfillAttachmentMetadata("u1");

    // After the first run the row exists → nothing left to do, no re-fetch, no dupes.
    expect(second).toMatchObject({
      totalMissing: 0,
      processed: 0,
      indexed: 0,
      attachments: 0,
    });
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockOutlookGetAttachments).toHaveBeenCalledTimes(1);
    expectNoBytesDownloaded();
  });

  it("is bounded by maxEmails and reports remaining", async () => {
    setup([
      { id: "e1", external_id: "o1", source: "outlook" },
      { id: "e2", external_id: "o2", source: "outlook" },
      { id: "e3", external_id: "o3", source: "outlook" },
    ]);
    mockOutlookGetAttachments.mockResolvedValue([
      { id: "a", name: "f.pdf", contentType: "application/pdf", size: 1 },
    ]);

    const result = await backfillAttachmentMetadata("u1", { maxEmails: 2 });

    expect(result).toMatchObject({
      totalMissing: 3,
      processed: 2,
      indexed: 2,
      attachments: 2,
      remaining: 1,
    });
    expect(mockOutlookGetAttachments).toHaveBeenCalledTimes(2);
  });

  it("processes both providers in a mixed batch", async () => {
    setup([
      { id: "e1", external_id: "o1", source: "outlook" },
      { id: "e2", external_id: "g1", source: "gmail" },
    ]);
    mockOutlookGetAttachments.mockResolvedValue([
      { id: "a1", name: "o.pdf", contentType: "application/pdf", size: 1 },
    ]);
    mockGmailGetEmailById.mockResolvedValue({
      attachments: [
        { filename: "g.pdf", mimeType: "application/pdf", size: 2, attachmentId: "x" },
      ],
    });

    const result = await backfillAttachmentMetadata("u1");

    expect(mockOutlookInit).toHaveBeenCalledWith("u1");
    expect(mockGmailInit).toHaveBeenCalledWith("u1");
    expect(result).toMatchObject({ processed: 2, indexed: 2, attachments: 2 });
    expectNoBytesDownloaded();
  });

  it("leaves emails for a later run when the provider is not ready", async () => {
    setup([{ id: "e1", external_id: "o1", source: "outlook" }]);
    mockOutlookInit.mockResolvedValue(false);

    const result = await backfillAttachmentMetadata("u1");

    expect(mockOutlookGetAttachments).not.toHaveBeenCalled();
    expect(mockUpsertEmailAttachmentMetadata).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, indexed: 0, errors: 0 });
  });

  it("isolates a per-email failure and continues", async () => {
    setup([
      { id: "e1", external_id: "o1", source: "outlook" },
      { id: "e2", external_id: "o2", source: "outlook" },
    ]);
    mockOutlookGetAttachments
      .mockRejectedValueOnce(new Error("Graph 500"))
      .mockResolvedValueOnce([
        { id: "a", name: "recovered.pdf", contentType: "application/pdf", size: 9 },
      ]);

    const result = await backfillAttachmentMetadata("u1");

    expect(result).toMatchObject({
      processed: 2,
      indexed: 1,
      attachments: 1,
      errors: 1,
    });
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: "e2", filename: "recovered.pdf" }),
    );
  });

  it("drops attachments without a usable filename (attachments.filename is NOT NULL)", async () => {
    setup([{ id: "e1", external_id: "o1", source: "outlook" }]);
    mockOutlookGetAttachments.mockResolvedValue([
      { id: "blank", name: "   ", contentType: "application/pdf", size: 0 },
      { id: "ok", name: "keep.pdf", contentType: "application/pdf", size: 10 },
    ]);

    const result = await backfillAttachmentMetadata("u1");

    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmailAttachmentMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "keep.pdf" }),
    );
    expect(result).toMatchObject({ indexed: 1, attachments: 1 });
  });

  it("no-ops cleanly when nothing is missing", async () => {
    setup([]);

    const result = await backfillAttachmentMetadata("u1");

    expect(result.totalMissing).toBe(0);
    expect(mockOutlookInit).not.toHaveBeenCalled();
    expect(mockGmailInit).not.toHaveBeenCalled();
    expect(mockUpsertEmailAttachmentMetadata).not.toHaveBeenCalled();
  });
});
