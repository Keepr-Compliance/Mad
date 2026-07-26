/**
 * Attachment Text Extraction Service (BACKLOG-2257, Phase B of the 322 plan)
 *
 * Populates `attachments.text_content` with LOCALLY-extracted text so downloaded
 * documents become searchable/analysable WITHOUT any network call and WITHOUT OCR.
 *
 * ─── Library decision: pdfjs-dist v5 (legacy build), NOT pdf-parse ───────────────
 * Both were evaluated against real-world PDFs. `pdf-parse@1.1.1` is pure CommonJS
 * (trivial to import from our tsc→CommonJS main process) BUT its bundled pdfjs is
 * from 2018 and EMPIRICALLY FAILS ("bad XRef entry") on standard modern PDFs — e.g.
 * anything produced by Ghostscript / Chrome print-to-PDF / DocuSign — which is most
 * of what arrives as an email attachment. `pdf-parse@2.x` fixes that only by pulling
 * in the NATIVE `@napi-rs/canvas` (violates the no-native-deps rule).
 *
 * `pdfjs-dist` (already a dependency via react-pdf; here pinned as a DIRECT dep) has
 * NO native deps and correctly parses those same modern PDFs. Its one cost is that v5
 * is ESM-only, and our main process is compiled by tsc to CommonJS (unbundled), where
 * a normal `import()` is downleveled to `require()` and cannot load an `.mjs`. We
 * therefore load it through a PRESERVED dynamic import ({@link loadPdfjs}) — a
 * `new Function("s", "return import(s)")` escape hatch that tsc does not rewrite, so
 * Node/Electron executes a real ESM import. pdfjs runs headless on the main thread
 * (fake worker) — no DOM, no browser globals. This was verified end-to-end in Node.
 *
 * NO OCR: a scanned / image-only PDF has no text layer → yields empty text. Trivial
 * text types (text/plain, text/csv) are read verbatim. docx/xlsx etc. are OUT OF
 * SCOPE (they would need another parser).
 *
 * ─── Empty-text vs NULL semantics (IMPORTANT) ────────────────────────────────────
 *   - `text_content IS NULL`  → extraction was NEVER attempted (the pending guard).
 *   - `text_content = ""`     → extraction WAS attempted but produced no usable text
 *                               (scanned PDF, empty text layer, or an over-cap file we
 *                               deliberately did not parse). Writing "" removes the row
 *                               from the pending set so re-runs stay idempotent and the
 *                               backfill drains to zero.
 *   - Only a genuine EXTRACTION ERROR (corrupt file, read failure) leaves text_content
 *     NULL, so a later manual run may retry it.
 *
 * Everything here is LOCAL: read the file at storage_path, parse in-process, write the
 * DB row. No fetch / http / network of any kind.
 */

import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import logService from "./logService";

const SERVICE_NAME = "AttachmentTextExtraction";

/** Skip files larger than this (bytes) — extraction cost guard. Default 20MB. */
export const MAX_EXTRACT_SIZE_BYTES = 20 * 1024 * 1024;

/** Truncate stored text to this many characters so the DB does not bloat. ~1MB. */
export const MAX_TEXT_LENGTH = 1_000_000;

/** MIME types we can extract locally with no extra parser and no OCR. */
export const EXTRACTABLE_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "text/plain",
  "text/csv",
];

/** SQL fragment (for the backfill) listing the extractable MIME types. */
export const EXTRACTABLE_MIME_SQL_LIST = EXTRACTABLE_MIME_TYPES.map(
  (m) => `'${m}'`
).join(", ");

/**
 * Outcome of an extraction attempt on one row:
 *   - "extracted"  → non-empty text was stored (possibly truncated).
 *   - "empty"      → "" was stored (no text layer / empty text / over-cap file).
 *   - "error"      → parse/read failed; text_content left NULL (may retry later).
 *   - "ineligible" → guard failed (no storage_path, wrong MIME, or already has text);
 *                    nothing was written.
 */
export type TextExtractionOutcome = "extracted" | "empty" | "error" | "ineligible";

