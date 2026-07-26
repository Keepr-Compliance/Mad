/**
 * @jest-environment node
 *
 * BACKLOG-2257: local attachment text extraction (Phase B of the 322 plan).
 *
 * Two layers:
 *   1. ORCHESTRATION (default `npx jest`): guards, MIME filter, size cap, truncation,
 *      empty-vs-NULL semantics, error isolation, idempotency, and the text/plain path
 *      — using REAL files and a DETERMINISTIC injected PDF extractor stub (jest cannot
 *      load pdfjs' ESM without --experimental-vm-modules).
 *   2. REAL pdfjs proof: extracts committed fixture PDFs through the REAL pdfjs path.
 *      Runs only when `JEST_ESM=1` (with NODE_OPTIONS=--experimental-vm-modules), and
 *      is otherwise skipped so the default gate stays green. Verified locally:
 *        sample-text.pdf -> "KEEPR EXTRACTION TEST 12345"; no-text.pdf -> "".
 *
 * databaseService is mocked so setAttachmentTextContent is a spy; NO network is used.
 */

const mockSetAttachmentTextContent = jest.fn();
const mockGetAttachmentTextExtractionRow = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    setAttachmentTextContent: (...a: unknown[]) => mockSetAttachmentTextContent(...a),
    getAttachmentTextExtractionRow: (...a: unknown[]) =>
      mockGetAttachmentTextExtractionRow(...a),
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import fs from "fs";
import os from "os";
import path from "path";
import {
  extractTextForAttachment,
  extractTextForAttachmentId,
  __setPdfTextExtractorForTests,
  type PdfTextExtractor,
} from "../attachmentTextExtractionService";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2257-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  jest.clearAllMocks();
  __setPdfTextExtractorForTests(null); // restore real extractor by default
});

