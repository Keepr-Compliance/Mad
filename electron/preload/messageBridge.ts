/**
 * Message Bridge
 * iMessage conversation methods for macOS
 */

import { ipcRenderer } from "electron";

/**
 * Progress event from macOS message import (TASK-1710)
 * Enhanced with querying phase, elapsed time tracking for ETA calculation
 */
export interface ImportProgress {
  phase: "querying" | "deleting" | "importing" | "attachments";
  current: number;
  total: number;
  percent: number;
  /** Milliseconds elapsed since import started */
  elapsedMs: number;
}

/**
 * Result of macOS message import
 */
export interface MacOSImportResult {
  success: boolean;
  messagesImported: number;
  messagesSkipped: number;
  attachmentsImported: number;
  attachmentsSkipped: number;
  duration: number;
  error?: string;
}

/**
 * Attachment info for display (TASK-1012)
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

export const messageBridge = {
  /**
   * Gets conversations — from macOS chat.db or local messages table
   * depending on the user's phone type (BACKLOG-1470).
   * @param userId - Optional user ID for phone type lookup
   * @returns List of conversations
   */
  getConversations: (userId?: string) => ipcRenderer.invoke("get-conversations", userId),

  /**
   * Gets messages for a specific chat
   * @param chatId - Chat ID to get messages for
   * @returns List of messages
   */
  getMessages: (chatId: string) => ipcRenderer.invoke("get-messages", chatId),

  /**
   * Import messages from macOS Messages app into the app database
   * This enables linking messages to transactions on macOS
   * @param userId - User ID to associate messages with
   * @param forceReimport - If true, delete existing messages and re-import all
   * @returns Import result with counts
   */
  importMacOSMessages: (userId: string, forceReimport = false): Promise<MacOSImportResult> =>
    ipcRenderer.invoke("messages:import-macos", userId, forceReimport),

  /**
   * Get count of messages available for import from macOS Messages
   * @returns Count of available messages
   */
  getImportCount: (filters?: { lookbackMonths?: number | null; maxMessages?: number | null }): Promise<{ success: boolean; count?: number; filteredCount?: number; error?: string }> =>
    ipcRenderer.invoke("messages:get-import-count", filters),

  /**
   * Listen for import progress updates
   * @param callback - Called with progress updates during import
   * @returns Cleanup function to remove listener
   */
  onImportProgress: (callback: (progress: ImportProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) => {
      callback(progress);
    };
    ipcRenderer.on("messages:import-progress", handler);
    return () => {
      ipcRenderer.removeListener("messages:import-progress", handler);
    };
  },

  /**
   * Get attachments for a message with base64 data (TASK-1012)
   * @param messageId - Message ID to get attachments for
   * @returns Array of attachments with base64 data
   */
  getMessageAttachments: (messageId: string): Promise<MessageAttachmentInfo[]> =>
    ipcRenderer.invoke("messages:get-attachments", messageId),

  /**
   * Get attachments for multiple messages at once (TASK-1012)
   * @param messageIds - Array of message IDs
   * @returns Map of message ID to attachments
   */
  getMessageAttachmentsBatch: (messageIds: string[]): Promise<Record<string, MessageAttachmentInfo[]>> =>
    ipcRenderer.invoke("messages:get-attachments-batch", messageIds),

  /**
   * Repair attachment message_id mappings without full re-import.
   * @returns Stats on repaired/orphaned attachments
   */
  repairAttachments: (): Promise<{
    total: number;
    repaired: number;
    orphaned: number;
    alreadyCorrect: number;
  }> => ipcRenderer.invoke("messages:repair-attachments"),

  /**
   * Cancel the current import operation (TASK-1710)
   * Gracefully stops the import, preserving partial data
   */
  cancelImport: (): void => {
    ipcRenderer.send("messages:import-cancel");
  },

  /**
   * Get macOS messages import status (count and last import time)
   * @param userId - User ID to get status for
   * @returns Import status (messageCount, lastImportAt)
   */
  getImportStatus: (
    userId: string
  ): Promise<{
    success: boolean;
    messageCount?: number;
    lastImportAt?: string | null;
    error?: string;
  }> => ipcRenderer.invoke("messages:getImportStatus", userId),
};