/** Minimal row shape the extractor needs. */
export interface AttachmentTextRow {
  id: string;
  storage_path: string | null;
  mime_type: string | null;
  /** Current stored value; `null`/`undefined` = never attempted (eligible). */
  text_content?: string | null;
}

/** Test-only overrides for the size / truncation caps (never exposed via IPC). */
export interface ExtractionOptions {
  maxSizeBytes?: number;
  maxTextLength?: number;
}

// ─── Minimal structural types for the parts of pdfjs-dist we use ─────────────────
// We load pdfjs via a runtime dynamic import, so its own types are not in scope; a
// small hand-written surface keeps this file strict-mode clean with no `any`.
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfTextContent {
  items: PdfTextItem[];
}
interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfDocumentLoadingTask {
  promise: Promise<PdfDocument>;
}
interface PdfjsLib {
  getDocument(src: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
    disableFontFace?: boolean;
  }): PdfDocumentLoadingTask;
}

/**
 * Preserved dynamic import: tsc (module: commonjs) rewrites a normal `import()` into
 * `require()`, which cannot load pdfjs' ESM `.mjs`. `new Function` hides the import()
 * from tsc so Node executes a genuine ESM import. Cached after first load.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

let pdfjsPromise: Promise<PdfjsLib> | null = null;
function loadPdfjs(): Promise<PdfjsLib> {
  if (!pdfjsPromise) {
    pdfjsPromise = dynamicImport("pdfjs-dist/legacy/build/pdf.mjs").then(
      (mod) => mod as PdfjsLib
    );
  }
  return pdfjsPromise;
}

function isExtractableMime(mime: string | null | undefined): boolean {
  return !!mime && EXTRACTABLE_MIME_TYPES.includes(mime);
}

/**
 * The active PDF text extractor. Defaults to the real pdfjs path; tests may swap in a
 * deterministic stub via {@link __setPdfTextExtractorForTests} so the orchestration
 * (guards / size cap / truncation / empty / error) is exercised without needing jest
 * to load ESM. Not part of the public runtime surface.
 */
export type PdfTextExtractor = (buffer: Buffer) => Promise<string>;
let pdfTextExtractor: PdfTextExtractor = extractPdfTextViaPdfjs;

/** TEST-ONLY: override the PDF extractor (pass `null` to restore the real one). */
export function __setPdfTextExtractorForTests(fn: PdfTextExtractor | null): void {
  pdfTextExtractor = fn ?? extractPdfTextViaPdfjs;
}

/**
 * Extract the text LAYER from a PDF buffer via pdfjs (headless, main-thread). Returns
 * the concatenated page text. Throws on a parse failure so the caller records an error.
 */
async function extractPdfTextViaPdfjs(buffer: Buffer): Promise<string> {
  const pdfjs = await loadPdfjs();
  // A fresh Uint8Array copy — pdfjs may transfer/detach the underlying buffer.
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false, // no eval / no CSP concerns
    useSystemFonts: false, // never read system font files
    disableFontFace: true, // headless: no font rendering needed for text
  }).promise;

  try {
    const parts: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (typeof item.str === "string") pageText += item.str;
        if (item.hasEOL) pageText += "\n";
      }
      parts.push(pageText);
    }
    return parts.join("\n");
  } finally {
    await doc.destroy();
  }
}

/**
 * Extract text for ONE attachment row and persist it (LOCAL, no network, no OCR).
 * Never throws: a per-file failure is logged, reported to Sentry, and returned as
 * the "error" outcome so a batch keeps going. See the module doc for empty-vs-NULL
 * semantics.
 */
