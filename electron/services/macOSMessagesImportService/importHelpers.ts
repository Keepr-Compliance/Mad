/**
 * macOS Messages Import Service - Helper Functions
 * Standalone utility functions used by the import service.
 * Extracted from macOSMessagesImportService.ts for maintainability.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import cliProgress from "cli-progress";

import type {
  ChunkedProcessingOptions,
  ChunkedProcessingResult,
} from "./types";

import {
  MAX_GUID_LENGTH,
  ALL_SUPPORTED_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  MIN_QUERY_BATCH_SIZE,
  REACTION_ASSOCIATED_TYPE_MIN,
  REACTION_ASSOCIATED_TYPE_MAX,
} from "./types";
import { MAC_EPOCH } from "../../constants";
import type { MessageImportFilters } from "./types";

/**
 * Nanoseconds per millisecond — macOS Messages stores dates as nanoseconds
 * since the Apple epoch (2001-01-01).
 */
const NANOS_PER_MS = 1_000_000;

/**
 * BACKLOG-2276: Compute the Apple-epoch (nanoseconds since 2001-01-01) lower-bound
 * cutoff for the macOS Messages import.
 *
 * Correctness rule (audit completeness):
 *  - When `auditPeriodStart` is provided, the import must reach back at least that
 *    far so a wide audit period is not silently truncated.
 *  - When `lookbackMonths` is also set, we take the EARLIER of the two cutoffs, so
 *    we never omit messages an audit needs AND never regress below the user's
 *    explicit lookback preference.
 *  - Returns `null` (no date filter → import everything) when neither is set.
 *
 * @param filters - Import filters (lookbackMonths and/or auditPeriodStart)
 * @param now - Reference "now" (injectable for deterministic tests)
 * @returns Apple-epoch nanosecond cutoff, or null when no date filter applies
 */
export function computeImportCutoffNano(
  filters:
    | Pick<MessageImportFilters, "lookbackMonths" | "auditPeriodStart">
    | undefined,
  now: Date = new Date()
): number | null {
  const cutoffs: number[] = [];

  if (filters?.lookbackMonths && filters.lookbackMonths > 0) {
    const cutoffDate = new Date(now.getTime());
    cutoffDate.setMonth(cutoffDate.getMonth() - filters.lookbackMonths);
    cutoffs.push((cutoffDate.getTime() - MAC_EPOCH) * NANOS_PER_MS);
  }

  if (filters?.auditPeriodStart) {
    const auditDate = new Date(filters.auditPeriodStart);
    if (!isNaN(auditDate.getTime())) {
      cutoffs.push((auditDate.getTime() - MAC_EPOCH) * NANOS_PER_MS);
    }
  }

  if (cutoffs.length === 0) {
    return null;
  }

  // Earlier date = smaller nanosecond value = reaches further back in time.
  return Math.min(...cutoffs);
}

/**
 * BACKLOG-2262: Decide whether an imported message has enough to be stored.
 *
 * A message is retained when it has real (non-whitespace) text OR carries an
 * attachment. Caption-less media (empty decoded text + `cache_has_attachments`)
 * MUST be retained so its attachment can link to a stored parent message.
 *
 * This replaces the previous fragile policy of dropping any message whose decoded
 * text started with "[", which discarded caption-less media, orphaned their
 * attachments, and also dropped legitimate messages like "[link]".
 *
 * @param text - Decoded message text ("" when nothing could be decoded)
 * @param cacheHasAttachments - macOS `message.cache_has_attachments` (>0 = has attachment)
 * @returns True when the message should be stored
 */
export function shouldRetainMessageContent(
  text: string | null | undefined,
  cacheHasAttachments: number
): boolean {
  const hasText = !!(text && text.trim().length > 0);
  const hasAttachment = cacheHasAttachments > 0;
  return hasText || hasAttachment;
}

/**
 * BACKLOG-2262/2280: True when a macOS `message.associated_message_type` value
 * identifies a tapback/reaction row (2000–2005 added, 3000–3005 removed).
 *
 * As of BACKLOG-2280 reaction rows are IMPORTED rather than excluded; this
 * predicate is used at import time to ROUTE reaction rows — they bypass the
 * empty-content retention filter and are tagged with their association
 * type/guid in storeMessages.
 *
 * @param associatedMessageType - The message's associated_message_type (nullable)
 * @returns True when the row is a tapback/reaction row
 */
