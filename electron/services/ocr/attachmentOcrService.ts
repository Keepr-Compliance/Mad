/**
 * BACKLOG-3943 — OCR for an image-only PDF attachment: a SECOND pass on the same row.
 *
 * The text-layer pass (attachmentTextExtractionService) stores "" when a PDF has no text
 * layer. This pass reads that row's bytes (decrypted in memory), runs one OCR child per
 * page for the first OCR_PAGE_CAP pages, and writes the recognised text into the same
 * `text_content` column, so the deal search (BACKLOG-3942) finds words that exist only in
 * the scan. No migration: state and provenance go into `attachments.analysis_metadata`
 * (founder ruling 1, 2026-10-31).
 *
 * ─── States (text_content / analysis_metadata) ────────────────────────────────────────
 *   ""   / NULL                               OCR pending (also every pre-3943 "" row)
 *   text / {textSource:"ocr", result:"text"}  OCR text, with engine/pages/truncation
 *   ""   / {textSource:"ocr", result:"empty"} OCR ran, nothing readable — permanent
 *   ""   / {textSource:"none", reason:"over-cap"}   file too large — permanent
 *   ""   / {textSource:"none", reason:"unreadable"} not a PDF/image — permanent
 *   ""   / {textSource:"none", reason:"error", retryable:true, attempts:n}
 *            a timeout / crash / exit / read failure; pending again until n = OCR_MAX_ATTEMPTS
 *
 * ─── Writes are compare-and-set (SR plan review R1) ───────────────────────────────────
 * OCR takes seconds. The write lands only if the row still holds "" and the same metadata
 * value this pass read; otherwise nothing is written and the outcome is "row-changed".
 *
 * ─── Quit ─────────────────────────────────────────────────────────────────────────────
 * When the queue is stopped mid-file the child is stopped and NOTHING is written, so the
 * row stays as it was and is picked up again after the next sync.
 *
 * Never logs document text: counts, page numbers and milliseconds only.
 */
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import * as Sentry from "@sentry/electron/main";
import databaseService from "../databaseService";
import logService from "../logService";
import { readOpenAttachment, statOpenAttachment } from "../atRest/attachmentReader";
import { MAX_EXTRACT_SIZE_BYTES, MAX_TEXT_LENGTH } from "../attachmentTextLimits";
import {
  OCR_DPI,
  OCR_FILE_BUDGET_MS,
  OCR_MAX_ATTEMPTS,
  OCR_MAX_LONG_EDGE_PX,
  OCR_MAX_STDOUT_BYTES,
  OCR_PAGE_CAP,
  OCR_PAGE_TIMEOUT_MS,
  isOcrEligibleMime,
} from "./ocrConfig";
import {
  OCR_ENGINE,
  isOcrSupportedPlatform,
  runOcrPage,
  type OcrPageFailure,
  type OcrPageResult,
} from "./ocrChild";

const SERVICE_NAME = "AttachmentOcr";

/** What one OCR run did to the row. */
export type OcrOutcome =
  | "text" // OCR text stored
  | "empty" // OCR ran, nothing readable; parked
  | "over-cap" // parked
  | "unreadable" // parked
  | "retryable-error" // attempts += 1
  | "ineligible" // guard failed; nothing written
  | "row-changed" // compare-and-set lost; nothing written
  | "stopped" // queue stopped mid-file; nothing written
  | "unsupported"; // no OCR engine on this platform in this build; nothing written

export interface OcrMetadataText {
  textSource: "ocr";
  result: "text" | "empty";
  engine: string;
  level: "accurate";
  pagesOcr: number;
  pagesFailed: number;
  pagesTotal: number | null;
  truncated: boolean;
  budgetExceeded: boolean;
  at: string;
}
export interface OcrMetadataParked {
  textSource: "none";
  reason: "over-cap" | "unreadable";
  at: string;
}
export interface OcrMetadataError {
  textSource: "none";
  reason: "error";
  retryable: true;
  attempts: number;
  lastFailure: OcrPageFailure | "read";
  at: string;
}
export type OcrMetadata = OcrMetadataText | OcrMetadataParked | OcrMetadataError;