export async function extractTextForAttachment(
  row: AttachmentTextRow,
  options: ExtractionOptions = {}
): Promise<TextExtractionOutcome> {
  const maxSizeBytes = options.maxSizeBytes ?? MAX_EXTRACT_SIZE_BYTES;
  const maxTextLength = options.maxTextLength ?? MAX_TEXT_LENGTH;

  // Guard 1: need a downloaded file.
  if (!row.storage_path) return "ineligible";
  // Guard 2: idempotency — never re-attempt a row that already has a value
  // (extracted text OR an "" attempted-marker). null/undefined = eligible.
  if (row.text_content !== null && row.text_content !== undefined) return "ineligible";
  // Guard 3: only MIME types we can extract locally without OCR / extra parsers.
  if (!isExtractableMime(row.mime_type)) return "ineligible";

  const mime = row.mime_type as string;
  const storagePath = row.storage_path;

  // Open the file ONCE and bind BOTH the size-cap check and the read to that single
  // handle. The handle's fstat (handle.stat) is the check, and handle.readFile reads
  // the exact bytes the handle refers to — so a symlink/replace between "check" and
  // "use" cannot swap what we read (fixes CodeQL js/file-system-race, TOCTOU). There
  // is deliberately NO fs.stat / fs.existsSync / fs.readFile on `storagePath` anywhere
  // in this path; the open handle is the only reference used.
  let fileHandle: FileHandle;
  try {
    fileHandle = await fs.open(storagePath, "r");
  } catch (openErr) {
    // File missing/unreadable (e.g. ENOENT) → a genuine error; leave text_content
    // NULL for a possible retry. Same outcome as the pre-fix missing-file path.
    logService.warn(
      `Attachment file open failed; skipping extraction`,
      SERVICE_NAME,
      { id: row.id, error: openErr instanceof Error ? openErr.message : "Unknown" }
    );
    return "error";
  }

  try {
    // Size cap: don't parse huge files. fstat via the OPEN handle (bound to the exact
    // file we read below). Persist "" so the row drains (attempted).
    const { size: sizeBytes } = await fileHandle.stat();

    if (sizeBytes > maxSizeBytes) {
      logService.info(
        `Attachment exceeds extraction size cap; storing empty text_content`,
        SERVICE_NAME,
        { id: row.id, sizeBytes, maxSizeBytes }
      );
      databaseService.setAttachmentTextContent(row.id, "");
      return "empty";
    }

    // Read from the SAME handle — not a fresh open of the path (no re-check/re-resolve).
    const buffer = await fileHandle.readFile();

    const raw =
      mime === "application/pdf"
        ? await pdfTextExtractor(buffer)
        : buffer.toString("utf-8"); // text/plain, text/csv — verbatim
    const trimmed = (raw ?? "").trim();

    if (trimmed.length === 0) {
      // No text layer (e.g. scanned PDF) / empty file → attempted-no-text marker.
      databaseService.setAttachmentTextContent(row.id, "");
      return "empty";
    }

    const stored =
      trimmed.length > maxTextLength ? trimmed.slice(0, maxTextLength) : trimmed;
    databaseService.setAttachmentTextContent(row.id, stored);
    return "extracted";
  } catch (err) {
    // Corrupt PDF / parse/read failure — record and continue; leave text_content NULL.
    logService.warn(`Text extraction failed for attachment`, SERVICE_NAME, {
      id: row.id,
      mime,
      error: err instanceof Error ? err.message : "Unknown",
    });
    Sentry.captureException(err, {
      tags: {
        service: "attachment-text-extraction",
        operation: "extractTextForAttachment",
      },
    });
    return "error";
  } finally {
    // Always release the handle (success, size-cap, or error). A close failure is not
    // actionable and must not mask the extraction outcome.
    await fileHandle.close().catch(() => {
      /* handle already gone / close race — nothing to do */
    });
  }
}

/**
 * Id-based entrypoint: re-reads the row from the DB (so the current text_content
 * guard is authoritative) then extracts. Used where only an id is on hand.
 * Returns "ineligible" if the row no longer exists.
 */
export async function extractTextForAttachmentId(
  id: string,
  options: ExtractionOptions = {}
): Promise<TextExtractionOutcome> {
  const row = databaseService.getAttachmentTextExtractionRow(id);
  if (!row) return "ineligible";
  return extractTextForAttachment({ id, ...row }, options);
}