export function isReactionAssociationType(
  associatedMessageType: number | null | undefined
): boolean {
  if (associatedMessageType === null || associatedMessageType === undefined) {
    return false;
  }
  return (
    associatedMessageType >= REACTION_ASSOCIATED_TYPE_MIN &&
    associatedMessageType <= REACTION_ASSOCIATED_TYPE_MAX
  );
}

/**
 * Create a tqdm-style progress bar for console output
 */
export function createProgressBar(label: string): cliProgress.SingleBar {
  return new cliProgress.SingleBar({
    format: `${label} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s`,
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
    clearOnComplete: true,
  }, cliProgress.Presets.shades_classic);
}

/**
 * Calculate dynamic query batch size based on total message count.
 * Larger imports use larger batches to reduce overhead from yielding/progress updates.
 *
 * - Under 100K messages: 10% of total (min 10K)
 * - 100K - 200K messages: 15% of total
 * - Over 200K messages: 20% of total
 */
export function calculateQueryBatchSize(totalMessages: number): number {
  let percentage: number;
  if (totalMessages < 100000) {
    percentage = 0.10; // 10%
  } else if (totalMessages <= 200000) {
    percentage = 0.15; // 15%
  } else {
    percentage = 0.20; // 20%
  }

  const calculated = Math.floor(totalMessages * percentage);
  return Math.max(calculated, MIN_QUERY_BATCH_SIZE);
}

/**
 * Yield to event loop - allows UI to remain responsive
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Sanitize and validate a string field
 */
export function sanitizeString(
  value: string | null | undefined,
  maxLength: number,
  defaultValue = ""
): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  const str = String(value);
  return str.length > maxLength ? str.substring(0, maxLength) : str;
}

/**
 * Validate a GUID/external ID format
 */
export function isValidGuid(guid: string | null | undefined): boolean {
  if (!guid || typeof guid !== "string") return false;
  // Allow alphanumeric, hyphens, underscores, colons, and dots
  // macOS message GUIDs can be various formats
  return (
    guid.length > 0 && guid.length <= MAX_GUID_LENGTH && /^[\w\-:.]+$/.test(guid)
  );
}

/**
 * Check if a file extension is a supported media type
 * TASK-1122: Expanded to include videos, audio, and documents
 */
export function isSupportedMediaType(filename: string | null): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return ALL_SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Check if a file extension is a supported image type (for inline display)
 */
export function isSupportedImageType(filename: string | null): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type from filename
 * TASK-1122: Expanded to support videos, audio, and documents
 */
export function getMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Images
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    // Videos
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    // Audio
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".caf": "audio/x-caf",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".rtf": "application/rtf",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Generate a content hash for deduplication (async to avoid blocking)
 */
export async function generateContentHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

/**
 * Process items in chunks, yielding to the event loop between batches
 * so the UI thread stays responsive during large imports. (TASK-2047)
 *
 * This is the core non-blocking processing primitive. It takes an array of items,
 * processes them in configurable batch sizes, and yields to the event loop between
 * each batch via setImmediate. This prevents the main Electron thread from freezing
 * during imports of 10K+ messages.
 *
 * @param items - Array of items to process
 * @param processBatch - Async function to process a batch of items, returns results
 * @param options - Chunked processing options (batchSize, onProgress, abortSignal)
 * @returns ChunkedProcessingResult with all results and cancellation status
 */
export async function processItemsInChunks<TInput, TOutput>(
  items: TInput[],
  processBatch: (batch: TInput[]) => Promise<TOutput[]>,
  options: ChunkedProcessingOptions = {},
): Promise<ChunkedProcessingResult<TOutput>> {
  const batchSize = options.batchSize ?? 500;
  const results: TOutput[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);
  let batchesProcessed = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    // Check for cancellation via AbortSignal
    if (options.abortSignal?.aborted) {
      return {
        results,
        wasCancelled: true,
        batchesProcessed,
        totalBatches,
      };
    }

    const batch = items.slice(i, i + batchSize);
    const processed = await processBatch(batch);

    // Use push loop instead of spread to avoid stack overflow with large result sets
    for (let j = 0; j < processed.length; j++) {
      results.push(processed[j]);
    }

    batchesProcessed++;

    // Yield to event loop -- allows UI to update and prevents freeze
    await yieldToEventLoop();

    // Emit progress
    options.onProgress?.(batchesProcessed, totalBatches);
  }

  return {
    results,
    wasCancelled: false,
    batchesProcessed,
    totalBatches,
  };
}
