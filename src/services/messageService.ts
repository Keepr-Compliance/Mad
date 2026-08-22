/**
 * Message Service
 *
 * Service abstraction for message-related API calls (iMessage/macOS Messages).
 * Centralizes all window.api.messages calls and provides type-safe wrappers.
 *
 * Type signatures match electron/types/ipc.ts MainAPI.messages exactly.
 */

import { getErrorMessage } from "./index";
// BACKLOG-2743: type-only import of the shared estimate shapes. Type-only is the
// ONLY direction that is safe across the renderer/main boundary — a value import
// from electron/ would be parsed as JavaScript by Vite and break the build.
import type {
  MessageImportCountFilters,
  MessageImportCountResult,
} from "@electron/types/ipc/window-api-messages";

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
  /**
   * BACKLOG-2748: the user cancelled the run; counts are partial, not failed.
   * Branch on this rather than on the `error` text.
   */
  cancelled?: boolean;
  /**
   * BACKLOG-2775: the cancelled run was a FORCE re-import and it rolled back —
   * counts are 0 and the store is untouched.
   *
   * This interface is a hand-maintained copy of the IPC result shape, so a flag
   * absent here is invisible to every caller that goes through this service
   * even though the main process sent it. Both cancel discriminators are
   * carried so a future caller cannot mistake a cancelled run for a clean one.
   */
  rolledBack?: boolean;
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

  /*
   * BACKLOG-2772: `getImportCount` and `importMacOSMessages` were DELETED from
   * this service, not updated for the new signatures.
   *
   * Both were renderer-side wrappers around the preload bridge with ZERO
   * production callers — the estimate is requested by
   * `MacOSMessagesImportSettings` straight from `window.api.messages`, and the
   * import is started by `SyncOrchestratorService`'s registered sync function,
   * which is the only path that produces a queue item. Keeping a second,
   * queue-less way to start an import is how an uncancellable run gets
   * reintroduced by someone reaching for the obvious-looking helper.
   *
   * Their absence is enforced by the compiler rather than by this comment: the
   * bridge now requires a userId, so any resurrection has to be written against
   * the current wire.
   */

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
