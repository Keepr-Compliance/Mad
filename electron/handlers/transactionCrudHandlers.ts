// ============================================
// TRANSACTION CRUD IPC HANDLERS
// Handles: create, read, update, delete, and contact management
// ============================================

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import transactionService from "../services/transactionService";
import { getEarliestCommunicationDate } from "../services/transactionService";
import type { AuditedTransactionData } from "../services/transactionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import emailSyncService from "../services/emailSyncService";
// BACKLOG-1802: automatic per-transaction email sync on create/open/date-change.
// BACKLOG-1832: isAutoSyncInFlight supports mount-time spinner state query.
import { triggerTransactionSyncInBackground, isAutoSyncInFlight } from "../services/transactionSyncTrigger";
import { isAuditWindowExtended } from "../utils/emailDateRange";
// BACKLOG-2292: automatic audit-window MESSAGES sync (the messages twin) + the
// coverage-detection reads that drive the date-selection popup and export gate.
import {
  ensureTransactionMessagesSynced,
  triggerMessagesSyncInBackground,
  type EnsureMessagesResult,
} from "../services/messagesSyncTrigger";
import {
  getAuditCoverage,
  checkExportCompleteness,
} from "../services/auditCoverageService";
import type { ImportProgressCallback } from "../services/macOSMessagesImportService";
import type {
  AuditCoverageResult,
  ExportCompletenessResult,
  EnsureMessagesCoverageResult,
} from "../types/auditCoverage";
import databaseService from "../services/databaseService";
import { wrapHandler } from "../utils/wrapHandler";
import type {
  Transaction,
  NewTransaction,
  UpdateTransaction,
} from "../types/models";
import type { TransactionResponse } from "../types/handlerTypes";
import {
  ValidationError,
  validateUserId,
  validateTransactionId,
  validateContactId,
  validateTransactionData,
  validateProvider,
  sanitizeObject,
} from "../utils/validation";
import type { OAuthProvider } from "../types/models";

/**
 * Register transaction CRUD IPC handlers
 * @param mainWindow - Main window instance (used to push auto-sync events to renderer, BACKLOG-1832)
 */
