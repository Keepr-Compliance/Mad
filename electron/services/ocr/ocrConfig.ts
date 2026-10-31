/**
 * BACKLOG-3943 — OCR limits and eligibility, in one place.
 *
 * Founder rulings, 2026-10-31 (pm_comments on BACKLOG-3943):
 *   - first 6 pages, 200 dpi, long edge 2600 px, 20 s per page child, 60 s per file;
 *     text cap = the pdfjs text cap (attachmentTextLimits.MAX_TEXT_LENGTH).
 *   - after each sync, OCR up to 25 older files; paused on battery.
 *   - PDF only in this build. The list is a list so image types can be added later.
 *   - Vision accurate level only (see visionOcrScript.ts).
 */

/** MIME types the OCR pass reads. PDF only in this build (founder ruling 5). */
export const OCR_MIME_TYPES: readonly string[] = ["application/pdf"];

export function isOcrEligibleMime(mime: string | null | undefined): boolean {
  return !!mime && OCR_MIME_TYPES.includes(mime);
}

/** Pages OCR'd per file: the first N. Later pages are not read; pagesTotal records them. */
export const OCR_PAGE_CAP = 6;

/** Raster resolution handed to the recogniser. */
export const OCR_DPI = 200;

/** Long edge clamp in pixels (an image-only PDF can carry a page box in pixels). */
export const OCR_MAX_LONG_EDGE_PX = 2600;

/** One page child is stopped after this long. */
export const OCR_PAGE_TIMEOUT_MS = 20_000;

/** No new page child starts once a file has used this much time. */
export const OCR_FILE_BUDGET_MS = 60_000;

/** A page child's stdout is capped at this many bytes (a page measured <= 7 KB). */
export const OCR_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** A file whose OCR failed in a retryable way is tried at most this many times. */
export const OCR_MAX_ATTEMPTS = 3;

/** In-memory queue length. Overflow stays OCR-pending in the database for a later drain. */
export const OCR_QUEUE_CAP = 200;

/** Older OCR-pending files queued after each sync (founder ruling 3). */
export const OCR_DRAIN_BATCH = 25;
