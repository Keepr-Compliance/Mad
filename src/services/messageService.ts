/**
 * Message Service
 *
 * Service abstraction for message-related API calls (iMessage/macOS Messages).
 * Centralizes all window.api.messages calls and provides type-safe wrappers.
 *
 * Type signatures match electron/types/ipc.ts MainAPI.messages exactly.
 */

import { getErrorMessage } from "./index";

/**
 * Message import status (from getImportStatus)
 */
export interface MessageImportStatus {
  success: boolean;
  messageCount?: number;
  lastImportAt?: string | null;
  error?: string;
}

/**
 * macOS import result (matches ipc.ts importMacOSMessages return type)
 */
export interface MacOSImportServiceResult {
  success: boolean;
  messagesImported: number;
  messagesSkipped: number;
  attachmentsImported: number;
  attachmentsSkipped: number;
  duration: number;
  error?: string;
  totalAvailable?: number;
  wasCapped?: boolean;
}

/**
 * Message service - wraps window.api.messages methods
 */
export const messageService = {
  /**
   * Get conversations from macOS Messages.
   * Returns conversations as ConversationSummary[] (no arguments).
   */
  async getConversations(): Promise<{
    success: boolean;
    conversations?: unknown[];
    error?: string;
  }> {
    try {
      if (!window.api.messages) {
        return { success: false, error: "Messages API not available" };
      }
      return await window.api.messages.getConversations();
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get count of messages available for import from macOS Messages.
   * Accepts optional filters for lookback period and max count.
   */
  async getImportCount(
    filters?: { lookbackMonths?: number | null; maxMessages?: number | null }
  ): Promise<{ success: boolean; count?: number; filteredCount?: number; error?: string }> {
    try {
      if (!window.api.messages) {
        return { success: false, error: "Messages API not available" };
      }
      return await window.api.messages.getImportCount(filters);
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get macOS messages import status (count and last import time).
   * Requires userId parameter.
   */
  async getImportStatus(userId: string): Promise<MessageImportStatus> {
    try {
      if (!window.api.messages) {
        return { success: false, error: "Messages API not available" };
      }
      return await window.api.messages.getImportStatus(userId);
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Import macOS Messages for a user.
   * Returns detailed import result with counts and duration.
   */
  async importMacOSMessages(userId: string): Promise<MacOSImportServiceResult> {
    try {
      if (!window.api.messages) {
        return {
          success: false,
          messagesImported: 0,
          messagesSkipped: 0,
          attachmentsImported: 0,
          attachmentsSkipped: 0,
          duration: 0,
          error: "Messages API not available",
        };
      }
      return await window.api.messages.importMacOSMessages(userId);
    } catch (error) {
      return {
        success: false,
        messagesImported: 0,
        messagesSkipped: 0,
        attachmentsImported: 0,
        attachmentsSkipped: 0,
        duration: 0,
        error: getErrorMessage(error),
      };
    }
  },

  /**
   * Get attachments for multiple messages at once.
   * Returns a map of messageId -> attachment info arrays.
   */
  async getMessageAttachmentsBatch(
    messageIds: string[]
  ): Promise<Record<string, unknown[]>> {
    try {
      if (!window.api.messages) {
        return {};
      }
      return await window.api.messages.getMessageAttachmentsBatch(messageIds);
    } catch {
      return {};
    }
  },

  /**
   * Register callback for import progress events.
   * Callback receives progress with phase, current, total, percent.
   */
  onImportProgress(
    callback: (progress: {
      phase: "deleting" | "importing" | "attachments";
      current: number;
      total: number;
      percent: number;
    }) => void
  ): (() => void) | undefined {
    if (!window.api.messages) return undefined;
    return window.api.messages.onImportProgress(callback);
  },
};
