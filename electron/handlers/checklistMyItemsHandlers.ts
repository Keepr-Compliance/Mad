/**
 * The agent's own checklist ("My items") — BACKLOG-3966 PR-2.
 *
 * Four write channels over the deal's private checklist (`checklistPrivacy.ts`):
 * `checklists:add-my-item`, `checklists:rename-my-item`,
 * `checklists:reorder-my-items`, `checklists:remove-my-item`. Registered from
 * `registerChecklistHandlers`, so every sweep over the checklist channels
 * (the 3475 gate partition, the 3910d lock sweep) sees them.
 *
 * Ticking, notes and evidence on a private item go through the EXISTING item
 * channels (`set-item-checked`, `set-item-note`, `add-link`, `remove-link`),
 * which apply the per-checklist plan rule in `checklistHandlers.ts`. There is
 * no second write path for those.
 *
 * ## Not plan-gated, always lock-gated
 *
 * My items work on every plan (founder decision on 3966), so none of these
 * calls `isChecklistsAllowed`. Each names the deal, and its SQL is scoped to
 * THAT deal's private checklist: an item id from a template checklist, or from
 * another deal, matches no row and nothing changes. A locked deal (submitted,
 * under review, resubmitted, approved) refuses every one of them, with the
 * same answer shape every other checklist write uses (SR plan review ruling 4).
 *
 * ## No audit entry
 *
 * None of these records an audit act. Audit rows upload to the cloud and the
 * admin portal reads them (SR plan review R4); the private checklist never
 * leaves the machine, and its titles must not either. Ticks record none for
 * the same reason the 3475 handlers give: the row is the record.
 *
 * ## Renderer callers
 *
 * None yet: the My items section (BACKLOG-3966 U1) is the first. The channels
 * are reached through `window.api.checklists` (`checklistBridge.ts`) and
 * `src/services/checklistService.ts`.
 */

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import { addMyItem, removeMyItem, renameMyItem, reorderMyItems } from "../services/db/checklistDbService";
import { refuseIfDealLocked } from "../services/dealLockState";
import {
  AddMyItemArgsSchema,
  RemoveMyItemArgsSchema,
  RenameMyItemArgsSchema,
  ReorderMyItemsArgsSchema,
} from "../schemas/checklist";
import { safeValidate } from "../schemas/validate";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError } from "../utils/validation";
import type { AddMyItemResult, ReorderMyItemsResult } from "../types/checklist";

export interface AddMyItemResponse {
  success: boolean;
  result?: AddMyItemResult;
  error?: string;
}

export interface ReorderMyItemsResponse {
  success: boolean;
  result?: ReorderMyItemsResult;
  error?: string;
}

export interface MyItemWriteResponse {
  success: boolean;
  changed?: boolean;
  error?: string;
}

function parseArgs<T>(
  schema: Parameters<typeof safeValidate<T>>[0],
  payload: unknown,
  field: string,
): T {
  const parsed = safeValidate(schema, payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid payload", field);
  }
  return parsed.data;
}

export function registerChecklistMyItemsHandlers(): void {
  /** Add one of the agent's own items; the private checklist is made on the first. */
  ipcMain.handle(
    "checklists:add-my-item",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<AddMyItemResponse> => {
        const args = parseArgs(AddMyItemArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "add-my-item");
        if (lockedRefusal) return lockedRefusal;
        const result = await addMyItem(args.transactionId, args.title);
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:rename-my-item",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<MyItemWriteResponse> => {
        const args = parseArgs(RenameMyItemArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "rename-my-item");
        if (lockedRefusal) return lockedRefusal;
        const changed = await renameMyItem(args.transactionId, args.itemId, args.title);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );

  /** The section's items in a new order: every one of them, once, or nothing moves. */
  ipcMain.handle(
    "checklists:reorder-my-items",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ReorderMyItemsResponse> => {
        const args = parseArgs(ReorderMyItemsArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "reorder-my-items");
        if (lockedRefusal) return lockedRefusal;
        const result = await reorderMyItems(args.transactionId, args.itemIds);
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:remove-my-item",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<MyItemWriteResponse> => {
        const args = parseArgs(RemoveMyItemArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "remove-my-item");
        if (lockedRefusal) return lockedRefusal;
        const changed = await removeMyItem(args.transactionId, args.itemId);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );
}
