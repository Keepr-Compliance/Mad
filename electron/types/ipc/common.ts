/**
 * Common/shared IPC types used across multiple domains
 */

import type { Contact, Transaction } from "../models";

// ============================================
// FOLDER EXPORT TYPES
// ============================================

/**
 * Progress updates emitted during folder export.
 * Shared across main process, preload bridge, and renderer.
 */
export interface FolderExportProgress {
  stage:
    | "preparing"
    | "summary"
    | "emails"
    | "texts"
    | "attachments"
    | "complete";
  current: number;
  total: number;
  message: string;
}

// ============================================
// SHARED IPC TYPES
// ============================================

/**
 * Export progress event data
 */
export interface ExportProgress {
  current: number;
  total: number;
  contactName?: string;
  phase?: "preparing" | "exporting" | "finishing";
}

/**
 * Auto-update info
 */
export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

/**
 * Download progress info
 */
export interface UpdateProgress {
  percent: number;
  bytesPerSecond?: number;
  total?: number;
  transferred?: number;
}

/**
 * Conversation summary for iMessage/SMS
 */
export interface ConversationSummary {
  id: string;
  name: string;
  directChatCount: number;
  groupChatCount: number;
  directMessageCount: number;
  groupMessageCount: number;
  lastMessageDate: Date;
}

/**
 * Message attachment info for display (TASK-1012)
 */
export interface MessageAttachmentInfo {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  /** Base64-encoded file content for inline display */
  data: string | null;
}

/**
 * BACKLOG-3763: attachment metadata the conversation view receives. No file
 * bytes — each image's bytes are requested on demand by attachment id.
 */
export type MessageAttachmentMeta = Omit<MessageAttachmentInfo, "data">;

/** Why `messages:get-attachment-data` did not return bytes (BACKLOG-3763). */
export type TextAttachmentDataRefusal =
  | "invalid_id"
  | "not_signed_in"
  | "not_found"
  | "outside_app_data"
  | "missing_file"
  | "too_large";

/** Reply of `messages:get-attachment-data` (BACKLOG-3763). */
export type TextAttachmentDataResult =
  | { success: true; data: string; mime_type: string | null }
  | { success: false; reason: TextAttachmentDataRefusal };

// ============================================
// IPC RESULT TYPE GUARDS
// ============================================

/**
 * Generic IPC result interface for consistent response handling
 */
export interface IpcResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Type guard to check if an IPC result is successful
 */
export function isIpcSuccess<T>(
  result: IpcResult<T>,
): result is IpcResult<T> & { success: true; data: T } {
  return result.success === true && result.data !== undefined;
}

/**
 * Type guard to check if an IPC result has an error
 */
export function isIpcError<T>(
  result: IpcResult<T>,
): result is IpcResult<T> & { success: false; error: string } {
  return result.success === false && typeof result.error === "string";
}

/**
 * Type guard for WindowApi result patterns (success + optional data)
 */
export function hasSuccessResult(
  result: unknown,
): result is { success: boolean; error?: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    typeof (result as { success: unknown }).success === "boolean"
  );
}

/**
 * Type guard for transaction results
 */
export function isTransactionResult(
  result: unknown,
): result is { success: boolean; transaction?: Transaction; error?: string } {
  if (!hasSuccessResult(result)) return false;
  const r = result as { transaction?: unknown };
  return r.transaction === undefined || typeof r.transaction === "object";
}

/**
 * Type guard for contact results
 */
export function isContactResult(
  result: unknown,
): result is { success: boolean; contact?: Contact; error?: string } {
  if (!hasSuccessResult(result)) return false;
  const r = result as { contact?: unknown };
  return r.contact === undefined || typeof r.contact === "object";
}

/**
 * Type guard for contacts array results
 */
export function isContactsResult(
  result: unknown,
): result is { success: boolean; contacts?: Contact[]; error?: string } {
  if (!hasSuccessResult(result)) return false;
  const r = result as { contacts?: unknown };
  return r.contacts === undefined || Array.isArray(r.contacts);
}
