// ============================================
// REVIEW QUEUE IPC HANDLERS (BACKLOG-2791 / BACKLOG-2792)
// Handles: review:get-state, review:sync, review:approve, review:reject
// ============================================
//
// Every one of these delegates to reviewStateService, which is the ONE source of
// truth for review state (founder ruling 2026-08-22). No handler here queries
// either backing store directly, and none may start to — the
// singleReadPath-2791 suite fails the moment a second read path appears.

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  getReviewState,
  syncReviewQueueForTransaction,
  approveReviewItems,
  rejectReviewItems,
  type ReviewState,
  type PendingSyncResult,
  type PendingSyncReason,
} from "../services/reviewStateService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError, validateTransactionId } from "../utils/validation";

function requireTransactionId(transactionId: string): string {
  const validated = validateTransactionId(transactionId);
  if (!validated) {
    throw new ValidationError("Transaction ID validation failed", "transactionId");
  }
  return validated;
}

function requireItemIds(itemIds: unknown): string[] {
  if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== "string" || !id)) {
    throw new ValidationError("itemIds must be a non-empty array of strings", "itemIds");
  }
  return itemIds as string[];
}

export function registerReviewQueueHandlers(): void {
  /** The combined queue: pending + legacy, one set, for every surface. */
  ipcMain.handle(
    "review:get-state",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        transactionId: string,
      ): Promise<ReviewState> => getReviewState(requireTransactionId(transactionId)),
    ),
  );

  /**
   * Run the discovery sync. `reason` picks the scan axis:
   *   "open"           → only records ingested since the watermark (T1)
   *   "contact-change" → the full window, but only the changed identities (T2)
   */
  ipcMain.handle(
    "review:sync",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        transactionId: string,
        reason: PendingSyncReason,
        contactIds?: string[],
      ): Promise<PendingSyncResult> => {
        const validated = requireTransactionId(transactionId);
        const safeReason: PendingSyncReason =
          reason === "contact-change" || reason === "background" ? reason : "open";
        const result = await syncReviewQueueForTransaction({
          transactionId: validated,
          reason: safeReason,
          contactIds: Array.isArray(contactIds) ? contactIds : undefined,
        });
        logService.debug("Review sync complete", "ReviewQueue", {
          transactionId: validated,
          reason: safeReason,
          added: result.added,
          outstanding: result.outstanding,
        });
        return result;
      },
    ),
  );

  /** Approve — THIS is what links a pending item, per the normal rules. */
  ipcMain.handle(
    "review:approve",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        itemIds: string[],
      ): Promise<{ approved: number }> => approveReviewItems(requireItemIds(itemIds)),
    ),
  );

  /** Reject — durable; the suppression row keeps a later sync from resurrecting it. */
  ipcMain.handle(
    "review:reject",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        itemIds: string[],
      ): Promise<{ rejected: number }> => rejectReviewItems(requireItemIds(itemIds)),
    ),
  );
}
