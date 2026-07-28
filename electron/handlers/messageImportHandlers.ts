// ============================================
// MESSAGE IMPORT IPC HANDLERS
// Handles: messages:import-macos, messages:get-import-count, messages:get-attachments
// ============================================

import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as Sentry from "@sentry/electron/main";
import logService from "../services/logService";
import databaseService from "../services/databaseService";
import supabaseService from "../services/supabaseService";
import macOSMessagesImportService from "../services/macOSMessagesImportService";
import * as externalContactDb from "../services/db/externalContactDbService";
import { autoLinkNewMessagesForUser, expandAttachedThreadsForUser } from "../services/autoLinkService";
import { computeEarliestAuditStart } from "../utils/emailDateRange";
import { computeEffectiveImportWindow } from "../services/macOSMessagesImportService/importHelpers";
import { wrapHandler } from "../utils/wrapHandler";
import type {
  MacOSImportResult,
  ImportProgressCallback,
  MessageImportFilters,
} from "../services/macOSMessagesImportService";
import type { EffectiveImportWindow } from "../services/macOSMessagesImportService/importHelpers";

/**
 * Attachment info with base64 data for IPC transfer (TASK-1012)
 */
interface MessageAttachmentInfo {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  data: string | null;
}

// Track registration to prevent duplicate handlers
let handlersRegistered = false;

// TASK-1710: Track import start time for elapsed time calculation
let importStartTime: number | null = null;

/**
 * Register message import IPC handlers
 */
