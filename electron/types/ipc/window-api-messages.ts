/**
 * WindowApi Messages & Outlook sub-interfaces
 * iMessage/SMS and Outlook integration methods
 */

import type { ConversationSummary, MessageAttachmentInfo } from "./common";

/**
 * Messages API (iMessage/SMS - migrated from window.electron)
 */
export interface WindowApiMessages {
  /** Get conversations — routes to macOS chat.db or local messages table based on phone type (BACKLOG-1470) */
  getConversations: (userId?: string) => Promise<{
    success: boolean;
    conversations?: ConversationSummary[];
    error?: string;
  }>;
  getMessages: (chatId: string) => Promise<unknown[]>;
  /** Import messages from macOS Messages app into the app database (macOS only) */
  importMacOSMessages: (userId: string) => Promise<{
    success: boolean;
    messagesImported: number;
    messagesSkipped: number;
    attachmentsImported: number;
    attachmentsSkipped: number;
    duration: number;
    error?: string;
    totalAvailable?: number;
    wasCapped?: boolean;
  }>;
  /** Get count of messages available for import from macOS Messages */
  getImportCount: (filters?: { lookbackMonths?: number | null; maxMessages?: number | null }) => Promise<{ success: boolean; count?: number; filteredCount?: number; error?: string }>;
  /** Listen for import progress updates */
  onImportProgress: (callback: (progress: { phase: "deleting" | "importing" | "attachments"; current: number; total: number; percent: number }) => void) => () => void;
  /** Get attachments for a message with base64 data (TASK-1012) */
  getMessageAttachments: (messageId: string) => Promise<MessageAttachmentInfo[]>;
  /** Get attachments for multiple messages at once (TASK-1012) */
  getMessageAttachmentsBatch: (messageIds: string[]) => Promise<Record<string, MessageAttachmentInfo[]>>;
  /** Repair attachment message_id mappings without full re-import */
  repairAttachments: () => Promise<{
    total: number;
    repaired: number;
    orphaned: number;
    alreadyCorrect: number;
  }>;
  /** Get macOS messages import status (count and last import time) */
  getImportStatus: (userId: string) => Promise<{
    success: boolean;
    messageCount?: number;
    lastImportAt?: string | null;
    error?: string;
  }>;
}

/**
 * Outlook integration methods (migrated from window.electron)
 */
export interface WindowApiOutlook {
  initialize: () => Promise<{ success: boolean; error?: string }>;
  authenticate: () => Promise<{
    success: boolean;
    error?: string;
    userInfo?: { username?: string };
  }>;
  isAuthenticated: () => Promise<boolean>;
  getUserEmail: () => Promise<string | null>;
  signout: () => Promise<{ success: boolean }>;
  onDeviceCode: (callback: (info: unknown) => void) => () => void;
  onExportProgress: (callback: (progress: unknown) => void) => () => void;
}
