/**
 * Transaction checklists, local half — BACKLOG-3475.
 *
 * The SQL and the reasoning behind the copy-not-reference rule, the absence of
 * `thread_id` and the target guard live in `checklistSql.ts`.
 *
 * Each export is a PLAIN function returning `Promise<T>`, never `async`
 * (BACKLOG-2960): the driver call is evaluated before `Promise.resolve` wraps
 * its value, so a failure throws before the promise exists.
 *
 * ## Two functions write more than once, and each is ONE `dbTransaction`
 *
 * `selectChecklistTemplate` deletes an existing checklist and writes a new one
 * with its items; `addChecklistLink` writes a group and its members. Both are a
 * single wrapped body of raw statements.
 *
 * They deliberately do NOT compose the other exports here. A handler that
 * awaited `removeChecklist()` and then an instantiate would be two separate
 * database transactions, and a failure between them leaves the transaction with
 * NO checklist at all — the user's plan destroyed and not replaced.
 * `writeAtomicity.guard.test.ts` refuses that shape by name, which is how the
 * rule is held rather than remembered.
 *
 * ## Refusals are returned, never thrown
 *
 * Picking a second template without `replaceExisting`, and linking evidence
 * that is not on the transaction, are ordinary outcomes the surface above has
 * to explain. They come back as a `status`, and in both cases nothing is
 * written — not even the part of the request that was valid.
 *
 * No `*Sync` twins: `syncTwin.guard.test.ts` requires every paired `*Sync`
 * export to be reached from a transaction body, and nothing calls these from
 * one. A twin is added when a body first needs it.
 */

import { randomUUID } from "crypto";

import { dbAll, dbGet, dbRun, dbTransaction } from "./core/dbConnection";
import {
  attachmentLabelSql,
  DELETE_CHECKLIST_BY_ID_SQL,
  DELETE_CHECKLIST_BY_TRANSACTION_SQL,
  DELETE_CHECKLIST_LINK_SQL,
  emailLabelSql,
  GET_CHECKLIST_BY_TRANSACTION_SQL,
  GET_CHECKLIST_ITEMS_SQL,
  GET_CHECKLIST_LINK_MEMBERS_SQL,
  GET_CHECKLIST_LINKS_SQL,
  GET_ITEM_CONTEXT_SQL,
  INSERT_ATTACHMENT_MEMBER_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_LINK_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_EMAIL_MEMBER_SQL,
  NEXT_LINK_SORT_ORDER_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  targetsInTransactionSql,
  TRANSACTION_EXISTS_SQL,
} from "./checklistSql";
import type {
  AddChecklistLinkInput,
  AddChecklistLinkResult,
  ChecklistDetail,
  ChecklistItem,
  ChecklistLink,
  ChecklistLinkMember,
  SelectChecklistTemplateInput,
  SelectChecklistTemplateResult,
  TransactionChecklist,
} from "../../types/checklist";
import type { DocumentType } from "../../types/models";

/** Fallback labels. The `label` column CHECKs `length(trim(label)) >= 1`. */
const NO_SUBJECT_LABEL = "(no subject)";
const UNNAMED_FILE_LABEL = "(unnamed file)";

interface ChecklistRow {
  id: string;
  transaction_id: string;
  template_id: string;
  template_name: string;
  selected_at: string | null;
}

interface ItemRow {
  id: string;
  checklist_id: string;
  title: string;
  description: string | null;
  is_required: number;
  expected_document_type: string | null;
  is_checked: number;
  checked_at: string | null;
  note: string | null;
  sort_order: number;
}

interface LinkRow {
  id: string;
  item_id: string;
  kind: string;
  label: string;
  sort_order: number;
}

interface MemberRow {
  id: string;
  link_id: string;
  kind: string;
  attachment_id: string | null;
  email_id: string | null;
  in_transaction: number;
}

function toChecklist(row: ChecklistRow): TransactionChecklist {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    templateId: row.template_id,
    templateName: row.template_name,
    selectedAt: row.selected_at,
  };
}