export function registerTransactionCrudHandlers(
  mainWindow: BrowserWindow | null,
): void {
  /**
   * BACKLOG-1832: returns onStart/onComplete callbacks that push IPC events to
   * the renderer so the UI can show a syncing indicator and auto-refresh emails.
   * Only used for CREATE triggers — the primary scenario where emails are empty
   * immediately after a new transaction is created.
   */
  function makeCreateSyncCallbacks(transactionId: string, reason: string) {
    return {
      onStart: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("transactions:auto-sync-started", {
            transactionId,
            reason,
          });
        }
      },
      onComplete: (result: { ran: boolean; reason: string; windowsFetched?: number; skipped?: string; error?: string }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("transactions:auto-sync-complete", {
            transactionId,
            reason: result.reason,
            ran: result.ran,
            windowsFetched: result.windowsFetched,
          });
        }
      },
    };
  }

  /**
   * BACKLOG-2292: forward the macOS Messages import progress to the renderer over
   * the EXISTING `messages:import-progress` channel (the same one the Settings
   * import + the AuditCoveragePrompt already listen on). Stamps elapsedMs so the
   * inline "Updating messages…" affordance can show an ETA.
   */
  function makeMessagesProgressCallback(): ImportProgressCallback {
    const startedAt = Date.now();
    return (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("messages:import-progress", {
          ...progress,
          elapsedMs: Date.now() - startedAt,
        });
      }
    };
  }

  /**
   * BACKLOG-2292: on a background messages sync completing, tell the renderer so
   * TransactionDetails can silently refresh its TEXT list (Layer 2). The messages
   * import is user-global, so transactionId is best-effort — a null id means
   * "affects all of this user's transactions".
   */
  function emitMessagesSyncComplete(transactionId: string | null, result: EnsureMessagesResult): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("transactions:messages-sync-complete", {
        transactionId,
        ran: result.ran,
        imported: result.imported,
      });
    }
  }
  // Get all transactions for a user
  ipcMain.handle(
    "transactions:get-all",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      // Validate input
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      const transactions =
        await transactionService.getTransactions(validatedUserId);

      // Debug: log detection fields being returned to frontend
      if (transactions.length > 0) {
        logService.debug("First transaction detection fields", "TransactionHandlers", {
          id: transactions[0].id,
          detection_source: transactions[0].detection_source,
          detection_status: transactions[0].detection_status,
          detection_confidence: transactions[0].detection_confidence,
        });
      }

      return {
        success: true,
        transactions,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1124: Get pending transaction count via SELECT COUNT(*) instead of fetching all rows
  ipcMain.handle(
    "transactions:get-pending-count",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; count: number; error?: string }> => {
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      const count = databaseService.getPendingTransactionCount(validatedUserId);

      return {
        success: true,
        count,
      };
    }, { module: "Transactions" }),
  );

  // Create manual transaction
  ipcMain.handle(
    "transactions:create",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      transactionData: unknown,
    ): Promise<TransactionResponse> => {
      // Validate inputs
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }
      const validatedData = validateTransactionData(transactionData, false);

      const transaction = await transactionService.createManualTransaction(
        validatedUserId,
        validatedData as unknown as Partial<NewTransaction>,
      );

      // Audit log transaction creation
      await auditService.log({
        userId: validatedUserId,
        action: "TRANSACTION_CREATE",
        resourceType: "TRANSACTION",
        resourceId: transaction.id,
        metadata: { propertyAddress: transaction.property_address },
        success: true,
      });

      logService.info("Transaction created", "Transactions", {
        userId: validatedUserId,
        transactionId: transaction.id,
      });

      // BACKLOG-1802 (founder policy): auto-sync this transaction's full audit
      // window in the background the moment it's created — the user never clicks
      // "Sync". Fire-and-forget; failures are non-fatal to the create response.
      // BACKLOG-1832: pass lifecycle callbacks so the renderer can show a
      // "fetching emails…" indicator and auto-refresh when the sync completes.
      triggerTransactionSyncInBackground({
        transactionId: transaction.id,
        userId: validatedUserId,
        reason: "create",
        ...makeCreateSyncCallbacks(transaction.id, "create"),
      });

      return {
        success: true,
        transaction,
      };
    }, { module: "Transactions" }),
  );

  // Get transaction details with communications
  ipcMain.handle(
    "transactions:get-details",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      // Validate input
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const t0 = Date.now();
      const details = await transactionService.getTransactionDetails(
        validatedTransactionId,
      );
      const t1 = Date.now();

      if (!details) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      // BACKLOG-1802 (founder policy): opening a transaction auto-tops-up its
      // emails if the cache is stale for its audit window (throttled to avoid
      // refetch within minutes). Fire-and-forget — never blocks the detail load.
      triggerTransactionSyncInBackground({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "open",
      });

      const commCount = details.communications?.length || 0;
      const contactCount = details.contact_assignments?.length || 0;
      logService.debug(`[PERF] getDetails: ${t1 - t0}ms, ${commCount} comms, ${contactCount} contacts`, "Transactions");

      return {
        success: true,
        transaction: details,
      };
    }, { module: "Transactions" }),
  );

  // PERF: Filtered communications -- only emails or only texts
  ipcMain.handle(
    "transactions:get-communications",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
      channelFilter: "email" | "text",
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }
      // Validate channelFilter to prevent injection
      if (channelFilter !== "email" && channelFilter !== "text") {
        throw new ValidationError(
          "channelFilter must be 'email' or 'text'",
          "channelFilter",
        );
      }
      const t0 = Date.now();
      const details = await transactionService.getTransactionDetails(
        validatedTransactionId,
        channelFilter,
      );
      if (!details) {
        return { success: false, error: "Transaction not found" };
      }
      const commCount = details.communications?.length || 0;
      logService.debug(
        `[PERF] getCommunications(${channelFilter}): ${Date.now() - t0}ms, ${commCount} comms`,
        "Transactions",
      );
      return { success: true, transaction: details };
    }, { module: "Transactions" }),
  );

  // PERF: Lightweight overview -- contacts only, no communications
  ipcMain.handle(
    "transactions:get-overview",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      const t0 = Date.now();
      const details = await transactionService.getTransactionOverview(validatedTransactionId);
      if (!details) {
        return { success: false, error: "Transaction not found" };
      }
      const contactCount = details.contact_assignments?.length || 0;
      logService.debug(`[PERF] getOverview: ${Date.now() - t0}ms, ${contactCount} contacts`, "Transactions");

      return { success: true, transaction: details };
    }, { module: "Transactions" }),
  );

  // Update transaction
  ipcMain.handle(
    "transactions:update",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      updates: unknown,
    ): Promise<TransactionResponse> => {
      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const sanitizedUpdates = sanitizeObject(updates || {});
      const validatedUpdates = validateTransactionData(
        sanitizedUpdates,
        true,
      );

      // Get transaction before update for audit logging (to get user_id)
      const existingTransaction =
        await transactionService.getTransactionDetails(
          validatedTransactionId,
        );
      const userId = existingTransaction?.user_id || "unknown";

      await transactionService.updateTransaction(
        validatedTransactionId,
        validatedUpdates as unknown as Partial<UpdateTransaction>,
      );

      // Audit log transaction update
      await auditService.log({
        userId,
        action: "TRANSACTION_UPDATE",
        resourceType: "TRANSACTION",
        resourceId: validatedTransactionId,
        metadata: { updatedFields: Object.keys(validatedUpdates) },
        success: true,
      });

      logService.info("Transaction updated", "Transactions", {
        userId,
        transactionId: validatedTransactionId,
      });

      // BACKLOG-1802 (founder edge case): if the audit dates changed, the required
      // fetch window moved. Recompute vs the cached bounds and backfill/forward-fill
      // ONLY the delta (handled inside the trigger). Date-change bypasses the
      // freshness throttle — it's the one event that can re-open a "done" backfill.
      const updatesRecord = validatedUpdates as Record<string, unknown>;
      const auditDateChanged =
        ("started_at" in updatesRecord && updatesRecord.started_at !== existingTransaction?.started_at) ||
        ("closed_at" in updatesRecord && updatesRecord.closed_at !== existingTransaction?.closed_at);
      if (auditDateChanged && userId !== "unknown") {
        triggerTransactionSyncInBackground({
          transactionId: validatedTransactionId,
          userId,
          reason: "date-change",
        });

        // BACKLOG-2292 (Layer 2): the audit dates moved → automatically import
        // older TEXTS to cover the new window + expand attached threads, in the
        // BACKGROUND (a global device scan must never block the update IPC —
        // SR-correction d). proposedStartISO uses the just-saved started_at when
        // present; otherwise the trigger recomputes the earliest audit start.
        const newStartedAt =
          "started_at" in updatesRecord && typeof updatesRecord.started_at === "string"
            ? updatesRecord.started_at
            : null;
        const messagesProgress = makeMessagesProgressCallback();
        triggerMessagesSyncInBackground({
          transactionId: validatedTransactionId,
          userId,
          reason: "date-change",
          proposedStartISO: newStartedAt,
          onProgress: messagesProgress,
          onComplete: (result) => emitMessagesSyncComplete(validatedTransactionId, result),
        });

        // BACKLOG-2791 (founder, 2026-08-23): an EXTENDED audit window brings
        // communications that were previously out of scope into scope, and
        // "today nothing happens until the next open". So run the SAME review
        // discovery the other triggers run — not a fork of it — and let it
        // announce its own delta through the N/L/R popup.
        //
        // Extension only. Narrowing is deliberately not a trigger: what leaves a
        // deal when its window shrinks is an open founder decision, so this path
        // must not act on one. `isAuditWindowExtended` is a true superset test
        // (see its own docblock for why the mixed cases are excluded).
        //
        // NOT AWAITED, matching the contact-save trigger: the sweep broadcasts
        // `review:queue-changed` when it lands, so the badge and the popup
        // update as results arrive instead of the save blocking on them. A
        // discovery miss must never fail the update the user actually asked for.
        const windowExtended = isAuditWindowExtended(
          {
            started_at: existingTransaction?.started_at,
            created_at: existingTransaction?.created_at,
            closed_at: existingTransaction?.closed_at,
          },
          {
            started_at:
              "started_at" in updatesRecord
                ? (updatesRecord.started_at as string | null)
                : existingTransaction?.started_at,
            created_at: existingTransaction?.created_at,
            closed_at:
              "closed_at" in updatesRecord
                ? (updatesRecord.closed_at as string | null)
                : existingTransaction?.closed_at,
          },
        );

        if (windowExtended) {
          void (async () => {
            try {
              const { syncReviewQueueForTransaction } = await import(
                "../services/reviewStateService"
              );
              await syncReviewQueueForTransaction({
                transactionId: validatedTransactionId,
                reason: "date-extended",
              });
            } catch (syncError) {
              logService.warn(
                "[BACKLOG-2791] review-queue sync after audit-range extension failed",
                "Transactions",
                { error: syncError instanceof Error ? syncError.message : "Unknown" },
              );
            }
          })();
        }
      }

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );

  // Delete transaction
  ipcMain.handle(
    "transactions:delete",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      // Validate input
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Get transaction before delete for audit logging
      const existingTransaction =
        await transactionService.getTransactionDetails(
          validatedTransactionId,
        );
      const userId = existingTransaction?.user_id || "unknown";
      const propertyAddress =
        existingTransaction?.property_address || "unknown";

      await transactionService.deleteTransaction(validatedTransactionId);

      // Audit log transaction deletion
      await auditService.log({
        userId,
        action: "TRANSACTION_DELETE",
        resourceType: "TRANSACTION",
        resourceId: validatedTransactionId,
        metadata: { propertyAddress },
        success: true,
      });

      logService.info("Transaction deleted", "Transactions", {
        userId,
        transactionId: validatedTransactionId,
      });

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );

  // Create audited transaction with contact assignments
  ipcMain.handle(
    "transactions:create-audited",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      transactionData: unknown,
    ): Promise<TransactionResponse> => {
      logService.info("Creating audited transaction", "Transactions", {
        userId,
      });

      // Validate inputs
      const validatedUserId = validateUserId(userId);
      const validatedData = validateTransactionData(
        sanitizeObject(transactionData || {}),
        false,
      );

      // TASK-1031: createAuditedTransaction now auto-links communications
      // for all assigned contacts internally
      const transaction = await transactionService.createAuditedTransaction(
        validatedUserId as string,
        validatedData as AuditedTransactionData,
      );

      // BACKLOG-1802: createAuditedTransaction auto-links from the LOCAL cache
      // only; also kick a background provider fetch of the full audit window so a
      // fresh install pulls the complete set (not just what's already cached).
      // BACKLOG-1832: pass lifecycle callbacks so the renderer can show a
      // "fetching emails…" indicator and auto-refresh when the sync completes.
      if (transaction?.id) {
        // BACKLOG-2563: audit the creation. `transactions:create` above logs
        // TRANSACTION_CREATE at :199 and this path did not, so the compliance
        // trail was missing the creation event for exactly the transactions
        // that exist for compliance — this is the primary user path for
        // creating an audited transaction (`useAuditSubmission.ts`).
        //
        // The verb stays inside the `audit_logs.action` CHECK and
        // `metadata.reason` names the specific act — the same idiom as the
        // contact-restore audit below, for the same reason spelled out there:
        // an unpermitted verb would throw on the CHECK, be swallowed by
        // `auditService.log`, and report success while writing nothing.
        //
        // Logged BEFORE the two fire-and-forget triggers so a background
        // failure cannot reorder or drop the trail entry.
        await auditService.log({
          userId: validatedUserId as string,
          action: "TRANSACTION_CREATE",
          resourceType: "TRANSACTION",
          resourceId: transaction.id,
          metadata: {
            propertyAddress: transaction.property_address,
            reason: "audited_create",
          },
          success: true,
        });

        triggerTransactionSyncInBackground({
          transactionId: transaction.id,
          userId: validatedUserId as string,
          reason: "create",
          ...makeCreateSyncCallbacks(transaction.id, "create"),
        });

        // BACKLOG-2292 (Layer 2): a new audited transaction can reach back past
        // the imported text floor → import older TEXTS + expand in the BACKGROUND.
        const createStartedAt =
          typeof (validatedData as { started_at?: unknown }).started_at === "string"
            ? ((validatedData as { started_at?: string }).started_at ?? null)
            : null;
        const createMessagesProgress = makeMessagesProgressCallback();
        triggerMessagesSyncInBackground({
          transactionId: transaction.id,
          userId: validatedUserId as string,
          reason: "create",
          proposedStartISO: createStartedAt,
          onProgress: createMessagesProgress,
          onComplete: (result) => emitMessagesSyncComplete(transaction.id, result),
        });
      }

      return {
        success: true,
        transaction,
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // BACKLOG-2292 — AUDIT-WINDOW COMPLETENESS
  // ============================================

  /**
   * Coverage for a PROPOSED audit start (date-selection time). Drives the
   * Layer-1 popup: whether the chosen start predates the imported messages floor
   * and/or the cached email floor. All floors are ISO strings (SR-correction f).
   */
  ipcMain.handle(
    "transactions:get-audit-coverage",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
      proposedStartISO: string,
    ): Promise<AuditCoverageResult> => {
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }
      return getAuditCoverage(validatedUserId as string, proposedStartISO);
    }, { module: "Transactions" }),
  );

  /**
   * Export completeness backstop (Layer 3): is this transaction's messages
   * coverage complete for its saved audit window? Read-only detection; the
   * renderer ExportModal decides whether to prompt.
   */
  ipcMain.handle(
    "transactions:check-export-completeness",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
      userId: string,
    ): Promise<ExportCompletenessResult> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }
      return checkExportCompleteness(validatedTransactionId, validatedUserId as string);
    }, { module: "Transactions" }),
  );

  /**
   * The "Update now" action: AWAIT a targeted messages import + expansion for an
   * explicit proposed start (which may not be persisted yet — the create/edit
   * popup fires before save). Progress streams over `messages:import-progress`.
   * Returns the floor AFTER the attempt so the renderer re-derives completeness
   * (observe-by-requery; BACKLOG-1875) — never assume success from no error.
   */
  ipcMain.handle(
    "transactions:ensure-messages-coverage",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
      proposedStartISO: string | null,
      transactionId?: string,
    ): Promise<EnsureMessagesCoverageResult> => {
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }
      // D3 (SR should-fix): validate transactionId when provided, for parity with
      // the sibling handlers. It is optional here (the create/edit popup fires
      // before the transaction is persisted), so only enforce when present.
      const validatedTransactionId = transactionId
        ? validateTransactionId(transactionId)
        : undefined;
      if (transactionId && !validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }
      const onProgress = makeMessagesProgressCallback();
      const result = await ensureTransactionMessagesSynced({
        transactionId: validatedTransactionId || undefined,
        userId: validatedUserId as string,
        reason: "date-change",
        proposedStartISO,
        onProgress,
      });
      // Notify open TransactionDetails views to silently refresh their text list.
      emitMessagesSyncComplete(validatedTransactionId || null, result);
      return {
        success: !result.error,
        ran: result.ran,
        importRan: result.importRan,
        reason: result.reason,
        imported: result.imported,
        messagesFloorISO: result.messagesFloorISO,
        skipped: result.skipped,
        error: result.error,
      };
    }, { module: "Transactions" }),
  );

  // Get transaction with contacts
  ipcMain.handle(
    "transactions:get-with-contacts",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      // Validate input
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const transaction = await transactionService.getTransactionWithContacts(
        validatedTransactionId,
      );

      if (!transaction) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      return {
        success: true,
        transaction,
      };
    }, { module: "Transactions" }),
  );

  // Assign contact to transaction
  ipcMain.handle(
    "transactions:assign-contact",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      contactId: string,
      role: string,
      roleCategory: string,
      isPrimary: boolean,
      notes?: string,
    ): Promise<TransactionResponse> => {
      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const validatedContactId = validateContactId(contactId);

      // Validate role and roleCategory as strings
      if (!role || typeof role !== "string" || role.trim().length === 0) {
        throw new ValidationError(
          "Role is required and must be a non-empty string",
          "role",
        );
      }
      if (
        !roleCategory ||
        typeof roleCategory !== "string" ||
        roleCategory.trim().length === 0
      ) {
        throw new ValidationError(
          "Role category is required and must be a non-empty string",
          "roleCategory",
        );
      }

      // Validate isPrimary as boolean
      if (typeof isPrimary !== "boolean") {
        throw new ValidationError("isPrimary must be a boolean", "isPrimary");
      }

      // Validate notes (optional)
      const validatedNotes =
        notes && typeof notes === "string" ? notes.trim() : null;

      // TASK-1031: assignContactToTransaction now auto-links communications
      // for the newly added contact
      const result = await transactionService.assignContactToTransaction(
        validatedTransactionId as string,
        validatedContactId as string,
        role.trim(),
        roleCategory.trim(),
        isPrimary,
        validatedNotes ?? undefined,
      );

      // Log auto-link results if any communications were linked
      if (result.autoLink) {
        const { emailsLinked, messagesLinked } = result.autoLink;
        if (emailsLinked > 0 || messagesLinked > 0) {
          logService.info("Auto-linked communications for new contact", "Transactions", {
            transactionId: validatedTransactionId,
            contactId: validatedContactId,
            emailsLinked,
            messagesLinked,
          });
        }
      }

      return {
        success: true,
        // TASK-1031: Return auto-link results so UI can notify user
        autoLink: result.autoLink,
      };
    }, { module: "Transactions" }),
  );

  // Remove contact from transaction
  ipcMain.handle(
    "transactions:remove-contact",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      contactId: string,
    ): Promise<TransactionResponse> => {
      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const validatedContactId = validateContactId(contactId);

      await transactionService.removeContactFromTransaction(
        validatedTransactionId as string,
        validatedContactId as string,
      );

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-2367: parties previously removed from this transaction.
  //
  // BACKLOG-2366 made removal a tombstone and shipped
  // `getRemovedTransactionContacts` with no caller — its own docblock names this
  // task as the intended consumer. This handler is that consumer: without it the
  // rows are preserved in the database and reachable by nobody, which from the
  // user's seat is indistinguishable from the hard delete the epic replaced.
  ipcMain.handle(
    "transactions:get-removed-contacts",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const removedContacts = await databaseService.getRemovedTransactionContacts(
        validatedTransactionId as string,
      );

      return {
        success: true,
        removedContacts,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-2367: put a removed party back on this transaction.
  //
  // Restores the ORIGINAL junction row (role, role_category, specific_role,
  // is_primary, notes, created_at) rather than inserting a new assignment —
  // see `restoreContactToTransaction`. `restored: false` means the row was
  // already live, which is a stale click rather than an error, so it is
  // reported as a successful no-op with a count of 0 and the UI leaves the
  // list alone.
  ipcMain.handle(
    "transactions:restore-contact",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
      contactId: string,
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const validatedContactId = validateContactId(contactId);
      if (!validatedContactId) {
        throw new ValidationError("Contact ID validation failed", "contactId");
      }

      const restored = await databaseService.restoreContactToTransaction(
        validatedTransactionId as string,
        validatedContactId as string,
      );

      // Audit the restore. Removal writes a trail entry; a compliance product
      // that records who took a party off a deal but not who put them back has
      // recorded half a story.
      //
      // ## Why the action is TRANSACTION_UPDATE and not a new RESTORE verb
      //
      // `audit_logs.action` carries a CHECK constraint (schema.sql) listing the
      // permitted verbs, and no RESTORE verb is among them. Extending it means
      // rebuilding an append-only compliance table, because SQLite cannot ALTER
      // a CHECK. Worse, getting it wrong is SILENT: `auditService.log` swallows
      // write failures by design ("audit failures shouldn't break the app"), so
      // an unpermitted verb would throw inside the catch, write nothing, and
      // still return success to the user. The restore would look fine and the
      // trail would simply be missing.
      //
      // So the verb stays inside the permitted set and `metadata.reason` names
      // the specific act — exactly the idiom BACKLOG-2365 used for removal,
      // where both delete and un-import log CONTACT_DELETE and are told apart
      // by `metadata.reason`.
      if (restored) {
        const transaction = await databaseService.getTransactionById(
          validatedTransactionId as string,
        );
        await auditService.log({
          userId: transaction?.user_id || "unknown",
          action: "TRANSACTION_UPDATE",
          resourceType: "TRANSACTION",
          resourceId: validatedTransactionId as string,
          metadata: { contactId: validatedContactId, reason: "contact_restore" },
          success: true,
        });
      }

      logService.info("Restored contact to transaction", "Transactions", {
        transactionId: validatedTransactionId,
        contactId: validatedContactId,
        restored,
      });

      return {
        success: true,
        restored,
        restoredCount: restored ? 1 : 0,
      };
    }, { module: "Transactions" }),
  );

  // Batch update contact assignments for a transaction
  ipcMain.handle(
    "transactions:batchUpdateContacts",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      operations: Array<{
        action: "add" | "remove";
        contactId: string;
        role?: string;
        roleCategory?: string;
        specificRole?: string;
        isPrimary?: boolean;
        notes?: string;
      }>,
    ): Promise<TransactionResponse> => {
      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Validate operations array
      if (!Array.isArray(operations)) {
        throw new ValidationError(
          "Operations must be an array",
          "operations",
        );
      }

      // Validate each operation
      const validatedOperations = operations.map((op, index) => {
        if (!op.action || (op.action !== "add" && op.action !== "remove")) {
          throw new ValidationError(
            `Invalid action at index ${index}: must be 'add' or 'remove'`,
            "operations",
          );
        }

        const validatedContactId = validateContactId(op.contactId);
        if (!validatedContactId) {
          throw new ValidationError(
            `Invalid contact ID at index ${index}`,
            "operations",
          );
        }

        return {
          action: op.action,
          contactId: validatedContactId,
          role: op.role?.trim(),
          roleCategory: op.roleCategory?.trim(),
          specificRole: op.specificRole?.trim(),
          isPrimary: op.isPrimary ?? false,
          notes: op.notes?.trim(),
        };
      });

      await transactionService.batchUpdateContactAssignments(
        validatedTransactionId as string,
        validatedOperations,
      );

      logService.info(
        "Batch contact assignments updated",
        "Transactions",
        {
          transactionId: validatedTransactionId,
          operationCount: validatedOperations.length,
        },
      );

      const addOperations = validatedOperations.filter(
        (op) => op.action === "add"
      );

      // BACKLOG-820: Fire local auto-link in background (don't block the save response).
      // Previously awaited per-contact, causing 8+ second UI hangs on contact assignment.
      // TASK-2067: Also fire provider fetch in background after auto-link.
      // BACKLOG-2791 (T2): a contact saved ON this deal changes exactly the
      // inputs the matchers read, so discovery runs IMMEDIATELY — no ask-step,
      // no navigation. It QUEUES for review rather than linking.
      //
      // AWAITED, unlike the auto-link it replaces — for ONE deal, the one the
      // user is looking at. BACKLOG-820 removed that await because a per-contact
      // PROVIDER FETCH hung the UI for 8+ seconds; this is local only.
      //
      // MEASURED, because the first version of this comment claimed "indexed"
      // without checking and was half wrong: the email axis is now two indexed
      // searches (it was a FULL `emails` scan until BACKLOG-2791 restructured
      // the query), and the text axis is `SEARCH m USING INDEX
      // idx_messages_user_sent` — the deal's own date window, with the phone
      // LIKE as a residual filter, NOT a full `messages` scan. One deal, one
      // window: bounded enough to await. The multi-deal loop in contacts:update
      // is NOT awaited for exactly this reason. The provider fetch below stays
      // fire-and-forget, so the 820 regression cannot return.
      let review: { added: number; linked: number; outstanding: number } | undefined;
      if (addOperations.length > 0) {
        try {
          const { autoLinkCommunicationsForContact } = await import(
            "../services/autoLinkService"
          );
          const { countReviewItems } = await import("../services/reviewStateService");
          let linked = 0;
          let added = 0;
          for (const op of addOperations) {
            const r = await autoLinkCommunicationsForContact({
              contactId: op.contactId,
              transactionId: validatedTransactionId as string,
              // BACKLOG-2791: develop's split — confident emails and every text
              // link; the address-missing half waits for approval.
              queueAmbiguousInsteadOfLinking: true,
            });
            linked += r.emailsLinked + r.messagesLinked;
            added += r.queuedForReview ?? 0;
          }
          review = {
            added,
            linked,
            outstanding: countReviewItems(validatedTransactionId as string),
          };
        } catch (error) {
          logService.warn("[BACKLOG-2791] discovery failed after contact save", "Transactions", {
            error: error instanceof Error ? error.message : "Unknown",
          });
        }

        // Provider fetch + re-link (fire-and-forget)
        databaseService.getTransactionById(validatedTransactionId as string)
          .then((transaction) => {
            if (!transaction) return;
            for (const op of addOperations) {
              emailSyncService.fetchAndAutoLinkForContact({
                userId: transaction.user_id,
                transactionId: validatedTransactionId as string,
                contactId: op.contactId,
                transactionDetails: {
                  started_at: transaction.started_at,
                  created_at: transaction.created_at,
                  closed_at: transaction.closed_at,
                },
                // BACKLOG-2791: deal surface — queue, never link silently.
                queueForReviewInsteadOfLinking: true,
              }).then((fetchResult) => {
                logService.info(
                  "Background provider fetch + auto-link complete",
                  "Transactions",
                  {
                    contactId: op.contactId,
                    emailsFetched: fetchResult.emailsFetched,
                    emailsStored: fetchResult.emailsStored,
                    emailsLinked: fetchResult.autoLinkResult.emailsLinked,
                    messagesLinked: fetchResult.autoLinkResult.messagesLinked,
                  }
                );
              }).catch((error) => {
                logService.warn(
                  `Background provider fetch failed for contact ${op.contactId}`,
                  "Transactions",
                  {
                    error: error instanceof Error ? error.message : "Unknown",
                  }
                );
              });
            }
          })
          .catch((error) => {
            logService.warn(
              "Failed to get transaction for background provider fetch",
              "Transactions",
              { error: error instanceof Error ? error.message : "Unknown" }
            );
          });
      }

      // BACKLOG-2791: this used to return a bare { success: true }, so the
      // renderer's `autoLinkResults` branch (EditContactsModal ->
      // TransactionDetails toast) was unreachable dead code, and loadDetails()
      // raced the fire-and-forget link. `review` is the real, AWAITED result of
      // the save — what lets the caller show "N new communications found"
      // without a second round trip, and without claiming links never made.
      return {
        success: true,
        review,
      };
    }, { module: "Transactions" }),
  );

  // Unlink communication (email) from transaction
  ipcMain.handle(
    "transactions:unlink-communication",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      communicationId: string,
      reason?: string,
    ): Promise<TransactionResponse> => {
      logService.info("Unlinking communication from transaction", "Transactions", {
        communicationId,
        reason,
      });

      // Validate communication ID (using same format as contact ID)
      if (
        !communicationId ||
        typeof communicationId !== "string" ||
        communicationId.trim().length === 0
      ) {
        return {
          success: false,
          error: "Invalid communication ID",
        };
      }

      // BACKLOG-1778: capture the removed communication ids (clicked row +
      // thread siblings) so the renderer can drop exactly those rows in place
      // instead of refetching the whole email list (which reset scroll — the
      // 1765 regression).
      const { unlinkedIds } = await transactionService.unlinkCommunication(
        communicationId.trim(),
        reason,
      );

      logService.info("Communication unlinked successfully", "Transactions", {
        communicationId,
        unlinkedCount: unlinkedIds.length,
      });

      return {
        success: true,
        unlinkedIds,
      };
    }, { module: "Transactions" }),
  );

  // Re-analyze property (rescan emails for specific address)
  ipcMain.handle(
    "transactions:reanalyze",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      provider: string,
      propertyAddress: string,
      dateRange?: unknown,
    ): Promise<TransactionResponse> => {
      // Validate inputs
      const validatedUserId = validateUserId(userId);
      const validatedProvider = validateProvider(provider);

      // Validate property address
      if (
        !propertyAddress ||
        typeof propertyAddress !== "string" ||
        propertyAddress.trim().length < 5
      ) {
        throw new ValidationError(
          "Property address is required and must be at least 5 characters",
          "propertyAddress",
        );
      }

      // Validate dateRange (optional object with start/end)
      const sanitizedDateRange = sanitizeObject(dateRange || {});

      const result = await transactionService.reanalyzeProperty(
        validatedUserId as string,
        validatedProvider as OAuthProvider,
        propertyAddress.trim(),
        sanitizedDateRange as { start?: Date; end?: Date },
      );

      return {
        success: true,
        ...result,
      };
    }, { module: "Transactions" }),
  );

  // Bulk delete transactions
  ipcMain.handle(
    "transactions:bulk-delete",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionIds: string[],
    ): Promise<TransactionResponse> => {
      logService.info("Starting bulk delete", "Transactions", {
        count: transactionIds?.length || 0,
      });

      // Validate input
      if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
        throw new ValidationError(
          "Transaction IDs must be a non-empty array",
          "transactionIds",
        );
      }

      // Validate each transaction ID
      const validatedIds: string[] = [];
      for (const id of transactionIds) {
        const validatedId = validateTransactionId(id);
        if (!validatedId) {
          throw new ValidationError(
            `Invalid transaction ID: ${id}`,
            "transactionIds",
          );
        }
        validatedIds.push(validatedId);
      }

      // Delete each transaction
      let deletedCount = 0;
      const errors: string[] = [];

      for (const transactionId of validatedIds) {
        try {
          // Get transaction before delete for audit logging
          const existingTransaction =
            await transactionService.getTransactionDetails(transactionId);
          const userId = existingTransaction?.user_id || "unknown";
          const propertyAddress =
            existingTransaction?.property_address || "unknown";

          await transactionService.deleteTransaction(transactionId);

          // Audit log transaction deletion
          await auditService.log({
            userId,
            action: "TRANSACTION_DELETE",
            resourceType: "TRANSACTION",
            resourceId: transactionId,
            metadata: { propertyAddress, bulkOperation: true },
            success: true,
          });

          deletedCount++;
        } catch (err) {
          errors.push(
            `Failed to delete ${transactionId}: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      }

      logService.info("Bulk delete completed", "Transactions", {
        deletedCount,
        errorCount: errors.length,
      });

      return {
        success: errors.length === 0,
        deletedCount,
        errors: errors.length > 0 ? errors : undefined,
      };
    }, { module: "Transactions" }),
  );

  // Bulk update transaction status
  ipcMain.handle(
    "transactions:bulk-update-status",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionIds: string[],
      status: string,
    ): Promise<TransactionResponse> => {
      logService.info("Starting bulk status update", "Transactions", {
        count: transactionIds?.length || 0,
        status,
      });

      // Validate input
      if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
        throw new ValidationError(
          "Transaction IDs must be a non-empty array",
          "transactionIds",
        );
      }

      // Validate status - allow all 4 transaction statuses
      if (!status || !["pending", "active", "closed", "rejected"].includes(status)) {
        throw new ValidationError(
          "Status must be 'pending', 'active', 'closed', or 'rejected'",
          "status",
        );
      }

      // Validate each transaction ID
      const validatedIds: string[] = [];
      for (const id of transactionIds) {
        const validatedId = validateTransactionId(id);
        if (!validatedId) {
          throw new ValidationError(
            `Invalid transaction ID: ${id}`,
            "transactionIds",
          );
        }
        validatedIds.push(validatedId);
      }

      // TASK-984: Validate that manual transactions cannot be set to pending/rejected
      // These statuses are only meaningful for AI-detected transactions
      if (status === "pending" || status === "rejected") {
        const manualTransactionIds: string[] = [];
        for (const transactionId of validatedIds) {
          const tx = await transactionService.getTransactionDetails(transactionId);
          if (tx?.detection_source === "manual") {
            manualTransactionIds.push(transactionId);
          }
        }

        if (manualTransactionIds.length > 0) {
          throw new ValidationError(
            `Cannot set manual transactions to "${status}". Manual transactions can only be "active" or "closed".`,
            "status",
          );
        }
      }

      // Update each transaction
      let updatedCount = 0;
      const errors: string[] = [];

      for (const transactionId of validatedIds) {
        try {
          // Get transaction before update for audit logging
          const existingTransaction =
            await transactionService.getTransactionDetails(transactionId);
          const userId = existingTransaction?.user_id || "unknown";

          await transactionService.updateTransaction(transactionId, {
            status: status as "pending" | "active" | "closed" | "rejected",
          });

          // Audit log transaction update
          await auditService.log({
            userId,
            action: "TRANSACTION_UPDATE",
            resourceType: "TRANSACTION",
            resourceId: transactionId,
            metadata: { updatedFields: ["status"], newStatus: status, bulkOperation: true },
            success: true,
          });

          updatedCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          logService.error("Failed to update transaction status", "Transactions", {
            transactionId,
            status,
            error: errorMsg,
            stack: err instanceof Error ? err.stack : undefined,
          });
          errors.push(`Failed to update ${transactionId}: ${errorMsg}`);
        }
      }

      logService.info("Bulk status update completed", "Transactions", {
        updatedCount,
        errorCount: errors.length,
      });

      return {
        success: errors.length === 0,
        updatedCount,
        errors: errors.length > 0 ? errors : undefined,
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // AUTO-DETECT START DATE (TASK-1974)
  // ============================================

  /**
   * Get the earliest communication date for a set of contacts.
   * Used by the audit wizard to auto-detect the transaction start date.
   */
  ipcMain.handle(
    "transactions:get-earliest-communication-date",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      contactIds: string[],
      userId: string,
    ): Promise<{ success: boolean; date?: string | null; error?: string }> => {
      validateUserId(userId);

      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return { success: true, date: null };
      }

      // Validate each contact ID
      for (const id of contactIds) {
        validateContactId(id);
      }

      const date = getEarliestCommunicationDate(contactIds, userId);

      return { success: true, date: date || null };
    }, { module: "Transactions" }),
  );

  // ============================================

  /**
   * BACKLOG-1832: Mount-time inflight-sync query.
   *
   * The `transactions:auto-sync-started` push event is fired synchronously
   * inside the CREATE IPC handler — BEFORE the renderer navigates and mounts
   * TransactionDetails, so the event is always missed by the component's
   * subscription. This query channel lets TransactionDetails check, on mount,
   * whether the background sync is still in flight so it can show the spinner
   * retroactively without polling.
   */
  ipcMain.handle(
    "transactions:is-auto-sync-in-flight",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: unknown,
    ): Promise<{ success: boolean; inFlight: boolean }> => {
      const validatedId = typeof transactionId === "string" && transactionId.trim()
        ? transactionId.trim()
        : null;
      return { success: true, inFlight: validatedId ? isAutoSyncInFlight(validatedId) : false };
    }, { module: "Transactions" }),
  );

  // ============================================
  // BACKLOG-2013 — ADMIN / SUPPORT UNFREEZE
  // ============================================
  //
  // Clears the export-freeze marker so a genuine post-export typo can be
  // corrected. MINIMAL surface for now: a guarded IPC + audited db write. A
  // richer admin-portal UI is a deferred follow-up. Requires a non-empty
  // `reason` (compliance: every unfreeze must be justified + audit-logged).
  ipcMain.handle(
    "transactions:admin-unfreeze",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: unknown,
      reason: unknown,
      actor?: unknown,
    ): Promise<TransactionResponse & { wasFrozen?: boolean }> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const trimmedReason =
        typeof reason === "string" ? reason.trim() : "";
      if (trimmedReason.length === 0) {
        return {
          success: false,
          error: "An unfreeze reason is required (compliance).",
        };
      }

      const actorLabel =
        typeof actor === "string" && actor.trim().length > 0
          ? actor.trim()
          : undefined;

      const result = await transactionService.adminUnfreezeTransaction(
        validatedTransactionId,
        trimmedReason,
        actorLabel,
      );

      logService.info("Transaction unfrozen (admin)", "Transactions", {
        transactionId: validatedTransactionId,
        wasFrozen: result.wasFrozen,
      });

      return { success: true, wasFrozen: result.wasFrozen };
    }, { module: "Transactions" }),
  );
}
