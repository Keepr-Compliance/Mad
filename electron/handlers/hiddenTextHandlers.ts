// ============================================
// HIDE TEXTS FROM EXPORT — IPC HANDLERS (BACKLOG-3366)
// Handles: transactions:hide-text-from-export,
//          transactions:unhide-text-from-export
// ============================================
//
// A hidden text stays linked to the transaction and stays visible (gray) in
// the conversation view; only the export drops it (BACKLOG-3367). These
// handlers write nothing but `transaction_hidden_texts` and an audit entry.
//
// TWO CHANNELS, ON PURPOSE. Hiding is an entitlement; unhiding is not. With
// one channel and a direction flag, "gate only one direction" is a condition
// someone can get wrong; with two, the hide channel calls the check and the
// unhide channel does not import it at all. A user who loses the entitlement
// must always be able to put a text back into their export.

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import auditService from "../services/auditService";
import databaseService from "../services/databaseService";
import {
  hideTextFromExport,
  isTextHiddenFromExport,
  unhideTextFromExport,
} from "../services/db/hiddenTextDbService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError, validateTransactionId } from "../utils/validation";
// BACKLOG-3365 repoints this import at the real fail-closed check and deletes
// the stub module. Only the hide channel may use it.
import { isHideFromExportAllowed } from "./hideFromExportGateStub";

export interface HiddenTextResponse {
  success: boolean;
  /** Whether the text is hidden after the call, read back from the database. */
  hidden?: boolean;
  error?: string;
}

/** Shown when hiding is refused by the entitlement check. */
export const HIDE_FROM_EXPORT_NOT_ALLOWED_ERROR =
  "Hiding texts from export is not available.";

/** Shown when the message is not a text linked to this transaction. */
export const HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR =
  "That text is not part of this transaction.";

function requireTransactionId(transactionId: unknown): string {
  const validated = validateTransactionId(transactionId);
  if (!validated) {
    throw new ValidationError("Transaction ID validation failed", "transactionId");
  }
  return validated;
}

function requireMessageId(messageId: unknown): string {
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw new ValidationError("Message ID must be a non-empty string", "messageId");
  }
  return messageId.trim();
}

export function registerHiddenTextHandlers(): void {
  ipcMain.handle(
    "transactions:hide-text-from-export",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        transactionId: string,
        messageId: string,
      ): Promise<HiddenTextResponse> => {
        const validatedTransactionId = requireTransactionId(transactionId);
        const validatedMessageId = requireMessageId(messageId);

        // The renderer hides the control when hiding is not allowed, but the
        // renderer is not the authority. Refused here, before any read or write.
        // Returned rather than thrown: a refusal is an expected answer, not an
        // error to report.
        if (!(await isHideFromExportAllowed())) {
          return { success: false, error: HIDE_FROM_EXPORT_NOT_ALLOWED_ERROR };
        }

        const transaction = await databaseService.getTransactionById(validatedTransactionId);
        if (!transaction) {
          return { success: false, error: "Transaction not found" };
        }

        const added = await hideTextFromExport({
          transactionId: validatedTransactionId,
          messageId: validatedMessageId,
          userId: transaction.user_id,
        });

        // Audit only a real change. `TRANSACTION_UPDATE` is inside the
        // audit_logs CHECK; `metadata.reason` names the act, the same idiom as
        // contact restore (transactionCrudHandlers).
        if (added) {
          await auditService.log({
            userId: transaction.user_id,
            action: "TRANSACTION_UPDATE",
            resourceType: "TRANSACTION",
            resourceId: validatedTransactionId,
            metadata: {
              reason: "text_hidden_from_export",
              transactionId: validatedTransactionId,
              messageId: validatedMessageId,
            },
            success: true,
          });
        }

        // Observe the outcome instead of inferring it from `added`: false covers
        // both "already hidden" and "not a text of this transaction".
        const hidden = await isTextHiddenFromExport({
          transactionId: validatedTransactionId,
          messageId: validatedMessageId,
        });

        logService.info("Hide text from export", "Transactions", {
          transactionId: validatedTransactionId,
          added,
          hidden,
        });

        if (!hidden) {
          return { success: false, hidden, error: HIDE_FROM_EXPORT_NOT_ELIGIBLE_ERROR };
        }
        return { success: true, hidden };
      },
      { module: "Transactions" },
    ),
  );

  // Never gated, never frozen: putting a text back into the export is always
  // allowed, including after the entitlement is lost or the deal is exported.
  ipcMain.handle(
    "transactions:unhide-text-from-export",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        transactionId: string,
        messageId: string,
      ): Promise<HiddenTextResponse> => {
        const validatedTransactionId = requireTransactionId(transactionId);
        const validatedMessageId = requireMessageId(messageId);

        const transaction = await databaseService.getTransactionById(validatedTransactionId);
        if (!transaction) {
          return { success: false, error: "Transaction not found" };
        }

        const removed = await unhideTextFromExport({
          transactionId: validatedTransactionId,
          messageId: validatedMessageId,
        });

        if (removed > 0) {
          await auditService.log({
            userId: transaction.user_id,
            action: "TRANSACTION_UPDATE",
            resourceType: "TRANSACTION",
            resourceId: validatedTransactionId,
            metadata: {
              reason: "text_unhidden_from_export",
              transactionId: validatedTransactionId,
              messageId: validatedMessageId,
            },
            success: true,
          });
        }

        const hidden = await isTextHiddenFromExport({
          transactionId: validatedTransactionId,
          messageId: validatedMessageId,
        });

        logService.info("Unhide text from export", "Transactions", {
          transactionId: validatedTransactionId,
          removed,
          hidden,
        });

        return { success: !hidden, hidden };
      },
      { module: "Transactions" },
    ),
  );
}