export interface OcrRunOptions {
  pageCap?: number;
  pageTimeoutMs?: number;
  fileBudgetMs?: number;
  maxSizeBytes?: number;
  maxTextLength?: number;
  maxAttempts?: number;
  /** True once the queue has been stopped (app quit). Checked between pages. */
  isStopped?: () => boolean;
  /** TEST-ONLY clock. */
  now?: () => number;
  /** TEST-ONLY platform override. */
  platform?: NodeJS.Platform;
}

/** Parse a stored metadata value; undefined when it is not ours / not JSON. */
function parseMetadata(raw: string | null): OcrMetadata | null | undefined {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as OcrMetadata) : undefined;
  } catch {
    return undefined;
  }
}

function priorAttempts(meta: OcrMetadata | null): number {
  return meta && meta.textSource === "none" && meta.reason === "error" ? meta.attempts : 0;
}

/**
 * OCR one attachment by id and persist the result (compare-and-set). Never throws.
 */
export async function ocrAttachmentText(
  id: string,
  options: OcrRunOptions = {},
): Promise<OcrOutcome> {
  const pageCap = options.pageCap ?? OCR_PAGE_CAP;
  const pageTimeoutMs = options.pageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
  const fileBudgetMs = options.fileBudgetMs ?? OCR_FILE_BUDGET_MS;
  const maxSizeBytes = options.maxSizeBytes ?? MAX_EXTRACT_SIZE_BYTES;
  const maxTextLength = options.maxTextLength ?? MAX_TEXT_LENGTH;
  const maxAttempts = options.maxAttempts ?? OCR_MAX_ATTEMPTS;
  const isStopped = options.isStopped ?? (() => false);
  const now = options.now ?? Date.now;

  if (!isOcrSupportedPlatform(options.platform)) return "unsupported";

  const row = databaseService.getAttachmentOcrRow(id);
  if (!row || !row.storage_path) return "ineligible";
  if (row.text_content !== "") return "ineligible";
  if (!isOcrEligibleMime(row.mime_type)) return "ineligible";
  const expectedMetadata = row.analysis_metadata;
  const meta = parseMetadata(expectedMetadata);
  if (meta === undefined) return "ineligible"; // a value we did not write: leave it alone
  if (meta !== null) {
    const retryable = meta.textSource === "none" && meta.reason === "error" && meta.retryable === true;
    if (!retryable || priorAttempts(meta) >= maxAttempts) return "ineligible";
  }
  const attempts = priorAttempts(meta) + 1;
  const at = (): string => new Date(now()).toISOString();

  /** The single write path. Returns the outcome to report. */
  const write = (text: string, metadata: OcrMetadata, outcome: OcrOutcome): OcrOutcome => {
    if (isStopped()) return "stopped"; // quit has started: no write after it
    const changes = databaseService.compareAndSetAttachmentOcrResult(
      id,
      text,
      JSON.stringify(metadata),
      expectedMetadata,
    );
    if (changes === 0) {
      logService.info("OCR result not written: the row changed while OCR ran", SERVICE_NAME, { id });
      return "row-changed";
    }
    return outcome;
  };
  const writeError = (lastFailure: OcrPageFailure | "read"): OcrOutcome =>
    write("", { textSource: "none", reason: "error", retryable: true, attempts, lastFailure, at: at() }, "retryable-error");

  let handle: FileHandle;
  try {
    handle = await fs.open(row.storage_path, "r");
  } catch {
    logService.warn("OCR: attachment file could not be opened", SERVICE_NAME, { id, attempts });
    return writeError("read");
  }

  let buffer: Buffer;
  try {
    const { size } = await statOpenAttachment(row.storage_path, handle);
    if (size > maxSizeBytes) {
      return write("", { textSource: "none", reason: "over-cap", at: at() }, "over-cap");
    }
    buffer = await readOpenAttachment(row.storage_path, handle);
  } catch (err) {
    logService.warn("OCR: attachment read failed", SERVICE_NAME, {
      id,
      attempts,
      error: err instanceof Error ? err.message : "Unknown",
    });
    Sentry.captureException(err, { tags: { service: "attachment-ocr", operation: "read" } });
    return writeError("read");
  } finally {
    await handle.close().catch(() => {
      /* nothing to do */
    });
  }

  const pageOpts = (remainingMs: number) => ({
    dpi: OCR_DPI,
    maxLongEdgePx: OCR_MAX_LONG_EDGE_PX,
    timeoutMs: Math.max(1, Math.min(pageTimeoutMs, remainingMs)),
    maxStdoutBytes: OCR_MAX_STDOUT_BYTES,
  });

  const started = now();
  let pagesTotal: number | null = null;
  let pagesOcr = 0;
  let pagesFailed = 0;
  let budgetExceeded = false;
  let lastFailure: OcrPageFailure | null = null;
  const pageTexts: string[] = [];

  for (let p = 0; p < Math.min(pagesTotal ?? pageCap, pageCap); p++) {
    if (isStopped()) return "stopped";
    let remaining = fileBudgetMs - (now() - started);
    if (remaining <= 0) {
      budgetExceeded = true;
      break;
    }
    let result: OcrPageResult = await runOcrPage(buffer, p, pageOpts(remaining));
    if (!result.ok && result.failure !== "unreadable" && result.failure !== "stopped" && !isStopped()) {
      // One retry per page (a crash in the child is the observed failure, not a hang).
      remaining = fileBudgetMs - (now() - started);
      if (remaining > 0) {
        logService.info("OCR page failed; retrying once", SERVICE_NAME, { id, page: p + 1, failure: result.failure });
        result = await runOcrPage(buffer, p, pageOpts(remaining));
      }
    }
    if (result.pagesTotal !== null) pagesTotal = result.pagesTotal;
    if (!result.ok) {
      if (result.failure === "stopped" || isStopped()) return "stopped";
      if (result.failure === "unreadable") {
        return write("", { textSource: "none", reason: "unreadable", at: at() }, "unreadable");
      }
      pagesFailed++;
      lastFailure = result.failure;
      logService.warn("OCR page skipped after retry", SERVICE_NAME, { id, page: p + 1, failure: result.failure });
      continue;
    }
    pagesOcr++;
    pageTexts.push(result.lines.join("\n"));
  }
  if (isStopped()) return "stopped";

  const ms = now() - started;
  if (pagesOcr === 0 && lastFailure !== null) {
    logService.warn("OCR failed on every page tried", SERVICE_NAME, { id, pagesFailed, attempts, ms });
    return writeError(lastFailure);
  }

  const trimmed = pageTexts.join("\n").trim();
  if (trimmed.length === 0 && lastFailure !== null) {
    // Some pages failed and the ones that ran were blank: worth another attempt.
    return writeError(lastFailure);
  }
  const truncated = trimmed.length > maxTextLength;
  const text = truncated ? trimmed.slice(0, maxTextLength) : trimmed;
  const metadata: OcrMetadataText = {
    textSource: "ocr",
    result: text.length > 0 ? "text" : "empty",
    engine: OCR_ENGINE,
    level: "accurate",
    pagesOcr,
    pagesFailed,
    pagesTotal,
    truncated,
    budgetExceeded,
    at: at(),
  };
  logService.info("OCR complete", SERVICE_NAME, {
    id,
    result: metadata.result,
    chars: text.length,
    pagesOcr,
    pagesFailed,
    pagesTotal,
    truncated,
    budgetExceeded,
    ms,
  });
  return write(text, metadata, metadata.result === "text" ? "text" : "empty");
}
