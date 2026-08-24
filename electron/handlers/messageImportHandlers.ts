// ============================================
// MESSAGE IMPORT IPC HANDLERS
// Handles: messages:import-macos, messages:get-import-count, messages:get-attachments
// ============================================

import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as Sentry from "@sentry/electron/main";
import logService from "../services/logService";
import databaseService from "../services/databaseService";
import macOSMessagesImportService from "../services/macOSMessagesImportService";
import * as externalContactDb from "../services/db/externalContactDbService";
import { autoLinkNewMessagesForUser, expandAttachedThreadsForUser } from "../services/autoLinkService";
import {
  resolveLookbackMonths,
  DEFAULT_LOOKBACK_MONTHS,
} from "../services/macOSMessagesImportService/importHelpers";
// BACKLOG-2772: the ONE assembler + resolver every import entry point calls.
// BACKLOG-2749: `computeEffectiveImportWindow`, `computeEarliestAuditStart` and
// `readNonRejectedTransactions` are gone from this file — the effective-window
// label reads the plan now, so the last copy of that assembly is DELETED here
// rather than left unused.
import {
  resolveImportPlanForUser,
  loadStoredImportFilters,
} from "../services/importPlanInputs";
import type { StoredImportFilters } from "../services/importPlan";
import { wrapHandler } from "../utils/wrapHandler";
import type {
  MacOSImportResult,
  ImportProgressCallback,
} from "../services/macOSMessagesImportService";
import type { EffectiveImportWindow } from "../services/macOSMessagesImportService/importHelpers";
// BACKLOG-2743: shared selection-time estimate shape (attachment bytes + disk verdict).
import type {
  MessageImportCountResult,
  RecommendedImportRange,
} from "../types/ipc/window-api-messages";
// BACKLOG-2748: ONE spelling of the cancel channel, shared with the preload bridge.
import { MESSAGES_IMPORT_CANCEL_CHANNEL } from "../types/ipc/messageChannels";

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

/**
 * BACKLOG-2749: the dialog's recommendation, computed WITH the estimate.
 *
 * The founder saw the cost of computing it later: "the Change the time range
 * button takes a sec to load". The mechanism was already right — each candidate
 * range is ASKED for its own count, never scaled proportionally from another's,
 * because messages are not spread evenly across months and a proportional guess
 * names a range that does not fit. It was simply happening after the click.
 *
 * So the same work moves ahead of the click, and only where it is needed:
 *
 *   - Nothing runs unless the cap is actually exceeded. A selection that fits
 *     pays nothing, which is every user who never sees this dialog.
 *   - Largest-first with an early return, so the common case is one extra
 *     count rather than six.
 *   - A candidate that is not NARROWER than the current selection is skipped:
 *     counts grow with range length, so a longer range cannot rescue a
 *     selection that is already over the cap. This is what stops an over-cap
 *     "Last 3 months" from querying all six presets to learn nothing.
 *
 * Each candidate goes through `resolveImportPlanForUser` exactly as the
 * selection did, so a candidate's count is the count of the plan that would
 * really run for it — audit spans, Cap' and all.
 *
 * @returns the largest narrower range that fits, or `null` when none does.
 *   `null` is an ANSWER, not a failure: it is the founder's hiding rule (when
 *   deal audit periods force the window open, nothing shorter helps).
 */
const RECOMMENDATION_PRESETS = [24, 18, 12, 9, 6, 3] as const;

