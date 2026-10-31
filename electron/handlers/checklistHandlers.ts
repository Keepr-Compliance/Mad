/**
 * Transaction checklist IPC — BACKLOG-3475.
 *
 * Thirteen channels over the local tables PR-A created and the broker templates
 * `checklistTemplateService` reads from the cloud (nine from BACKLOG-3475, two
 * from BACKLOG-3617: `can-edit-templates`, `open-templates-portal`; one from
 * BACKLOG-3764: `include-link-outside-dates`; one from BACKLOG-3965:
 * `list-open-required`).
 *
 * ## Which channels are gated, and why the other four are not
 *
 * NINE of the thirteen call {@link isChecklistsAllowed} before any read or write:
 * `list-templates`, `select-template`, `set-item-checked`, `set-item-note`,
 * `add-link`, `remove-link`, `include-link-outside-dates`,
 * `can-edit-templates`, `list-open-required`.
 *
 * `list-open-required` (the Dashboard's Todo list, BACKLOG-3965) is a read and
 * is gated anyway: the unhide rule below protects a user's view of HIS OWN
 * transaction, which `checklists:get` still serves ungated. A cross-deal
 * list of work still to do is a feature surface, hidden when the plan does not
 * include checklists, so main refuses it too rather than trusting the panel.
 *
 * FOUR do not. `checklists:open-templates-portal` (BACKLOG-3617) reads and
 * writes nothing; the portal gates its own page. The other three:
 * `checklists:get` and `checklists:remove` are the unhide rule spelled out
 * in `electron/types/featureGate.ts`: a user whose plan later loses
 * the feature must still be able to see what is on his own transaction and take
 * it off again. Gating either would strand rows where he can neither use them
 * nor be rid of them. `checklists:invalidate-templates` is the third — it only
 * throws cached data away.
 *
 * Do not take that split from this paragraph. It is asserted by execution in
 * `checklistHandlers-3475.test.ts` ("the gated and ungated sets, by
 * execution"), which invokes every registered `checklists:` channel with the
 * plan unreadable and partitions them by what each one answers — so a twelfth
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
 * read your organization's templates" are answers a surface has to render, not
 * errors to report. They come back as `{ success: false, error }`, the same way
 * `hiddenTextHandlers` does it. Only a malformed payload throws, through
 * `ValidationError`, which `wrapHandler` turns into the same shape.
 *
 * ## The organization is resolved in ONE place
 *
 * `resolveOrgIdOrRefusal()` — the feature gate's resolver, the same membership
 * lookup the gate itself used one line earlier, wrapped so this file can tell
 * "no organization" apart from "the lookup failed" (BACKLOG-3539). Deliberately
 * NOT `submissionService.getUserOrganizationId()`, which answers a different
 * question: it excludes personal organizations (so every solo user would read
 * as having none) and does not filter on `license_status`. Two resolvers is how
 * two halves of an app come to disagree about who the user is, and here it
 * would mean the gate said yes about one organization while the read asked
 * about another.
 *
 * A lookup that could not complete must not be reported as "no organization"
 * — a false statement about an account that actually has one. The template
 * channels return `CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR` for that case (and
 * `can-edit-templates` returns `CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR`); all
 * reserve `CHECKLISTS_NO_ORGANIZATION_ERROR` for a confirmed `none`.
 */

