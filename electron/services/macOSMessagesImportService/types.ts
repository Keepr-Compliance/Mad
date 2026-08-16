/**
 * macOS Messages Import Service - Types
 * Type definitions and constants used across the import service sub-modules.
 * Extracted from macOSMessagesImportService.ts for maintainability.
 */

// ============================================
// EXPORTED TYPES (public API)
// ============================================

/**
 * Filter options for message import (TASK-1952)
 * Controls which messages are imported based on date range and count cap
 */
export interface MessageImportFilters {
  lookbackMonths?: number | null; // null = all time
  maxMessages?: number | null; // null = unlimited
  /**
   * BACKLOG-2276: Audit-period start date (ISO string or Date). When set, the
   * import lower bound reaches back to at least this date so a wide audit period
   * is not silently truncated by `lookbackMonths`. Derived from the same source
   * of truth the email fetch uses (transaction started_at/created_at).
   */
  auditPeriodStart?: Date | string | null;
  /**
   * BACKLOG-2743: Import message TEXT ONLY, copying no attachment files. This is
   * the escape hatch offered when the attachment estimate exceeds free disk
   * space — the text of even a very large library is a fraction of the size of
   * its attachments, so "narrower window" and "without attachments" are the two
   * ways through a refusal. Defaults to false (attachments are imported).
   */
  skipAttachments?: boolean;
}

/**
 * BACKLOG-2743: Why an import copied no attachments despite finding some.
 * Present on MacOSImportResult when the pre-flight space check refused.
 */
export interface AttachmentsRefusedForSpace {
  /** Bytes the attachment copy would have needed. */
  estimatedBytes: number;
  /** Bytes actually available to the app (df-equivalent). */
  availableBytes: number;
  /** Attachments that were left uncopied. */
  attachmentCount: number;
}

/**
 * Result of importing macOS messages
 */
export interface MacOSImportResult {
  success: boolean;
  messagesImported: number;
  messagesSkipped: number;
  attachmentsImported: number;
  attachmentsUpdated: number; // TASK-1122: Count of attachments with updated message_id after re-sync
  attachmentsSkipped: number;
  duration: number;
  error?: string;
  /** Total messages available for the date range (before cap) */
  totalAvailable?: number;
  /** True when maxMessages cap truncated results */
  wasCapped?: boolean;
  /**
   * BACKLOG-2743: Set when the pre-flight free-space check refused the
   * attachment copy. The messages themselves ARE imported (this is why the
   * result still reports success) — only the attachment files were skipped.
   */
  attachmentsRefusedForSpace?: AttachmentsRefusedForSpace;
  /** BACKLOG-2743: True when the user chose to import without attachments. */
  attachmentsSkippedByChoice?: boolean;
}

/**
 * Progress callback for import operations
 */
export type ImportProgressCallback = (progress: {
  phase: "querying" | "deleting" | "importing" | "attachments";
  current: number;
  total: number;
  percent: number;
}) => void;

/**
 * Attachment info returned from database (TASK-1012)
 */