let fileCounter = 0;
function writeTmp(content: string | Buffer, ext = ".bin"): string {
  const p = path.join(tmpDir, `f${fileCounter++}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

describe("BACKLOG-2257 extractTextForAttachment — orchestration", () => {
  it("text/plain: stores trimmed verbatim text", async () => {
    const storage = writeTmp("  hello world  \n", ".txt");
    const outcome = await extractTextForAttachment({
      id: "a1",
      storage_path: storage,
      mime_type: "text/plain",
      text_content: null,
    });
    expect(outcome).toBe("extracted");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("a1", "hello world");
  });

  it("text/csv: stores verbatim content", async () => {
    const storage = writeTmp("name,amount\nAlice,100", ".csv");
    const outcome = await extractTextForAttachment({
      id: "a-csv",
      storage_path: storage,
      mime_type: "text/csv",
      text_content: null,
    });
    expect(outcome).toBe("extracted");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith(
      "a-csv",
      "name,amount\nAlice,100"
    );
  });

  it("PDF path: stores text returned by the (injected) extractor", async () => {
    const seen: Buffer[] = [];
    const stub: PdfTextExtractor = async (buf) => {
      seen.push(buf);
      return "EXTRACTED PDF BODY";
    };
    __setPdfTextExtractorForTests(stub);
    const storage = writeTmp(Buffer.from("%PDF-1.4 fake bytes"), ".pdf");

    const outcome = await extractTextForAttachment({
      id: "a-pdf",
      storage_path: storage,
      mime_type: "application/pdf",
      text_content: null,
    });

    expect(outcome).toBe("extracted");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("a-pdf", "EXTRACTED PDF BODY");
    // The extractor received the file bytes (local read, no network).
    expect(seen).toHaveLength(1);
    expect(seen[0].toString()).toBe("%PDF-1.4 fake bytes");
  });

  it("no text layer (empty result) → stores '' and reports 'empty' (attempted-no-text)", async () => {
    __setPdfTextExtractorForTests(async () => "   \n  "); // whitespace only
    const storage = writeTmp(Buffer.from("scanned"), ".pdf");
    const outcome = await extractTextForAttachment({
      id: "a-empty",
      storage_path: storage,
      mime_type: "application/pdf",
      text_content: null,
    });
    expect(outcome).toBe("empty");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("a-empty", "");
  });

  it("size cap: over-cap file stores '' WITHOUT parsing (extractor not called)", async () => {
    const stub = jest.fn<Promise<string>, [Buffer]>(async () => "should not run");
    __setPdfTextExtractorForTests(stub);
    const storage = writeTmp(Buffer.from("x".repeat(500)), ".pdf");

    const outcome = await extractTextForAttachment(
      {
        id: "a-big",
        storage_path: storage,
        mime_type: "application/pdf",
        text_content: null,
      },
      { maxSizeBytes: 100 } // file is 500 bytes > 100
    );

    expect(outcome).toBe("empty");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("a-big", "");
    expect(stub).not.toHaveBeenCalled();
  });

  it("truncation: stored text is capped at maxTextLength", async () => {
    const storage = writeTmp("A".repeat(5000), ".txt");
    const outcome = await extractTextForAttachment(
      {
        id: "a-long",
        storage_path: storage,
        mime_type: "text/plain",
        text_content: null,
      },
      { maxTextLength: 10 }
    );
    expect(outcome).toBe("extracted");
    const [, storedText] = mockSetAttachmentTextContent.mock.calls[0] as [string, string];
    expect(storedText).toBe("A".repeat(10));
    expect(storedText.length).toBe(10);
  });

  it("corrupt PDF (extractor throws) → 'error', text_content left NULL (no DB write)", async () => {
    __setPdfTextExtractorForTests(async () => {
      throw new Error("Invalid PDF structure");
    });
    const storage = writeTmp(Buffer.from("not a real pdf"), ".pdf");
    const outcome = await extractTextForAttachment({
      id: "a-corrupt",
      storage_path: storage,
      mime_type: "application/pdf",
      text_content: null,
    });
    expect(outcome).toBe("error");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("guard: no storage_path → 'ineligible', nothing written", async () => {
    const outcome = await extractTextForAttachment({
      id: "a-nopath",
      storage_path: null,
      mime_type: "application/pdf",
      text_content: null,
    });
    expect(outcome).toBe("ineligible");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("guard: non-extractable MIME (image/png) → 'ineligible', extractor not called", async () => {
    const stub = jest.fn<Promise<string>, [Buffer]>(async () => "x");
    __setPdfTextExtractorForTests(stub);
    const storage = writeTmp(Buffer.from("PNGDATA"), ".png");
    const outcome = await extractTextForAttachment({
      id: "a-png",
      storage_path: storage,
      mime_type: "image/png",
      text_content: null,
    });
    expect(outcome).toBe("ineligible");
    expect(stub).not.toHaveBeenCalled();
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("idempotency: a row that already has text_content is 'ineligible' (no re-extract)", async () => {
    const storage = writeTmp("new text", ".txt");
    const outcome = await extractTextForAttachment({
      id: "a-done",
      storage_path: storage,
      mime_type: "text/plain",
      text_content: "previously extracted",
    });
    expect(outcome).toBe("ineligible");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("idempotency: a row already marked '' (attempted-no-text) is 'ineligible'", async () => {
    const storage = writeTmp("some text", ".txt");
    const outcome = await extractTextForAttachment({
      id: "a-emptied",
      storage_path: storage,
      mime_type: "text/plain",
      text_content: "",
    });
    expect(outcome).toBe("ineligible");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("missing file → 'error' (stat fails), nothing written", async () => {
    const outcome = await extractTextForAttachment({
      id: "a-missing",
      storage_path: path.join(tmpDir, "does-not-exist.pdf"),
      mime_type: "application/pdf",
      text_content: null,
    });
    expect(outcome).toBe("error");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });

  it("performs NO network call during extraction", async () => {
    const fetchSpy = jest
      .spyOn(globalThis as { fetch: typeof fetch }, "fetch")
      .mockImplementation((() => {
        throw new Error("network call attempted");
      }) as typeof fetch);
    const storage = writeTmp("local only content", ".txt");

    const outcome = await extractTextForAttachment({
      id: "a-net",
      storage_path: storage,
      mime_type: "text/plain",
      text_content: null,
    });

    expect(outcome).toBe("extracted");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("BACKLOG-2257 extractTextForAttachmentId — id-based entrypoint", () => {
  it("fetches the row then extracts", async () => {
    const storage = writeTmp("id path text", ".txt");
    mockGetAttachmentTextExtractionRow.mockReturnValue({
      storage_path: storage,
      mime_type: "text/plain",
      text_content: null,
    });
    const outcome = await extractTextForAttachmentId("a-id");
    expect(mockGetAttachmentTextExtractionRow).toHaveBeenCalledWith("a-id");
    expect(outcome).toBe("extracted");
    expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("a-id", "id path text");
  });

  it("returns 'ineligible' when the row no longer exists", async () => {
    mockGetAttachmentTextExtractionRow.mockReturnValue(undefined);
    const outcome = await extractTextForAttachmentId("gone");
    expect(outcome).toBe("ineligible");
    expect(mockSetAttachmentTextContent).not.toHaveBeenCalled();
  });
});

// ── REAL pdfjs proof (needs a genuine ESM dynamic import) ──────────────────────────
// jest cannot run `import()` without --experimental-vm-modules, so this block only
// executes under `JEST_ESM=1` (with that NODE_OPTION). Skipped otherwise so the
// default `npx jest` gate stays green. Uses the REAL extractor on committed fixtures.
const realPdfIt = process.env.JEST_ESM === "1" ? it : it.skip;
const FIXTURES = path.join(__dirname, "fixtures");

describe("BACKLOG-2257 real pdfjs extraction (JEST_ESM=1 only)", () => {
  realPdfIt(
    "extracts the exact text layer from a real PDF into text_content",
    async () => {
      __setPdfTextExtractorForTests(null); // REAL pdfjs
      const outcome = await extractTextForAttachment({
        id: "real-1",
        storage_path: path.join(FIXTURES, "sample-text.pdf"),
        mime_type: "application/pdf",
        text_content: null,
      });
      expect(outcome).toBe("extracted");
      const [, text] = mockSetAttachmentTextContent.mock.calls[0] as [string, string];
      expect(text).toContain("KEEPR EXTRACTION TEST 12345");
    }
  );

  realPdfIt(
    "a real image-only PDF (no text layer) → stored '' (empty, not error)",
    async () => {
      __setPdfTextExtractorForTests(null); // REAL pdfjs
      const outcome = await extractTextForAttachment({
        id: "real-2",
        storage_path: path.join(FIXTURES, "no-text.pdf"),
        mime_type: "application/pdf",
        text_content: null,
      });
      expect(outcome).toBe("empty");
      expect(mockSetAttachmentTextContent).toHaveBeenCalledWith("real-2", "");
    }
  );
});