export function registerMessageImportHandlers(mainWindow: BrowserWindow): void {
  // Prevent double registration
  if (handlersRegistered) {
    logService.warn(
      "Message import handlers already registered, skipping duplicate registration",
      "MessageImportHandlers"
    );
    return;
  }
  handlersRegistered = true;

  /**
   * Import messages from macOS Messages app
   * IPC: messages:import-macos
   *
   * @param userId - The user ID to associate messages with
   * @param forceReimport - If true, delete existing messages first
   * @returns Import result with counts and status
   */
  ipcMain.handle(
    "messages:import-macos",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      forceReimport = false
    ): Promise<MacOSImportResult> => {
      // BACKLOG-551: Verify user exists in database (ID may have been migrated)
      let validUserId = userId;
      const userExists = await databaseService.getUserById(userId);
      if (!userExists) {
        logService.warn("[MessageImport] User ID not found, may have been migrated", "MessageImportHandlers", {
          providedId: userId.substring(0, 8) + "...",
        });
        // Try to find any user in the database (single-user app)
        const db = databaseService.getRawDatabase();
        const anyUser = db.prepare("SELECT id FROM users_local LIMIT 1").get() as { id: string } | undefined;
        if (anyUser) {
          validUserId = anyUser.id;
          logService.info("[MessageImport] Using migrated user ID", "MessageImportHandlers", {
            correctedId: validUserId.substring(0, 8) + "...",
          });
        } else {
          return {
            success: false,
            messagesImported: 0,
            messagesSkipped: 0,
            attachmentsImported: 0,
            attachmentsUpdated: 0,
            attachmentsSkipped: 0,
            duration: 0,
            error: "No valid user found in database",
          };
        }
      }

      // TASK-1952: Load message import filter preferences
      // Defaults: 3 months lookback, 50K max messages (matches UI defaults)
      const DEFAULT_LOOKBACK_MONTHS = 3;
      const DEFAULT_MAX_MESSAGES = 50000;
      let importFilters: MessageImportFilters = {
        lookbackMonths: DEFAULT_LOOKBACK_MONTHS,
        maxMessages: DEFAULT_MAX_MESSAGES,
      };
      try {
        const preferences = await supabaseService.getPreferences(validUserId);
        const messageImportPrefs = preferences?.messageImport;
        if (messageImportPrefs?.filters) {
          importFilters = {
            lookbackMonths: messageImportPrefs.filters.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS,
            maxMessages: messageImportPrefs.filters.maxMessages ?? DEFAULT_MAX_MESSAGES,
          };
        }
      } catch (prefsError) {
        // Use defaults if preferences unavailable
        logService.warn(
          "Failed to load import filter preferences, using defaults",
          "MessageImportHandlers"
        );
        Sentry.captureException(prefsError, {
          tags: { sync_type: "message_import" },
          level: "warning",
          extra: {
            handler: "messages:import-macos",
            operation: "load-preferences",
            error_message: prefsError instanceof Error ? prefsError.message : String(prefsError),
          },
        });
      }

      // BACKLOG-2276: Drive the import lower bound from the transaction audit-period
      // start (the SAME source of truth the email fetch uses). Without this, a wide
      // audit period is silently truncated by lookbackMonths and older messages are
      // never imported. computeImportCutoffNano takes the EARLIER of this and the
      // lookback window, so this only ever WIDENS the window, never narrows it.
      try {
        const db = databaseService.getRawDatabase();
        const txnRows = db
          .prepare(
            `SELECT started_at, created_at, closed_at
             FROM transactions
             WHERE user_id = ? AND status != 'archived'`
          )
          .all(validUserId) as Array<{
            started_at: string | null;
            created_at: string | null;
            closed_at: string | null;
          }>;
        const auditStart = computeEarliestAuditStart(txnRows);
        if (auditStart) {
          importFilters.auditPeriodStart = auditStart.toISOString();
        }
      } catch (auditError) {
        // Non-fatal: fall back to lookback-only behavior.
        logService.warn(
          "Failed to compute audit-period start for message import, using lookback only",
          "MessageImportHandlers",
          { error: auditError instanceof Error ? auditError.message : String(auditError) }
        );
      }

      logService.info(
        `Starting macOS Messages import for user`,
        "MessageImportHandlers",
        { userId: validUserId, forceReimport, filters: importFilters }
      );

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'macOS Messages import started',
        level: 'info',
        data: {
          syncType: 'messages',
          platform: 'macos',
          operation: 'messages-import',
          forceReimport,
          lookbackMonths: importFilters.lookbackMonths,
          maxMessages: importFilters.maxMessages,
        },
      });

      // TASK-1710: Track import start time for elapsed time calculation
      importStartTime = Date.now();

      // Create progress callback that sends updates to renderer with elapsed time
      const onProgress: ImportProgressCallback = (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const elapsedMs = importStartTime ? Date.now() - importStartTime : 0;
          mainWindow.webContents.send("messages:import-progress", {
            ...progress,
            elapsedMs,
          });
        }
      };

      try {
        const result = await macOSMessagesImportService.importMessages(
          validUserId,
          onProgress,
          forceReimport,
          importFilters
        );

        if (result.success) {
          Sentry.addBreadcrumb({
            category: 'sync',
            message: 'macOS Messages import completed',
            level: 'info',
            data: {
              syncType: 'messages',
              platform: 'macos',
              operation: 'messages-import',
              messagesImported: result.messagesImported,
              messagesSkipped: result.messagesSkipped,
              duration: result.duration,
            },
          });

          logService.info(
            `macOS Messages import completed`,
            "MessageImportHandlers",
            {
              imported: result.messagesImported,
              skipped: result.messagesSkipped,
              duration: result.duration,
            }
          );

          // Update contact communication dates from imported messages
          // This enables sorting contacts by recent communication
          try {
            const backfillCount = await databaseService.backfillContactCommunicationDates(validUserId);
            logService.info(
              `Contact communication dates updated`,
              "MessageImportHandlers",
              { updatedContacts: backfillCount }
            );
          } catch (backfillError) {
            logService.warn(
              `Failed to update contact communication dates: ${backfillError}`,
              "MessageImportHandlers"
            );
            Sentry.captureException(backfillError, {
              tags: { sync_type: "message_import" },
              level: "warning",
              extra: {
                handler: "messages:import-macos",
                operation: "backfill-contact-dates",
                error_message: backfillError instanceof Error ? backfillError.message : String(backfillError),
              },
            });
          }

          // Update phone_last_message lookup table for fast external contact sorting (BACKLOG-567)
          try {
            const phoneCount = await databaseService.backfillPhoneLastMessageTable(validUserId);
            logService.info(
              `Phone last message lookup table updated`,
              "MessageImportHandlers",
              { phonesUpdated: phoneCount }
            );
          } catch (phoneBackfillError) {
            logService.warn(
              `Failed to update phone last message table: ${phoneBackfillError}`,
              "MessageImportHandlers"
            );
            Sentry.captureException(phoneBackfillError, {
              tags: { sync_type: "message_import" },
              level: "warning",
              extra: {
                handler: "messages:import-macos",
                operation: "backfill-phone-last-message",
                error_message: phoneBackfillError instanceof Error ? phoneBackfillError.message : String(phoneBackfillError),
              },
            });
          }

          // TASK-1773: Update external_contacts last_message_at from phone_last_message lookup
          try {
            const externalUpdatedCount = externalContactDb.updateLastMessageAtFromLookupTable(validUserId);
            logService.info(
              `External contacts last_message_at updated`,
              "MessageImportHandlers",
              { updatedContacts: externalUpdatedCount }
            );
          } catch (externalUpdateError) {
            logService.warn(
              `Failed to update external contacts dates: ${externalUpdateError}`,
              "MessageImportHandlers"
            );
            Sentry.captureException(externalUpdateError, {
              tags: { sync_type: "message_import" },
              level: "warning",
              extra: {
                handler: "messages:import-macos",
                operation: "update-external-contacts-dates",
                error_message: externalUpdateError instanceof Error ? externalUpdateError.message : String(externalUpdateError),
              },
            });
          }

          // BACKLOG-1546: Auto-link newly imported messages to transactions
          // Fire-and-forget — don't block the import response
          if (result.messagesImported > 0) {
            autoLinkNewMessagesForUser(validUserId)
              .catch((autoLinkError) => {
                logService.warn(
                  `Post-import auto-link failed: ${autoLinkError instanceof Error ? autoLinkError.message : "Unknown"}`,
                  "MessageImportHandlers"
                );
              })
              // BACKLOG-2285: After auto-link, expand attached conversations so
              // backfilled/older messages (imported by the widened audit window)
              // are picked up in already-attached threads. Runs even if auto-link
              // rejected, and stays fire-and-forget.
              .finally(() => {
                expandAttachedThreadsForUser(validUserId).catch((expandError) => {
                  logService.warn(
                    `Post-import attached-thread expansion failed: ${expandError instanceof Error ? expandError.message : "Unknown"}`,
                    "MessageImportHandlers"
                  );
                });
              });
          }
        } else {
          logService.error(
            `macOS Messages import failed: ${result.error}`,
            "MessageImportHandlers"
          );
        }

        return result;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error(
          `macOS Messages import error: ${errorMessage}`,
          "MessageImportHandlers"
        );
        Sentry.captureException(error, {
          tags: { sync_type: "message_import", platform: "macos" },
          extra: {
            handler: "messages:import-macos",
            operation: "import-messages",
            error_message: errorMessage,
          },
        });
        return {
          success: false,
          messagesImported: 0,
          messagesSkipped: 0,
          attachmentsImported: 0,
          attachmentsUpdated: 0,
          attachmentsSkipped: 0,
          duration: 0,
          error: errorMessage,
        };
      }
    }
  );

  /**
   * Get count of messages available for import from macOS Messages
   * TASK-1952: Supports optional filters parameter for filtered count
   * IPC: messages:get-import-count
   *
   * @param filters - Optional import filters (lookbackMonths, maxMessages)
   * @returns Count of available messages (total and optionally filtered)
   */
  ipcMain.handle(
    "messages:get-import-count",
    async (
      _event: IpcMainInvokeEvent,
      filters?: MessageImportFilters
    ): Promise<{ success: boolean; count?: number; filteredCount?: number; error?: string }> => {
      logService.info(
        `Getting macOS Messages count`,
        "MessageImportHandlers",
        { filters }
      );

      try {
        return await macOSMessagesImportService.getAvailableMessageCount(filters);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error(
          `Failed to get message count: ${errorMessage}`,
          "MessageImportHandlers"
        );
        Sentry.captureException(error, {
          tags: { sync_type: "message_import" },
          level: "warning",
          extra: {
            handler: "messages:get-import-count",
            error_message: errorMessage,
          },
        });

        return {
          success: false,
          error: errorMessage,
        };
      }
    }
  );

  /**
   * Get attachments for a single message with base64 data (TASK-1012)
   * IPC: messages:get-attachments
   *
   * @param messageId - The message ID to get attachments for
   * @returns Array of attachments with base64-encoded data
   */
  ipcMain.handle(
    "messages:get-attachments",
    async (
      _event: IpcMainInvokeEvent,
      messageId: string
    ): Promise<MessageAttachmentInfo[]> => {
      try {
        const attachments = macOSMessagesImportService.getAttachmentsByMessageId(messageId);
        return attachments.map((att) => ({
          id: att.id,
          message_id: att.message_id,
          filename: att.filename,
          mime_type: att.mime_type,
          file_size_bytes: att.file_size_bytes,
          data: att.storage_path
            ? macOSMessagesImportService.getAttachmentAsBase64(att.storage_path)
            : null,
        }));
      } catch (error) {
        logService.error(
          `Failed to get attachments: ${error instanceof Error ? error.message : "Unknown"}`,
          "MessageImportHandlers"
        );
        Sentry.captureException(error, {
          tags: { sync_type: "message_import" },
          level: "warning",
          extra: {
            handler: "messages:get-attachments",
            error_message: error instanceof Error ? error.message : String(error),
          },
        });
        return [];
      }
    }
  );

  /**
   * Get attachments for multiple messages at once (TASK-1012)
   * IPC: messages:get-attachments-batch
   *
   * @param messageIds - Array of message IDs
   * @returns Record of message ID to attachments
   */
  ipcMain.handle(
    "messages:get-attachments-batch",
    async (
      _event: IpcMainInvokeEvent,
      messageIds: string[]
    ): Promise<Record<string, MessageAttachmentInfo[]>> => {
      try {
        const attachmentsMap = macOSMessagesImportService.getAttachmentsByMessageIds(messageIds);
        const result: Record<string, MessageAttachmentInfo[]> = {};

        for (const [msgId, attachments] of attachmentsMap) {
          result[msgId] = attachments.map((att) => ({
            id: att.id,
            message_id: att.message_id,
            filename: att.filename,
            mime_type: att.mime_type,
            file_size_bytes: att.file_size_bytes,
            data: att.storage_path
              ? macOSMessagesImportService.getAttachmentAsBase64(att.storage_path)
              : null,
          }));
        }

        return result;
      } catch (error) {
        logService.error(
          `Failed to get attachments batch: ${error instanceof Error ? error.message : "Unknown"}`,
          "MessageImportHandlers"
        );
        Sentry.captureException(error, {
          tags: { sync_type: "message_import" },
          level: "warning",
          extra: {
            handler: "messages:get-attachments-batch",
            error_message: error instanceof Error ? error.message : String(error),
          },
        });
        return {};
      }
    }
  );

  /**
   * Repair attachment message_id mappings without full re-import.
   * IPC: messages:repair-attachments
   */
  ipcMain.handle(
    "messages:repair-attachments",
    async (): Promise<{
      total: number;
      repaired: number;
      orphaned: number;
      alreadyCorrect: number;
    }> => {
      logService.info("Repairing attachment mappings via IPC", "MessageImportHandlers");
      return macOSMessagesImportService.repairAttachmentMessageIds();
    }
  );

  /**
   * Reset import lock (for debugging stuck state)
   * IPC: messages:reset-import-lock
   */
  ipcMain.handle("messages:reset-import-lock", async (): Promise<void> => {
    logService.info("Resetting import lock via IPC", "MessageImportHandlers");
    macOSMessagesImportService.resetImportLock();
  });

  /**
   * Cancel the current import operation (TASK-1710)
   * IPC: messages:import-cancel
   * Uses ipcMain.on (not handle) since this is a one-way event
   */
  ipcMain.on("messages:import-cancel", () => {
    logService.info("Import cancel requested via IPC", "MessageImportHandlers");
    macOSMessagesImportService.requestCancellation();
  });

  /**
   * Get macOS messages import status (count and last import time)
   * IPC: messages:getImportStatus
   */
  ipcMain.handle(
    "messages:getImportStatus",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string
    ): Promise<{
      success: boolean;
      messageCount?: number;
      lastImportAt?: string | null;
      error?: string;
    }> => {
      // BACKLOG-615: Check if database is initialized before querying
      if (!databaseService.isInitialized()) {
        logService.info("[MessageImport] DB not initialized, returning empty import status (deferred DB init)", "MessageImportHandlers");
        return {
          success: true,
          messageCount: 0,
          lastImportAt: null,
        };
      }

      // BACKLOG-615: Verify user exists in database before querying
      const userExists = await databaseService.getUserById(userId);
      if (!userExists) {
        logService.info("[MessageImport] No local user yet, returning empty import status (deferred DB init)", "MessageImportHandlers");
        return {
          success: true,
          messageCount: 0,
          lastImportAt: null,
        };
      }

      const db = databaseService.getRawDatabase();

      // Get count and most recent created_at for iMessage/SMS
      const result = db.prepare(`
        SELECT
          COUNT(*) as count,
          MAX(created_at) as last_import_at
        FROM messages
        WHERE user_id = ?
          AND channel IN ('sms', 'imessage')
      `).get(userId) as { count: number; last_import_at: string | null } | undefined;

      return {
        success: true,
        messageCount: result?.count ?? 0,
        lastImportAt: result?.last_import_at ?? null,
      };
    }, { module: "MessageImportHandlers" }),
  );

  /**
   * Get the EFFECTIVE (audit-aware) macOS Messages import window for DISPLAY.
   * IPC: messages:get-effective-import-window
   *
   * BACKLOG-2286: The Settings → macOS Messages label must reflect the ACTUAL
   * import lower bound. Post-BACKLOG-2276 that bound is the EARLIER of the user's
   * lookback preference and the earliest transaction audit-period start (the pref
   * is a FLOOR the audit window can widen past). This handler is READ-ONLY and
   * mirrors the import handler's preference + audit-start computation; it never
   * changes import behavior. It degrades to the lookback preference on any read
   * failure so the label always renders.
   */
  ipcMain.handle(
    "messages:get-effective-import-window",
    async (
      _event: IpcMainInvokeEvent,
      userId: string
    ): Promise<EffectiveImportWindow & { success: boolean }> => {
      // Matches the import handler's default when no preference is stored.
      const DEFAULT_LOOKBACK_MONTHS = 3;

      // 1) Resolve the lookback preference. Mirror the import handler exactly
      //    (`?? DEFAULT`) so the displayed window equals the imported window.
      let lookbackMonths: number | null = DEFAULT_LOOKBACK_MONTHS;
      try {
        const preferences = await supabaseService.getPreferences(userId);
        const filters = preferences?.messageImport?.filters;
        if (filters) {
          lookbackMonths = filters.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS;
        }
      } catch (prefsError) {
        logService.warn(
          "Failed to load lookback preference for effective import window, using default",
          "MessageImportHandlers",
          { error: prefsError instanceof Error ? prefsError.message : String(prefsError) }
        );
      }

      // 2) Compute the earliest audit-period start across non-archived
      //    transactions (same source of truth the import uses). Degrade to
      //    null (lookback-only) when the DB is unavailable.
      let auditStartISO: string | null = null;
      try {
        if (databaseService.isInitialized()) {
          const db = databaseService.getRawDatabase();
          const txnRows = db
            .prepare(
              `SELECT started_at, created_at, closed_at
                 FROM transactions
                WHERE user_id = ? AND status != 'archived'`
            )
            .all(userId) as Array<{
              started_at: string | null;
              created_at: string | null;
              closed_at: string | null;
            }>;
          const auditStart = computeEarliestAuditStart(txnRows);
          auditStartISO = auditStart ? auditStart.toISOString() : null;
        }
      } catch (auditError) {
        logService.warn(
          "Failed to compute audit-period start for effective import window, using lookback only",
          "MessageImportHandlers",
          { error: auditError instanceof Error ? auditError.message : String(auditError) }
        );
      }

      const window = computeEffectiveImportWindow({ lookbackMonths, auditStartISO });
      return { success: true, ...window };
    }
  );

  logService.info(
    "Message import handlers registered",
    "MessageImportHandlers"
  );
}