import { ipcMain, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import auditService from "../services/auditService";
import checklistTemplateService from "../services/checklistTemplateService";
import databaseService from "../services/databaseService";
import { dbTransaction } from "../services/db/core/dbConnection";
import { dealChangeFailureCode } from "../services/dealChangeAudit";
import { dealToggleUserError } from "../services/dealToggleAudit";
import {
  addChecklistLink,
  getChecklistsForTransaction,
  listOpenRequiredChecklistItems,
  OPEN_REQUIRED_ITEMS_MAX_LIMIT,
  removeChecklistLink,
  removeChecklistSync,
  selectChecklistTemplateSync,
  setChecklistItemChecked,
  setChecklistItemNote,
  setChecklistLinkIncludeOutsideDates,
} from "../services/db/checklistDbService";
import logService from "../services/logService";
import {
  getChecklistItemTransactionId,
  getChecklistLinkTransactionId,
  refuseIfDealLocked,
} from "../services/dealLockState";
import supabaseService from "../services/supabaseService";
import {
  AddChecklistLinkArgsSchema,
  GetChecklistArgsSchema,
  IncludeChecklistLinkOutsideDatesArgsSchema,
  ListOpenRequiredChecklistItemsArgsSchema,
  RemoveChecklistArgsSchema,
  RemoveChecklistLinkArgsSchema,
  SelectChecklistTemplateArgsSchema,
  SetChecklistItemCheckedArgsSchema,
  SetChecklistItemNoteArgsSchema,
} from "../schemas/checklist";
import { safeValidate } from "../schemas/validate";
import { wrapHandler } from "../utils/wrapHandler";
import { PORTAL_PATHS, portalUrl } from "../utils/portalUrl";
import { ValidationError } from "../utils/validation";
// The real fail-closed plan check. `checklists:get`, `checklists:remove` and
// `checklists:invalidate-templates` deliberately do not call it — the header
// says why, and `checklistHandlers-3475.test.ts` ("the gated and ungated sets,
// by execution") asserts the split. Nothing here may name the feature key.
import { isChecklistsAllowed, resolveOrgIdOrRefusal } from "./featureGateHandlers";
import type {
  AddChecklistLinkResult,
  ChecklistsForTransaction,
  SelectChecklistTemplateResult,
} from "../types/checklist";
import type {
  CanEditChecklistTemplatesResult,
  ListChecklistTemplatesResult,
  OpenChecklistsPortalResult,
} from "../types/ipc/window-api-checklists";
import type { ListOpenRequiredChecklistItemsResult } from "../types/checklistTodo";
import { LOCKED_SUBMISSION_STATUSES } from "../services/transactionEligibility";

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
   * The db layer's own outcome, carried through unchanged. `added`,
   * `exists` and `no_transaction` arrive here with `success: true` because the call ran and
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
 * the gate can say no for a plan reason, this is "you have no organization at
 * all". Reserved for a CONFIRMED `none` (BACKLOG-3539) — an org lookup that
 * could not complete is `CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR`, never this.
 */
export const CHECKLISTS_NO_ORGANIZATION_ERROR =
  "No organization is associated with this account.";

/**
 * The templates could not be READ — including when the organization lookup
 * itself failed (BACKLOG-3539), before there was anything to read. Deliberately
 * not the same sentence as an empty list — telling a user their brokerage has
 * no checklists when the truth is that the network failed is a false statement
 * about someone else's account.
 */
export const CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR =
  "Checklist templates couldn't be loaded right now.";

/**
 * BACKLOG-3617: whether this user may create templates could not be
 * established. The chooser reads this as "unknown", never as "cannot".
 */
export const CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR =
  "Couldn't check checklist permissions right now.";

/** BACKLOG-3617: the portal address is not one this app will open. */
export const CHECKLISTS_PORTAL_URL_REFUSED_ERROR =
  "The checklist settings page couldn't be opened.";

/** BACKLOG-3617: the address was allowed, but the browser could not be opened. */
export const CHECKLISTS_PORTAL_OPEN_FAILED_ERROR =
  "The browser couldn't be opened.";

/** The requested template is not in the listing (archived, deleted, or renamed away). */
export const CHECKLIST_TEMPLATE_NOT_FOUND_ERROR =
  "That checklist template is no longer available.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** BACKLOG-3617: the portal page where checklist templates are created. */
export const CHECKLISTS_PORTAL_PATH = PORTAL_PATHS.checklists;

/**
 * The portal Checklists URL, or null when the configured portal address is not
 * one this app will hand to the browser. The allow-list lives in
 * `electron/utils/portalUrl.ts` (BACKLOG-3863 extracted it so the billing page
 * uses the same check); this name stays for its callers.
 */
export function checklistsPortalUrl(
  configured: string | undefined = process.env.BROKER_PORTAL_URL,
): string | null {
  return portalUrl("checklists", configured);
}

/**
 * One boolean RPC about this organization; null for every answer that is not a
 * literal boolean (an error, a throw, no session, a missing function).
 */
async function readBooleanRpc(
  fn: "can_edit_checklist_templates" | "can_create_own_checklist_templates",
  orgId: string,
): Promise<boolean | null> {
  try {
    const session = await supabaseService.getAuthSession();
    if (!session) return null;
    const { data, error } = await supabaseService.getClient().rpc(fn, { p_org_id: orgId });
    if (error) {
      logService.warn(`[Checklists] ${fn} failed`, "Checklists", { code: error.code });
      return null;
    }
    return typeof data === "boolean" ? data : null;
  } catch (error) {
    logService.warn(`[Checklists] ${fn} threw`, "Checklists", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * May this user create checklists on the portal Checklists page?
 *
 * BACKLOG-3617 asked `can_edit_checklist_templates` (brokerage templates:
 * broker, admin, solo owner). BACKLOG-3618 lets every member on a plan with
 * checklists make their OWN, asked of `can_create_own_checklist_templates`.
 * Asked in the portal page gate's own order (`broker-portal/lib/checklist-
 * access.ts`): `can_edit` first; only a `false` goes on to `can_create_own`.
 *   - an editor never depends on the new function;
 *   - a database without it (3618 not applied, or rolled back) answers exactly
 *     as before 3618 — the new function's failure falls back to `false`.
 * Nothing about roles is copied into the desktop. Null = unknown.
 */
async function readCanEditTemplates(orgId: string): Promise<boolean | null> {
  const canEdit = await readBooleanRpc("can_edit_checklist_templates", orgId);
  if (canEdit !== false) return canEdit;
  const canCreateOwn = await readBooleanRpc("can_create_own_checklist_templates", orgId);
  return canCreateOwn === true;
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

type ChecklistActReason = "checklist_selected" | "checklist_removed";

/**
 * Write one audit row for an act that adds or removes a whole checklist.
 *
 * BACKLOG-3339 slice T: synchronous, and called ONLY inside the add / remove
 * handler's `dbTransaction`, after the change. The entry and the change commit
 * together or not at all; a failed entry throws and cancels the change.
 * `recordInTransaction` throws if no transaction is open.
 *
 * Ticking an item writes none: `checked_at` IS the record of it, held against
 * `is_checked` by a CHECK in schema.sql so the two cannot disagree. A row per
 * tick would duplicate that while adding a write to the most frequent action in
 * the feature.
 */
function recordChecklistActSync(
  ownerUserId: string,
  transactionId: string,
  reason: ChecklistActReason,
  extra: Record<string, unknown> = {},
): void {
  auditService.recordInTransaction({
    userId: ownerUserId,
    action: "TRANSACTION_UPDATE",
    resourceType: "TRANSACTION",
    resourceId: transactionId,
    metadata: { reason, transactionId, ...extra },
  });
}

/** Record a cancelled checklist act, after the rollback (fixed code only). */
function recordChecklistActFailure(
  ownerUserId: string,
  transactionId: string,
  reason: ChecklistActReason,
  error: unknown,
): void {
  auditService.recordFailure({
    userId: ownerUserId,
    action: "TRANSACTION_UPDATE",
    resourceType: "TRANSACTION",
    resourceId: transactionId,
    metadata: { reason, transactionId },
    errorMessage: dealChangeFailureCode(error),
  });
}

/**
 * BACKLOG-3910 (slice d): the lock gate for a channel that names an item or a
 * group rather than a deal. An id with no row resolves to no deal, and the
 * write that follows matches no row either, so nothing is written.
 */
function refuseIfChecklistDealLocked(
  transactionId: string | null,
  edit: Parameters<typeof refuseIfDealLocked>[1],
): ReturnType<typeof refuseIfDealLocked> {
  return transactionId ? refuseIfDealLocked(transactionId, edit) : null;
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

        const org = await resolveOrgIdOrRefusal();
        if (org.status === "unavailable") {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        if (org.status === "none") {
          return { success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR };
        }

        const listing = await checklistTemplateService.listTemplates(org.organizationId);
        if (!listing) {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        return { success: true, templates: listing.templates, source: listing.source };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * Copy a template onto a transaction: ADD a checklist (BACKLOG-3476 round 2:
   * Change is gone, so this channel never replaces or deletes one).
   *
   * The items come from the template listing, not from the renderer: a caller
   * that supplied its own items could write any title it liked into a row the
   * export renders. The whole copy and its audit entry are one database
   * transaction (BACKLOG-3339 slice T: `selectChecklistTemplateSync` inside the
   * handler's `dbTransaction`).
   */
  ipcMain.handle(
    "checklists:select-template",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        payload: unknown,
      ): Promise<SelectChecklistTemplateResponse> => {
        const args = parseArgs(SelectChecklistTemplateArgsSchema, payload, "payload");

        // BACKLOG-3910 (slice d): a locked deal is read-only.
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "add-checklist");
        if (lockedRefusal) return lockedRefusal;

        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }

        const org = await resolveOrgIdOrRefusal();
        if (org.status === "unavailable") {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        if (org.status === "none") {
          return { success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR };
        }

        const listing = await checklistTemplateService.listTemplates(org.organizationId);
        if (!listing) {
          return { success: false, error: CHECKLIST_TEMPLATES_UNAVAILABLE_ERROR };
        }
        const template = listing.templates.find((t) => t.id === args.templateId);
        if (!template) {
          return { success: false, error: CHECKLIST_TEMPLATE_NOT_FOUND_ERROR };
        }

        // BACKLOG-3339 slice T: the entry's owner, read before the
        // transaction. A missing deal writes nothing, as before.
        const transaction = await databaseService.getTransactionById(args.transactionId);
        if (!transaction) {
          return { success: true, result: { status: "no_transaction" } };
        }

        let result: SelectChecklistTemplateResult;
        try {
          result = dbTransaction(() => {
            const added = selectChecklistTemplateSync({
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
            });
            if (added.status === "added") {
              recordChecklistActSync(transaction.user_id, args.transactionId, "checklist_selected", {
                templateId: template.id,
                checklistId: added.checklistId,
              });
            }
            return added;
          });
        } catch (error) {
          recordChecklistActFailure(transaction.user_id, args.transactionId, "checklist_selected", error);
          throw dealToggleUserError("addChecklist", error);
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
        const checklists = await getChecklistsForTransaction(args.transactionId, "agent");
        return { success: true, checklists };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * BACKLOG-3965 PR-3: the Dashboard's Todo list — every required, unticked
   * item on this user's active, unlocked deals, with each deal's required
   * done/total summed across all its checklists.
   *
   * Gated (the header says why). Ticking a row is `checklists:set-item-checked`
   * below, which refuses a locked deal and checks the plan; there is no
   * second write path.
   *
   * No renderer caller until BACKLOG-3965 PR-4b (the Dashboard Todo panel).
   */
  ipcMain.handle(
    "checklists:list-open-required",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        payload: unknown,
      ): Promise<ListOpenRequiredChecklistItemsResult> => {
        const args = parseArgs(ListOpenRequiredChecklistItemsArgsSchema, payload, "payload");
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const lockedStatuses = LOCKED_SUBMISSION_STATUSES;
        const result = await listOpenRequiredChecklistItems(
          args.userId,
          lockedStatuses,
          args.limit ?? OPEN_REQUIRED_ITEMS_MAX_LIMIT,
        );
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:set-item-checked",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(SetChecklistItemCheckedArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfChecklistDealLocked(getChecklistItemTransactionId(args.itemId), "tick-checklist-item");
        if (lockedRefusal) return lockedRefusal;
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
        const lockedRefusal = refuseIfChecklistDealLocked(getChecklistItemTransactionId(args.itemId), "edit-checklist-note");
        if (lockedRefusal) return lockedRefusal;
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
        const lockedRefusal = refuseIfChecklistDealLocked(getChecklistItemTransactionId(args.itemId), "link-checklist-item");
        if (lockedRefusal) return lockedRefusal;
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const result = await addChecklistLink({
          itemId: args.itemId,
          kind: args.kind,
          targetIds: args.targetIds,
          includeOutsideDates: args.includeOutsideDates,
        });
        return { success: true, result };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * BACKLOG-3764: the agent answered "Include it" at the submit pre-flight for
   * a group dated outside the deal's audit dates. Only a group on this
   * transaction is changed.
   */
  ipcMain.handle(
    "checklists:include-link-outside-dates",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(IncludeChecklistLinkOutsideDatesArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "include-outside-dates");
        if (lockedRefusal) return lockedRefusal;
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const changed = await setChecklistLinkIncludeOutsideDates(args.transactionId, args.linkId);
        return { success: true, changed };
      },
      { module: "Checklists" },
    ),
  );

  ipcMain.handle(
    "checklists:remove-link",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ChecklistWriteResponse> => {
        const args = parseArgs(RemoveChecklistLinkArgsSchema, payload, "payload");
        const lockedRefusal = refuseIfChecklistDealLocked(getChecklistLinkTransactionId(args.linkId), "unlink-checklist-item");
        if (lockedRefusal) return lockedRefusal;
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
        // BACKLOG-3910 (slice d): ungated by the plan, but not by the lock.
        const lockedRefusal = refuseIfDealLocked(args.transactionId, "take-off-checklist");
        if (lockedRefusal) return lockedRefusal;
        // BACKLOG-3339 slice T: the entry's owner, read before the
        // transaction. A missing deal has no checklist to remove.
        const transaction = await databaseService.getTransactionById(args.transactionId);
        if (!transaction) return { success: true, changed: false };

        let removed: boolean;
        try {
          removed = dbTransaction(() => {
            const checklist = removeChecklistSync(args.transactionId, args.checklistId);
            if (checklist) {
              recordChecklistActSync(transaction.user_id, args.transactionId, "checklist_removed", {
                checklistId: checklist.id,
                templateId: checklist.templateId,
              });
            }
            return checklist !== null;
          });
        } catch (error) {
          recordChecklistActFailure(transaction.user_id, args.transactionId, "checklist_removed", error);
          throw dealToggleUserError("removeChecklist", error);
        }
        return { success: true, changed: removed };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * BACKLOG-3617: may this user create templates? Gated like `list-templates`
   * (it asks the cloud about the plan holder's organization). Every answer that
   * is not the database's boolean is `success: false` — unknown.
   */
  ipcMain.handle(
    "checklists:can-edit-templates",
    wrapHandler(
      async (_event: IpcMainInvokeEvent): Promise<CanEditChecklistTemplatesResult> => {
        if (!(await isChecklistsAllowed())) {
          return { success: false, error: CHECKLISTS_NOT_ALLOWED_ERROR };
        }
        const org = await resolveOrgIdOrRefusal();
        if (org.status === "unavailable") {
          return { success: false, error: CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR };
        }
        if (org.status === "none") {
          return { success: false, error: CHECKLISTS_NO_ORGANIZATION_ERROR };
        }
        const canEdit = await readCanEditTemplates(org.organizationId);
        if (canEdit === null) {
          return { success: false, error: CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR };
        }
        return { success: true, canEdit };
      },
      { module: "Checklists" },
    ),
  );

  /**
   * BACKLOG-3617: open the portal Checklists page in the user's browser.
   * Takes NO argument — anything the renderer sends is ignored — and opens
   * only the URL {@link checklistsPortalUrl} builds. Not gated: it reads and
   * writes nothing, and the portal applies its own gate on arrival.
   */
  ipcMain.handle(
    "checklists:open-templates-portal",
    wrapHandler(
      async (_event: IpcMainInvokeEvent): Promise<OpenChecklistsPortalResult> => {
        const url = checklistsPortalUrl();
        if (!url) {
          // No address in the answer: a refused address is not one to show.
          logService.warn("[Checklists] Portal address refused", "Checklists");
          return { success: false, error: CHECKLISTS_PORTAL_URL_REFUSED_ERROR };
        }
        try {
          await shell.openExternal(url);
        } catch (error) {
          logService.warn("[Checklists] Could not open the portal page", "Checklists", {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          // The address passed the allow-list, so the user can be told where to go.
          return {
            success: false,
            error: CHECKLISTS_PORTAL_OPEN_FAILED_ERROR,
            portalAddress: new URL(url).origin,
          };
        }
        return { success: true };
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
