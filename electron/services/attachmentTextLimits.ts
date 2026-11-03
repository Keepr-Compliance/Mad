/**
 * Limits shared by the text-layer pass (attachmentTextExtractionService, BACKLOG-2257)
 * and the OCR pass (ocr/attachmentOcrService, BACKLOG-3943). One definition, so the OCR
 * text cap is the pdfjs text cap (founder ruling 2, 2026-10-31).
 */

/** Skip files larger than this (bytes) — extraction cost guard. Default 20MB. */
export const MAX_EXTRACT_SIZE_BYTES = 20 * 1024 * 1024;

/** Truncate stored text to this many characters so the DB does not bloat. ~1MB. */
export const MAX_TEXT_LENGTH = 1_000_000;