async function resolveRecommendedRange(
  userId: string,
  selection: StoredImportFilters | undefined,
  cap: number | null,
  windowCount: number | undefined
): Promise<RecommendedImportRange | null> {
  if (cap === null || windowCount === undefined || windowCount <= cap) {
    return null;
  }

  for (const months of RECOMMENDATION_PRESETS) {
    const candidatePlan = await resolveImportPlanForUser({
      userId,
      mode: "delta",
      selectionOverride: { ...(selection ?? {}), lookbackMonths: months },
    });
    const counts =
      await macOSMessagesImportService.getAvailableMessageCount(candidatePlan);
    if (!counts.success) continue;

    const candidateCount = counts.windowCount ?? counts.count;
    if (candidateCount === undefined) continue;
    // Not narrower than what the user already has — a longer range cannot
    // rescue an over-cap selection, and offering it would be nonsense.
    if (candidateCount >= windowCount) continue;
    if (candidateCount <= cap) {
      return { lookbackMonths: months, windowCount: candidateCount };
    }
  }

  return null;
}

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

      // BACKLOG-2772: ONE resolver decides what this run fetches.
      //
      // Everything that used to happen here — loading the preference object,
      // resolving `lookbackMonths`, collapsing `maxMessages` with `??`
      // (BACKLOG-2733), running a non-rejected-transaction query and folding the
      // earliest audit start into an `auditPeriodStart` field — is DELETED, not
      // moved behind a flag. It lives in `resolveImportPlanForUser`, which the
      // estimate channel and the transaction trigger call as well, so the three
      // can no longer reach different answers from the same stored state.
      //
      // D2': the button chooses the processing MODE and nothing else. Both modes
      // cover the same window — "force re-import will always cover the whole
      // window... it's more about the processing of msgs" (founder, 2026-08-20).
      const plan = await resolveImportPlanForUser({
        userId: validUserId,
        mode: forceReimport ? "reprocess" : "delta",
      });
      logService.info(
        `Starting macOS Messages import for user`,
        "MessageImportHandlers",
        {
          userId: validUserId,
          mode: plan.mode,
          fetchStartISO: plan.fetchStartISO,
          effectiveCap: plan.effectiveCap,
          protectedSpans: plan.protectedSpans.length,
          fetchAttachments: plan.fetchAttachments,
          overrides: plan.overrides.map((o) => o.kind),
        }
      );

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'macOS Messages import started',
        level: 'info',
        data: {
          syncType: 'messages',
          platform: 'macos',
          operation: 'messages-import',
          mode: plan.mode,
          effectiveCap: plan.effectiveCap,
          protectedSpanCount: plan.protectedSpans.length,
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
          plan
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
      userId: string,
      selection?: StoredImportFilters
    ): Promise<MessageImportCountResult> => {
      logService.info(
        `Getting macOS Messages count`,
        "MessageImportHandlers",
        { selection }
      );

      try {
        // BACKLOG-2772/2760: the estimate resolves the SAME plan the button
        // will run, so the number on the screen and the number the import
        // enforces are the same decision object rather than two assemblies
        // racing each other.
        //
        // `selection` is the panel's current, not-yet-saved dropdown state,
        // layered over the stored preference by the assembler. That is a
        // legitimate per-entry-point difference and it lives in the REQUEST —
        // it is not a second filter. Mode is "delta": an estimate describes
        // what a fetch would cover, and under D2' both modes cover the same
        // window, so the estimate is mode-independent by construction.
        const plan = await resolveImportPlanForUser({
          userId,
          mode: "delta",
          selectionOverride: selection ?? null,
        });
        const counts =
          await macOSMessagesImportService.getAvailableMessageCount(plan);

        // BACKLOG-2749: carry the PLAN's own facts back with its counts.
        //
        // The one pre-import dialog states the cap, the coverage and the
        // deal-driven window stretch. Every one of those is a decision this
        // `plan` object already made; sending them means the dialog reads them
        // instead of reconstructing them from the counts, which is what the
        // founder saw fail — a header derived from the stored preference saying
        // "up to 50,000" above a line derived from the counts saying 62,823.
        //
        // Spread here rather than inside `getAvailableMessageCount`: that
        // function's job is to COUNT what a plan admits, and it takes the plan
        // as an input. Having it echo its own input back would make the service
        // the wire's assembler, which is the shape BACKLOG-2772 removed.
        // BACKLOG-2749: the recommendation travels WITH the counts, so the
        // dialog renders complete the instant it opens.
        const recommendedRange = await resolveRecommendedRange(
          userId,
          selection,
          plan.effectiveCap,
          counts.windowCount ?? counts.count
        );

        return {
          ...counts,
          plan: {
            effectiveCap: plan.effectiveCap,
            fetchStartISO: plan.fetchStartISO,
            overrides: plan.overrides,
          },
          recommendedRange,
        };
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
   *
   * BACKLOG-2748: from TASK-1710 until now nothing sent on this channel — the
   * handler and the service's cancellation flag were both live, and the import
   * progress UI had no control that reached them.
   */
  ipcMain.on(MESSAGES_IMPORT_CANCEL_CHANNEL, () => {
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
   * never changes import behavior.
   *
   * BACKLOG-2749 — this handler now READS the plan instead of mirroring it.
   *
   * It was the last self-assembling reader on the import side: BACKLOG-2772
   * routed its transaction query through `readNonRejectedTransactions` but left
   * it computing its own window from `computeEffectiveImportWindow`, which the
   * SR review recorded as the fourth hand copy (accepted then as display-only
   * and value-identical). "Value-identical today" is the exact standing this
   * item exists to remove: the label, the estimate, the dialog and the run must
   * be one decision, not four that happen to agree.
   *
   * The mapping is exact, not approximate:
   *   - `effectiveCutoffISO` IS `plan.fetchStartISO`. Both come from
   *     `computeImportCutoffNano`, which is where the arithmetic has always
   *     lived — the duplicate was the ASSEMBLY around it.
   *   - `source` is "audit-period" exactly when the plan recorded a
   *     `window-extended-by-deals` override. `computeEffectiveImportWindow`
   *     said "audit-period" only when the audit start was STRICTLY earlier than
   *     the lookback cutoff; the resolver pushes that override under the
   *     identical strict comparison (`cutoffNano < selectionOnlyCutoff`). The
   *     "All time" branch agrees too: an explicit `null` lookback short-circuits
   *     to an unbounded window with no override, which is the old
   *     `{ effectiveCutoffISO: null, source: "lookback-pref" }`.
   *
   * `lookbackMonths` is still the user's own preference — a fact about the
   * SETTING rather than about the window — so it is read here. That is a second
   * preferences read for a display-only handler, and a deliberate trade: the
   * alternative is widening the resolver's return shape to carry an input back
   * out, which is how assemblers grow.
   *
   * Degradation is unchanged in effect: `resolveImportPlanForUser` swallows a
   * failed preferences read (defaults) and a failed deal read (selection alone,
   * never widening on a guess), so the label always renders.
   */
  ipcMain.handle(
    "messages:get-effective-import-window",
    async (
      _event: IpcMainInvokeEvent,
      userId: string
    ): Promise<EffectiveImportWindow & { success: boolean }> => {
      // The user's stated preference, for the label's own field. Read through
      // the shared loader + the shared resolver, off the shared default —
      // BACKLOG-2561 was a second local `?? DEFAULT_LOOKBACK_MONTHS` here that
      // collapsed an explicit "All time" to 3 months.
      let lookbackMonths: number | null = DEFAULT_LOOKBACK_MONTHS;
      try {
        const stored = await loadStoredImportFilters(userId);
        lookbackMonths = resolveLookbackMonths(stored, DEFAULT_LOOKBACK_MONTHS);
      } catch (prefsError) {
        logService.warn(
          "Failed to load lookback preference for effective import window, using default",
          "MessageImportHandlers",
          { error: prefsError instanceof Error ? prefsError.message : String(prefsError) }
        );
      }

      // The window itself — resolved, not mirrored. `mode` is "delta" for the
      // same reason the estimate uses it: under D2' both modes cover the same
      // window, so a label is mode-independent by construction.
      const plan = await resolveImportPlanForUser({ userId, mode: "delta" });

      return {
        success: true,
        effectiveCutoffISO: plan.fetchStartISO,
        source: plan.overrides.some((o) => o.kind === "window-extended-by-deals")
          ? "audit-period"
          : "lookback-pref",
        lookbackMonths,
      };
    }
  );

  logService.info(
    "Message import handlers registered",
    "MessageImportHandlers"
  );
}
