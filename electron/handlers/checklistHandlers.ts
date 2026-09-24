/**
 * Transaction checklist IPC — BACKLOG-3475.
 *
 * Nine channels over the local tables PR-A created and the broker templates
 * `checklistTemplateService` reads from the cloud.
 *
 * ## Which channels are gated, and why the other three are not
 *
 * SIX of the nine call {@link isChecklistsAllowed} before any read or write:
 * `list-templates`, `select-template`, `set-item-checked`, `set-item-note`,
 * `add-link`, `remove-link`.
 *
 * THREE do not. `checklists:get` and `checklists:remove` are the unhide rule
 * spelled out in `electron/types/featureGate.ts`: a user whose plan later loses
 * the feature must still be able to see what is on his own transaction and take
 * it off again. Gating either would strand rows where he can neither use them
 * nor be rid of them. `checklists:invalidate-templates` is the third — it only
 * throws cached data away.
 *
 * Do not take that split from this paragraph. It is asserted by execution in
 * `checklistHandlers-3475.test.ts` ("the gated and ungated sets, by
 * execution"), which invokes every registered `checklists:` channel with the
 * plan unreadable and partitions them by what each one answers — so a tenth
 * channel, or a gate added or dropped, reds a test rather than leaving a
 * sentence to be trusted.
 *
 * **No handler here names the feature key.** `isChecklistsAllowed()` is the
 * single entry point, which is what gives the control set one place to mutate
 * and makes a handler that forgot the call distinguishable from one that never
 * needed it.
 *
 * ## Refusals are returned, not thrown
 *
 * "Your plan does not include this", "that template is gone" and "we could not
 * read your brokerage's templates" are answers a surface has to render, not
 * errors to report. They come back as `{ success: false, error }`, the same way
 * `hiddenTextHandlers` does it. Only a malformed payload throws, through
 * `ValidationError`, which `wrapHandler` turns into the same shape.
 *
 * ## The organization is resolved in ONE place
 *
 * `resolveOrgId()` — the feature gate's resolver, the same membership lookup
 * the gate itself used one line earlier. Deliberately NOT
 * `submissionService.getUserOrganizationId()`, which answers a different
 * question: it excludes personal organizations (so every solo user would read
 * as having none) and does not filter on `license_status`. Two resolvers is how
 * two halves of an app come to disagree about who the user is, and here it
 * would mean the gate said yes about one organization while the read asked
 * about another.
 */

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import auditService from "../services/auditService";
import checklistTemplateService from "../services/checklistTemplateService";
import databaseService from "../services/databaseService";
import {
  addChecklistLink,
  getChecklistsForTransaction,
  removeChecklist,
  removeChecklistLink,
  selectChecklistTemplate,
  setChecklistItemChecked,
  setChecklistItemNote,
} from "../services/db/checklistDbService";
import logService from "../services/logService";
import {
  AddChecklistLinkArgsSchema,
  GetChecklistArgsSchema,
  RemoveChecklistArgsSchema,
  RemoveChecklistLinkArgsSchema,
  SelectChecklistTemplateArgsSchema,
  SetChecklistItemCheckedArgsSchema,
  SetChecklistItemNoteArgsSchema,
} from "../schemas/checklist";
import { safeValidate } from "../schemas/validate";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError } from "../utils/validation";
// The real fail-closed plan check. `checklists:get`, `checklists:remove` and
// `checklists:invalidate-templates` deliberately do not call it — the header
// says why, and `checklistHandlers-3475.test.ts` ("the gated and ungated sets,
// by execution") asserts the split. Nothing here may name the feature key.
import { isChecklistsAllowed, resolveOrgId } from "./featureGateHandlers";
import type {
  AddChecklistLinkResult,
  ChecklistsForTransaction,
  SelectChecklistTemplateResult,
} from "../types/checklist";
import type { ListChecklistTemplatesResult } from "../types/ipc/window-api-checklists";

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The shared union (BACKLOG-3476), not a copy of it: `templates` exists exactly
 * on the success arm. An EMPTY array is a real answer — this brokerage has not
 * made any templates — and a failed read has no `templates` to be empty. A
 * branch below that answered `success: true` without a listing would not
 * compile.
 */