function toItem(row: ItemRow): ChecklistItem {
  return {
    id: row.id,
    checklistId: row.checklist_id,
    title: row.title,
    description: row.description,
    isRequired: row.is_required === 1,
    expectedDocumentType: (row.expected_document_type as DocumentType | null) ?? null,
    isChecked: row.is_checked === 1,
    checkedAt: row.checked_at,
    note: row.note,
    sortOrder: row.sort_order,
  };
}

/**
 * Copy a broker template onto a transaction.
 *
 * One transaction holds at most one checklist. A second pick without
 * `replaceExisting` is refused and writes nothing; with it, the old checklist
 * is deleted (items, groups and members follow by cascade) and the new one
 * written in the SAME database transaction, so the transaction is never left
 * without a checklist.
 */
export function selectChecklistTemplate(
  input: SelectChecklistTemplateInput,
): Promise<SelectChecklistTemplateResult> {
  const result = dbTransaction<SelectChecklistTemplateResult>(() => {
    const transaction = dbGet<{ id: string }>(TRANSACTION_EXISTS_SQL, [input.transactionId]);
    if (!transaction) return { status: "no_transaction" };

    const existing = dbGet<ChecklistRow>(GET_CHECKLIST_BY_TRANSACTION_SQL, [input.transactionId]);
    if (existing && !input.replaceExisting) {
      return { status: "exists", checklistId: existing.id };
    }
    if (existing) {
      dbRun(DELETE_CHECKLIST_BY_ID_SQL, [existing.id]);
    }

    const checklistId = randomUUID();
    dbRun(INSERT_CHECKLIST_SQL, [
      checklistId,
      input.transactionId,
      input.templateId,
      input.templateName,
    ]);
    input.items.forEach((item, index) => {
      dbRun(INSERT_CHECKLIST_ITEM_SQL, [
        randomUUID(),
        checklistId,
        item.title,
        item.description ?? null,
        item.isRequired ? 1 : 0,
        item.expectedDocumentType ?? null,
        item.sortOrder ?? index,
      ]);
    });

    return existing
      ? { status: "replaced", checklistId, previousChecklistId: existing.id }
      : { status: "selected", checklistId };
  });
  return Promise.resolve(result);
}

/** Remove the checklist on one transaction. Resolves true when one was removed. */
export function removeChecklist(transactionId: string): Promise<boolean> {
  const result = dbRun(DELETE_CHECKLIST_BY_TRANSACTION_SQL, [transactionId]);
  return Promise.resolve(result.changes > 0);
}

/**
 * Everything one transaction's checklist needs, in one read: the checklist, its
 * items in display order, its evidence groups keyed by item, and the required
 * done/total pair.
 */
export function getChecklistForTransaction(
  transactionId: string,
): Promise<ChecklistDetail | null> {
  const checklistRow = dbGet<ChecklistRow>(GET_CHECKLIST_BY_TRANSACTION_SQL, [transactionId]);
  if (!checklistRow) return Promise.resolve(null);

  const items = dbAll<ItemRow>(GET_CHECKLIST_ITEMS_SQL, [checklistRow.id]).map(toItem);
  const linkRows = dbAll<LinkRow>(GET_CHECKLIST_LINKS_SQL, [checklistRow.id]);
  const memberRows = dbAll<MemberRow>(GET_CHECKLIST_LINK_MEMBERS_SQL, [
    checklistRow.id,
    checklistRow.id,
  ]);

  const membersByLinkId = new Map<string, ChecklistLinkMember[]>();
  for (const row of memberRows) {
    const member: ChecklistLinkMember = {
      id: row.id,
      linkId: row.link_id,
      kind: row.kind === "email" ? "email" : "attachment",
      attachmentId: row.attachment_id,
      emailId: row.email_id,
      inTransaction: row.in_transaction === 1,
    };
    const bucket = membersByLinkId.get(row.link_id);
    if (bucket) bucket.push(member);
    else membersByLinkId.set(row.link_id, [member]);
  }

  const linksByItemId: Record<string, ChecklistLink[]> = {};
  for (const row of linkRows) {
    const link: ChecklistLink = {
      id: row.id,
      itemId: row.item_id,
      kind: row.kind === "email" ? "email" : "attachment",
      label: row.label,
      sortOrder: row.sort_order,
      members: membersByLinkId.get(row.id) ?? [],
    };
    const bucket = linksByItemId[row.item_id];
    if (bucket) bucket.push(link);
    else linksByItemId[row.item_id] = [link];
  }

  const required = items.filter((item) => item.isRequired);
  return Promise.resolve({
    checklist: toChecklist(checklistRow),
    items,
    linksByItemId,
    requiredDone: required.filter((item) => item.isChecked).length,
    requiredTotal: required.length,
  });
}

