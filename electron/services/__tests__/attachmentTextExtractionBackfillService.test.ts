/**
 * @jest-environment node
 *
 * BACKLOG-2257: bounded, idempotent LOCAL text-extraction backfill.
 *
 * Mirrors the BACKLOG-2250 metadata-backfill test: the DB (`getRawDatabase`) and the
 * per-row extractor (`extractTextForAttachment`) are mocked, so this verifies the
 * ORCHESTRATION only — no real files, no pdfjs, no network:
 *   - selects only pending rows (storage_path NOT NULL, text_content NULL, extractable MIME),
 *   - is bounded by `maxAttachments` and reports `remaining`,
 *   - tallies extracted / skipped('empty') / errors,
 *   - idempotent: a row written "" on the first run leaves the pending set,
 *   - isolates a per-row failure and keeps going,
 *   - the pending query filters on the extractable MIME list.
 */

const mockGetRawDatabase = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a) },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockExtract = jest.fn();
jest.mock("../attachmentTextExtractionService", () => {
  const actual = jest.requireActual("../attachmentTextExtractionService");
  return {
    __esModule: true,
    ...actual,
    extractTextForAttachment: (...a: unknown[]) => mockExtract(...a),
  };
});

import { backfillAttachmentTextContent } from "../attachmentTextExtractionBackfillService";
import { EXTRACTABLE_MIME_SQL_LIST } from "../attachmentTextExtractionService";

interface PendingRow {
  id: string;
  storage_path: string;
  mime_type: string;
}

/**
 * A stateful fake `attachments` table. `extracted` tracks rows that have received a
 * text_content value this run; the query's COUNT/SELECT exclude them, exactly like the
 * real `text_content IS NULL` guard — so a re-run sees a drained set (idempotency).
 */
function setup(pending: PendingRow[]): { sqlSeen: string[] } {
  const written = new Set<string>();
  const remaining = () => pending.filter((r) => !written.has(r.id));
  const sqlSeen: string[] = [];

  const db = {
    prepare(sql: string) {
      sqlSeen.push(sql);
      if (sql.includes("COUNT(*)")) {
        return { get: () => ({ n: remaining().length }) };
      }
      if (sql.includes("SELECT id")) {
        return { all: (limit: number) => remaining().slice(0, limit) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  mockGetRawDatabase.mockReturnValue(db);

  // Default extractor: mark the row written (as the real one does for extracted/empty).
  mockExtract.mockImplementation(async (row: PendingRow) => {
    written.add(row.id);
    return "extracted";
  });

  return { sqlSeen };
}

describe("BACKLOG-2257 backfillAttachmentTextContent", () => {
  beforeEach(() => jest.clearAllMocks());

  it("extracts all pending rows and reports counts", async () => {
    setup([
      { id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" },
      { id: "a2", storage_path: "/p/2.txt", mime_type: "text/plain" },
    ]);

    const result = await backfillAttachmentTextContent();

    expect(result).toMatchObject({
      totalPending: 2,
      processed: 2,
      extracted: 2,
      skipped: 0,
      errors: 0,
      remaining: 0,
    });
    expect(mockExtract).toHaveBeenCalledTimes(2);
    // Each row is passed with text_content: null (eligible).
    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1", text_content: null })
    );
  });

  it("tallies 'empty' outcomes as skipped and drains those rows", async () => {
    const { } = setup([
      { id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" },
    ]);
    // Simulate a scanned PDF: extractor stores "" and returns "empty".
    mockExtract.mockImplementation(async () => "empty");

    const result = await backfillAttachmentTextContent();
    expect(result).toMatchObject({ processed: 1, extracted: 0, skipped: 1, errors: 0 });
  });

  it("is bounded by maxAttachments and reports remaining", async () => {
    setup([
      { id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" },
      { id: "a2", storage_path: "/p/2.pdf", mime_type: "application/pdf" },
      { id: "a3", storage_path: "/p/3.pdf", mime_type: "application/pdf" },
    ]);

    const result = await backfillAttachmentTextContent({ maxAttachments: 2 });

    expect(result).toMatchObject({
      totalPending: 3,
      processed: 2,
      extracted: 2,
      remaining: 1,
    });
    expect(mockExtract).toHaveBeenCalledTimes(2);
  });

  it("is idempotent: a second run has nothing left to do", async () => {
    setup([{ id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" }]);

    const first = await backfillAttachmentTextContent();
    expect(first).toMatchObject({ processed: 1, extracted: 1 });

    const second = await backfillAttachmentTextContent();
    expect(second).toMatchObject({ totalPending: 0, processed: 0, extracted: 0 });
    expect(mockExtract).toHaveBeenCalledTimes(1); // not re-extracted
  });

  it("isolates a per-row failure and continues", async () => {
    const written = new Set<string>();
    const pending = [
      { id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" },
      { id: "a2", storage_path: "/p/2.pdf", mime_type: "application/pdf" },
    ];
    const remaining = () => pending.filter((r) => !written.has(r.id));
    mockGetRawDatabase.mockReturnValue({
      prepare(sql: string) {
        if (sql.includes("COUNT(*)")) return { get: () => ({ n: remaining().length }) };
        return { all: (limit: number) => remaining().slice(0, limit) };
      },
    });
    mockExtract
      .mockImplementationOnce(async () => "error") // a1 fails — left NULL (not drained)
      .mockImplementationOnce(async (row: PendingRow) => {
        written.add(row.id);
        return "extracted";
      });

    const result = await backfillAttachmentTextContent();
    expect(result).toMatchObject({ processed: 2, extracted: 1, errors: 1 });
  });

  it("no-ops cleanly when nothing is pending", async () => {
    setup([]);
    const result = await backfillAttachmentTextContent();
    expect(result.totalPending).toBe(0);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("the pending query filters on the extractable MIME allowlist", async () => {
    const { sqlSeen } = setup([
      { id: "a1", storage_path: "/p/1.pdf", mime_type: "application/pdf" },
    ]);
    await backfillAttachmentTextContent();
    const joined = sqlSeen.join("\n");
    expect(joined).toContain("storage_path IS NOT NULL");
    expect(joined).toContain("text_content IS NULL");
    expect(joined).toContain(EXTRACTABLE_MIME_SQL_LIST);
  });
});