export type ListChecklistTemplatesResponse = ListChecklistTemplatesResult;

export interface GetChecklistResponse {
  success: boolean;
  /** Every checklist on the transaction; an empty list when it has none. */
  checklists?: ChecklistsForTransaction;
  error?: string;
}

export interface SelectChecklistTemplateResponse {
  success: boolean;
  /**
   * The db layer's own outcome, carried through unchanged. `exists`,
   * `no_checklist` and `no_transaction` arrive here with `success: true` because the call ran and
   * answered; what it answered is the surface's to render.
   */
  result?: SelectChecklistTemplateResult;
  error?: string;
}

export interface AddChecklistLinkResponse {
  success: boolean;
  result?: AddChecklistLinkResult;
  error?: string;
}

/** Every write that either changed a row or did not. */
export interface ChecklistWriteResponse {
  success: boolean;
  changed?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Refusal messages
// ---------------------------------------------------------------------------

/** The plan does not carry checklists, or the plan could not be read. */
export const CHECKLISTS_NOT_ALLOWED_ERROR =
  "Transaction checklists are not available.";

/**
 * No organization answered for this account. Distinct from the gate's refusal:
 * the gate can say no for a plan reason, this is "we do not know whose
 * templates to ask for".
 */
export const CHECKLISTS_NO_ORGANIZATION_ERROR =
  "No brokerage is associated with this account.";

/**
 * The templates could not be READ. Deliberately not the same sentence as an
 * empty list — telling a user their brokerage has no checklists when the truth
 * is that the network failed is a false statement about someone else's account.
 */
export const CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR =
  "Your brokerage's checklist templates could not be loaded right now.";

/** The requested template is not in the listing (archived, deleted, or renamed away). */
export const CHECKLIST_TEMPLATE_NOT_FOUND_ERROR =
  "That checklist template is no longer available.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Write one audit row for an act that destroys or replaces a whole checklist.
 *
 * Ticking an item writes none: `checked_at` IS the record of it, held against
 * `is_checked` by a CHECK in schema.sql so the two cannot disagree. A row per
 * tick would duplicate that while adding a write to the most frequent action in
 * the feature.
 */
async function auditChecklistAct(
  transactionId: string,
  reason: "checklist_selected" | "checklist_replaced" | "checklist_removed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const transaction = await databaseService.getTransactionById(transactionId);
  if (!transaction) return;
  await auditService.log({
    userId: transaction.user_id,
    action: "TRANSACTION_UPDATE",
    resourceType: "TRANSACTION",
    resourceId: transactionId,
    metadata: { reason, transactionId, ...extra },
    success: true,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerChecklistHandlers(): void {
  /**
   * The broker templates this user may pick from.
   *
   * Gated: this is the only checklist channel that leaves the machine, and what
   * it reads is the plan holder's data rather than the user's own.
   */
  ipcMain.handle(
    "checklists:list-templates",
    wrapHandler(
      async (_event: IpcMainInvokeEvent): Promise<ListChecklistTemplatesResponse> => {
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }

        const orgId = await resolveOrgId();
        if (!orgId) {
          return { success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR };
        }

        const listing = await checklistTemplateService.listTemplates(orgId);
        if (!listing) {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        return { success: true, templates: listing.templates, source: listing.source };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Copy a template onto a transaction: add a checklist, or replace the one
   * named by `replaceChecklistId`.
   *
   * The items come from the template listing, not from the renderer: a caller
   * that supplied its own items could write any title it liked into a row the
   * export renders. The whole copy is one database transaction inside
   * `selectChecklistTemplate` — this handler never removes and then
   * instantiates, which would leave a failure between the two with the
   * checklist destroyed and not replaced.
   */
  ipcMain.handle(
    "checklists:select-template",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        payload: unknown,
      ): Promise<SelectChecklistTemplateResponse> => {
        const args = parseArgs(SelectChecklistTemplateArgsSchema, payload, "payload");

        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }

        const orgId = await resolveOrgId();
        if (!orgId) {
          return { success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR };
        }

        const listing = await checklistTemplateService.listTemplates(orgId);
        if (!listing) {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        const template = listing.templates.find((t) => t.id === args.templateId);
        if (!template) {
          return { success: false, error: CHECKLIST_TEMPLATE_NOT_FOUND_ERROR };
        }

        const result = await selectChecklistTemplate({
          transactionId: args.transactionId,
          templateId: template.id,
          templateName: template.name,
          items: template.items.map((item) => ({
            title: item.title,
            description: item.description,
            isRequired: item.isRequired,
            expectedDocumentType: item.expectedDocumentType,
            sortOrder: item.sortOrder,
          })),
          replaceChecklistId: args.replaceChecklistId,
        });

        if (result.status === "added") {
          await auditChecklistAct(args.transactionId, "checklist_selected", {
            templateId: template.id,
            checklistId: result.checklistId,
          });
        } else if (result.status === "replaced") {
          await auditChecklistAct(args.transactionId, "checklist_replaced", {
            templateId: template.id,
            checklistId: result.checklistId,
            previousChecklistId: result.previousChecklistId,
          });
        }

        logService.info("Checklist template selected", "Checklists", {
          transactionId: args.transactionId,
          templateId: template.id,
          status: result.status,
        });
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Every checklist on one transaction and everything each needs, in one read.
   *
   * **Not gated.** A local read of the user's own rows, and 3476 has to be able
   * to render a checklist in order to explain why it is stale to someone whose
   * plan no longer carries the feature.
   */
  ipcMain.handle(
    "checklists:get",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<GetChecklistResponse> => {
        const args = parseArgs(GetChecklistArgsSchema, payload, "payload");
        const checklists = await getChecklistsForTransaction(args.transactionId);
        return { success: true, checklists };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:set-item-checked",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(SetChecklistItemCheckedArgsSchema, payload, "payload");
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const changed = await setChecklistItemChecked(args.itemId, args.checked);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:set-item-note",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(SetChecklistItemNoteArgsSchema, payload, "payload");
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const changed = await setChecklistItemNote(args.itemId, args.note);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Attach evidence to an item as one group.
   *
   * Every target is checked against the item's own transaction inside
   * `addChecklistLink`, and the label is derived there from the target rows.
   * Neither is this handler's to decide, and neither is the renderer's.
   */
  ipcMain.handle(
    "checklists:add-link",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<AddChecklistLinkResponse> => {
        const args = parseArgs(AddChecklistLinkArgsSchema, payload, "payload");
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const result = await addChecklistLink({
          itemId: args.itemId,
          kind: args.kind,
          targetIds: args.targetIds,
        });
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:remove-link",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(RemoveChecklistLinkArgsSchema, payload, "payload");
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const changed = await removeChecklistLink(args.linkId);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Take ONE checklist off a transaction. Its items, groups and members follow
   * by cascade; every other checklist on the transaction is untouched.
   *
   * **Not gated, on the unhide rule.** A user whose plan stops including
   * checklists must still be able to clear one off his own transaction.
   */
  ipcMain.handle(
    "checklists:remove",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(RemoveChecklistArgsSchema, payload, "payload");
        const removed = await removeChecklist(args.transactionId, args.checklistId);
        if (removed) {
          await auditChecklistAct(args.transactionId, "checklist_removed", {
            checklistId: removed.id,
            templateId: removed.templateId,
          });
        }
        return { success: true, changed: removed !== null };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Throw the cached templates away so the next listing goes to the cloud.
   * Not gated: it only discards data.
   */
  ipcMain.handle(
    "checklists:invalidate-templates",
    wrapHandler(
      async (_event: IpcMainInvokeEvent): Promise<ChecklistWriteResponse> => {
        await checklistTemplateService.invalidate();
        return { success: true };
      },
      { module: "Checklists" },
    ),
  );
}
