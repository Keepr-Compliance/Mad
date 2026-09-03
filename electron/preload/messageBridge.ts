/**
 * Message Bridge
 * iMessage conversation methods for macOS
 */

import { ipcRenderer } from "electron";
// BACKLOG-2743: shared estimate shapes — one definition for preload, renderer,
// and the window.api surface, so the space verdict cannot drift between them.
import type {
  MessageImportCountFilters,
  MessageImportCountResult,
  BackgroundImportSignal,
} from "../types/ipc/window-api-messages";
// BACKLOG-2748: ONE spelling of the cancel channel, shared with the handler.
import {
  MESSAGES_IMPORT_CANCEL_CHANNEL,
  MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL,
  MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL,
} from "../types/ipc/messageChannels";

/**
 * Progress event from macOS message import (TASK-1710)
 * Enhanced with querying phase, elapsed time tracking for ETA calculation
 */
export interface ImportProgress {
  phase: "querying" | "importing" | "attachments";
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
   * Get the count and size estimate for the messages an import would cover.
   *
   * BACKLOG-2772: takes the user id and the panel's CURRENT, not-yet-saved
   * selection. Main resolves the plan — the same plan the Import button will
   * run — so the estimate on screen and the fetch that follows it are one
   * decision rather than two assemblies racing (BACKLOG-2760).
   *
   * @returns Count of available messages plus the attachment/disk verdict
   */
  getImportCount: (
    userId: string,
    selection?: MessageImportCountFilters
  ): Promise<MessageImportCountResult> =>
    ipcRenderer.invoke("messages:get-import-count", userId, selection),

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
   * Listen for a macOS Messages import that the RENDERER did not start
   * (BACKLOG-2772).
   *
   * The sync queue lives in the renderer, so a main-initiated import — the one
   * the transaction trigger runs when a deal is created or its start date moves
   * earlier — cannot enqueue itself. It announces instead, and the orchestrator
   * mirrors it into the queue as an EXTERNAL item.
   *
   * That queue item is what renders the Cancel button. The cancel MECHANISM was
   * never missing (`cancelImport` below is global to the import service and
   * would already have stopped such a run); what was missing was any surface
   * from which a user could press it.
   *
   * @returns Cleanup function to remove both listeners
   */
  onBackgroundImport: (callbacks: {
    onStarted: (signal: BackgroundImportSignal) => void;
    onFinished: (signal: BackgroundImportSignal) => void;
  }): (() => void) => {
    const started = (_e: Electron.IpcRendererEvent, s: BackgroundImportSignal) =>
      callbacks.onStarted(s);
    const finished = (_e: Electron.IpcRendererEvent, s: BackgroundImportSignal) =>
      callbacks.onFinished(s);
    ipcRenderer.on(MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL, started);
    ipcRenderer.on(MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL, finished);
    return () => {
      ipcRenderer.removeListener(MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL, started);
      ipcRenderer.removeListener(MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL, finished);
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
   * Gracefully stops the import, preserving partial data.
   *
   * BACKLOG-2748: this existed here from TASK-1710 with NO caller — the import
   * progress UI shipped without a Cancel control, so a running import could only
   * be escaped by force-quitting the app. The channel name is now shared with
   * the handler rather than spelled out on both sides (PR-SOP §6.2e).
   */
  cancelImport: (): void => {
    ipcRenderer.send(MESSAGES_IMPORT_CANCEL_CHANNEL);
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

  /**
   * Get the EFFECTIVE (audit-aware) macOS Messages import window for display (BACKLOG-2286).
   * The effective lower bound is the EARLIER of the user's lookback preference and
   * the earliest transaction audit-period start. Read-only; does not change import.
   * @param userId - User ID to compute the window for
   * @returns Effective cutoff ISO (null = all time), governing source, and lookback pref
   */
  getEffectiveImportWindow: (
    userId: string
  ): Promise<{
    success: boolean;
    effectiveCutoffISO: string | null;
    source: "audit-period" | "lookback-pref";
    lookbackMonths: number | null;
  }> => ipcRenderer.invoke("messages:get-effective-import-window", userId),
};