/**
 * Tick or untick one item. `checked_at` is written by the same statement and
 * derived from `checked`, so the two can never disagree. Resolves true when a
 * row was updated.
 */
export function setChecklistItemChecked(itemId: string, checked: boolean): Promise<boolean> {
  const flag = checked ? 1 : 0;
  const result = dbRun(SET_CHECKLIST_ITEM_CHECKED_SQL, [flag, flag, itemId]);
  return Promise.resolve(result.changes > 0);
}

/** Set or clear one item's note. Resolves true when a row was updated. */
export function setChecklistItemNote(itemId: string, note: string | null): Promise<boolean> {
  const result = dbRun(SET_CHECKLIST_ITEM_NOTE_SQL, [note, itemId]);
  return Promise.resolve(result.changes > 0);
}

/**
 * Attach evidence to a checklist item as ONE group.
 *
 * Every target id is verified to be evidence of the item's own transaction
 * before anything is written, and the label is derived here from the target
 * rows — never taken from the renderer, which would let a caller write any text
 * it liked into a field the export renders.
 *
 * If any target fails the check the whole write is refused and the valid
 * targets are NOT written either: a partially-honoured request would show the
 * user a group they did not ask for.
 */
export function addChecklistLink(input: AddChecklistLinkInput): Promise<AddChecklistLinkResult> {
  const result = dbTransaction<AddChecklistLinkResult>(() => {
    const context = dbGet<{ item_id: string; checklist_id: string; transaction_id: string }>(
      GET_ITEM_CONTEXT_SQL,
      [input.itemId],
    );
    if (!context) return { status: "no_item" };

    const targetIds = [...new Set(input.targetIds)];
    if (targetIds.length === 0) {
      return { status: "no_targets" };
    }

    const transactionIdRepeats = input.kind === "email" ? 1 : 2;
    const found = new Set(
      dbAll<{ id: string }>(targetsInTransactionSql(input.kind, targetIds.length), [
        ...targetIds,
        ...Array<string>(transactionIdRepeats).fill(context.transaction_id),
      ]).map((row) => row.id),
    );
    const rejectedIds = targetIds.filter((id) => !found.has(id));
    if (rejectedIds.length > 0) {
      return { status: "targets_not_in_transaction", rejectedIds };
    }

    const labelSql =
      input.kind === "email"
        ? emailLabelSql(targetIds.length)
        : attachmentLabelSql(targetIds.length);
    const labelRow = dbGet<{ subject?: string | null; filename?: string | null }>(
      labelSql,
      targetIds,
    );
    const rawLabel = input.kind === "email" ? labelRow?.subject : labelRow?.filename;
    const label =
      rawLabel && rawLabel.trim().length > 0
        ? rawLabel
        : input.kind === "email"
          ? NO_SUBJECT_LABEL
          : UNNAMED_FILE_LABEL;

    const sortOrder =
      dbGet<{ next_sort_order: number }>(NEXT_LINK_SORT_ORDER_SQL, [input.itemId])
        ?.next_sort_order ?? 0;

    const linkId = randomUUID();
    dbRun(INSERT_CHECKLIST_LINK_SQL, [linkId, input.itemId, input.kind, label, sortOrder]);
    for (const targetId of targetIds) {
      dbRun(
        input.kind === "email" ? INSERT_EMAIL_MEMBER_SQL : INSERT_ATTACHMENT_MEMBER_SQL,
        [randomUUID(), linkId, targetId],
      );
    }

    return { status: "added", linkId, memberCount: targetIds.length };
  });
  return Promise.resolve(result);
}

/**
 * Remove one evidence group. Its members follow by cascade. Resolves true when
 * a group was removed.
 */
export function removeChecklistLink(linkId: string): Promise<boolean> {
  const result = dbRun(DELETE_CHECKLIST_LINK_SQL, [linkId]);
  return Promise.resolve(result.changes > 0);
}