export interface MessageAttachment {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

// ============================================
// INTERNAL TYPES (used by import service)
// ============================================

/**
 * Raw message from macOS Messages database
 */
export interface RawMacMessage {
  id: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  date: number; // Mac timestamp (nanoseconds since 2001-01-01)
  is_from_me: number;
  handle_id: string | null;
  service: string | null;
  chat_id: number;
  cache_has_attachments: number;
  /**
   * BACKLOG-2262/2280: Tapback/reaction association type. NULL for normal
   * messages; 2000–2005 = reaction added, 3000–3005 = reaction removed. As of
   * BACKLOG-2280 reaction rows ARE imported (stored as ordinary messages rows
   * with associated_message_type/guid populated) and attached at render time —
   * they are NO LONGER excluded at the SQL level.
   */
  associated_message_type: number | null;
  /**
   * BACKLOG-2280: Apple part-guid of the message a tapback targets
   * (`p:<index>/<guid>` or `bp:<guid>`). NULL for normal messages. Normalized to
   * the bare parent guid (see reactionUtils.normalizeAssociatedGuid) before it is
   * stored in messages.associated_message_guid.
   */
  associated_message_guid: string | null;
}

/**
 * Chat member info from chat_handle_join
 */
export interface ChatMemberRow {
  chat_id: number;
  handle_id: string;
}

/**
 * Chat account info - maps chat to user's identifier (phone/Apple ID)
 */
export interface ChatAccountRow {
  chat_id: number;
  account_login: string | null;
}

/**
 * Raw attachment from macOS Messages database (TASK-1012)
 */
export interface RawMacAttachment {
  attachment_id: number;
  message_id: number;
  message_guid: string;
  guid: string;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number;
  is_outgoing: number;
}

// ============================================
// CHUNKED PROCESSING TYPES (TASK-2047)
// ============================================

/**
 * Options for chunked message processing (TASK-2047)
 * Controls batch size, progress reporting, and cancellation
 */
export interface ChunkedProcessingOptions {
  /** Number of items to process per batch before yielding to event loop (default: 500) */
  batchSize?: number;
  /** Progress callback: (currentBatch, totalBatches) */
  onProgress?: (current: number, total: number) => void;
  /** AbortSignal for clean cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Result from chunked processing (TASK-2047)
 */
export interface ChunkedProcessingResult<T> {
  /** All processed results */
  results: T[];
  /** Whether processing was cancelled before completion */
  wasCancelled: boolean;
  /** Number of batches processed */
  batchesProcessed: number;
  /** Total number of batches */
  totalBatches: number;
}

// ============================================
// CONSTANTS
// ============================================

// Input validation constants
export const MAX_MESSAGE_TEXT_LENGTH = 100000; // 100KB - truncate extremely long messages
export const MAX_HANDLE_LENGTH = 500; // Phone numbers, emails, etc.
export const MAX_GUID_LENGTH = 100; // Message GUID format
export const BATCH_SIZE = 100; // Messages per batch - small batches yield frequently for UI responsiveness
export const DELETE_BATCH_SIZE = 5000; // Messages per delete batch (larger for efficiency)
export const YIELD_INTERVAL = 1; // Yield every batch for UI responsiveness
export const MIN_QUERY_BATCH_SIZE = 10000; // Minimum query batch size

// TASK-2047: Chunked processing constants
export const TEXT_EXTRACTION_YIELD_INTERVAL = 50; // Yield to event loop every N message text extractions
export const PROGRESS_REPORT_INTERVAL = 10; // Report progress every N batches during import phase

// Attachment constants (TASK-1012, expanded TASK-1122 to include videos)
export const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".bmp", ".tiff", ".tif"];
export const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"];
export const SUPPORTED_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".caf"]; // caf = Core Audio Format (iOS voice messages)
export const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".rtf"];
export const ALL_SUPPORTED_EXTENSIONS = [
  ...SUPPORTED_IMAGE_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_DOCUMENT_EXTENSIONS,
];
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB max per attachment (increased for videos)
export const ATTACHMENTS_DIR = "message-attachments"; // Directory name in app data

// BACKLOG-2262/2280: Tapback/reaction association-type band.
// message.associated_message_type in [MIN, MAX] identifies a reaction row
// (2000–2005 = reaction added, 3000–3005 = reaction removed).
//
// BACKLOG-2280 CHANGE: reactions are now IMPORTED (stored as ordinary messages
// rows with associated_message_type/guid populated) and attached to their parent
// at render time, rather than excluded at the SQL level. The band is still used
// to ROUTE reaction rows (bypass the empty-content retention filter) in
// storeMessages and to build the local display-exclusion clauses. Mirrored in
// electron/utils/reactionUtils.ts (REACTION_TYPE_BAND_MIN/MAX).
export const REACTION_ASSOCIATED_TYPE_MIN = 2000;
export const REACTION_ASSOCIATED_TYPE_MAX = 3005;
