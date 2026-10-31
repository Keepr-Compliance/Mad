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
 * `selectChecklistTemplate` writes a checklist with its items;
 * `addChecklistLink` writes a group and its members. Both are a
 * single wrapped body of raw statements.
 *
 * They deliberately do NOT compose the other exports here. A handler that
 * awaited `removeChecklist()` and then an instantiate would be two separate
 * database transactions, and a failure between them leaves the checklist
 * destroyed and not replaced.
 * `writeAtomicity.guard.test.ts` refuses that shape by name, which is how the
 * rule is held rather than remembered.
 *
 * ## Refusals are returned, never thrown
 *
 * Adding a template the transaction already carries, replacing a checklist
 * that is not on the transaction, and linking evidence that is not on the
 * transaction, are ordinary outcomes the surface above has
 * to explain. They come back as a `status`, and in both cases nothing is
 * written — not even the part of the request that was valid.
 *
 * ## Two `*Sync` twins (BACKLOG-3339 slice T)
 *
 * `selectChecklistTemplateSync` and `removeChecklistSync` are the raw bodies,
 * with no transaction of their own. The add / remove handlers call them inside
 * their `dbTransaction` together with the audit entry, so the checklist and its
 * entry commit together or not at all. The promise halves have no production
 * caller: `syncTwin.guard.test.ts` requires one per twin, and they are fixture
 * producers for the tests. Each runs its twin in ONE `dbTransaction`, so the
 * rule above still holds for them. No other export here has a twin.
 */

import { randomUUID } from "crypto";

import { dbAll, dbGet, dbRun, dbTransaction } from "./core/dbConnection";
import { auditPeriodFromRow } from "../submissionAuditPeriod";
import { isPrivateChecklist, type ChecklistAudience } from "./checklistPrivacy";
import { auditWindowEnd } from "../exportPlan";
import {
  attachmentLabelSql,
  countOpenRequiredItemsSql,
  DELETE_CHECKLIST_IN_TRANSACTION_SQL,
  DELETE_CHECKLIST_LINK_SQL,
  emailLabelSql,
  GET_CHECKLIST_BY_TEMPLATE_SQL,
  GET_CHECKLIST_IN_TRANSACTION_SQL,
  GET_CHECKLIST_ITEMS_SQL,
  GET_CHECKLIST_LINK_MEMBERS_SQL,
  GET_CHECKLIST_LINKS_SQL,
  GET_CHECKLIST_EXPORT_ATTACHMENTS_SQL,
  GET_CHECKLIST_EXPORT_EMAIL_SUBJECTS_SQL,
  GET_CHECKLIST_EXPORT_TEXTS_SQL,
  GET_CHECKLISTS_BY_TRANSACTION_SQL,
  GET_BROKER_CHECKLISTS_BY_TRANSACTION_SQL,
  GET_ITEM_CONTEXT_SQL,
  GET_TRANSACTION_AUDIT_DATES_SQL,
  INSERT_ATTACHMENT_MEMBER_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_LINK_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_EMAIL_MEMBER_SQL,
  listOpenRequiredItemsSql,
  NEXT_CHECKLIST_SORT_ORDER_SQL,
  NEXT_LINK_SORT_ORDER_SQL,
  outsideAuditDatesSql,
  SET_LINK_INCLUDE_OUTSIDE_DATES_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  targetsInTransactionSql,
  TRANSACTION_EXISTS_SQL,
} from "./checklistSql";
import type {
  AddChecklistLinkInput,
  AddChecklistLinkResult,
  ChecklistDetail,
  ChecklistExportTargets,
  ChecklistItem,
  ChecklistLink,
  ChecklistLinkKind,
  ChecklistLinkMember,
  ChecklistsForTransaction,
  OutsideAuditDatesTarget,
  SelectChecklistTemplateInput,
  SelectChecklistTemplateResult,
  TransactionChecklist,
} from "../../types/checklist";
import type {
  OpenRequiredChecklistItem,
  OpenRequiredChecklistItems,
} from "../../types/checklistTodo";
import type { DocumentType } from "../../types/models";

/** Fallback labels. The `label` column CHECKs `length(trim(label)) >= 1`. */
const NO_SUBJECT_LABEL = "(no subject)";
const UNNAMED_FILE_LABEL = "(unnamed file)";

interface ChecklistRow {
  id: string;
  transaction_id: string;
  template_id: string;
  template_name: string;
  sort_order: number;
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
  include_outside_dates: number;
}

interface MemberRow {
  id: string;
  link_id: string;
  kind: string;
  attachment_id: string | null;
  email_id: string | null;
  message_id: string | null;
  in_transaction: number;
}

/**
 * The stored kind, read back. An unknown value cannot be stored (the CHECK),
 * so the fallback only types the row; it is never taken.
 */
function toLinkKind(kind: string): ChecklistLinkKind {
  return kind === "email" || kind === "text" ? kind : "attachment";
}

function toChecklist(row: ChecklistRow): TransactionChecklist {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    templateId: row.template_id,
    templateName: row.template_name,
    sortOrder: row.sort_order,
    selectedAt: row.selected_at,
    isPrivate: isPrivateChecklist(row.template_id),
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
 * Copy a broker template onto a transaction (BACKLOG-3476: one of several).
 *
 * ADDS a checklist and never deletes anything; a template already on the
 * transaction is refused as `exists`. (BACKLOG-3476 round 2: Change is gone,
 * so this no longer takes a checklist id to replace — the only way to remove
 * a checklist is `removeChecklist` below, which names the one it takes off.)
 */
export function selectChecklistTemplateSync(
  input: SelectChecklistTemplateInput,
): SelectChecklistTemplateResult {
  const transaction = dbGet<{ id: string }>(TRANSACTION_EXISTS_SQL, [input.transactionId]);
  if (!transaction) return { status: "no_transaction" };
  return insertTemplateChecklist(input);
}

/**
 * No production caller: the promise half that syncTwin.guard requires for
 * `selectChecklistTemplateSync`; a fixture producer for the checklist tests.
 * The whole copy is ONE `dbTransaction`.
 */
export function selectChecklistTemplate(
  input: SelectChecklistTemplateInput,
): Promise<SelectChecklistTemplateResult> {
  return Promise.resolve(
    dbTransaction<SelectChecklistTemplateResult>(() => selectChecklistTemplateSync(input)),
  );
}

/**
 * The body of `selectChecklistTemplate` once the transaction is known to
 * exist. Raw statements only; every caller runs it inside its own
 * `dbTransaction`.
 */
function insertTemplateChecklist(
  input: SelectChecklistTemplateInput,
): SelectChecklistTemplateResult {
  const existing = dbGet<{ id: string }>(GET_CHECKLIST_BY_TEMPLATE_SQL, [
    input.transactionId,
    input.templateId,
  ]);
  if (existing) return { status: "exists", checklistId: existing.id };
  const sortOrder =
    dbGet<{ next_sort_order: number }>(NEXT_CHECKLIST_SORT_ORDER_SQL, [input.transactionId])
      ?.next_sort_order ?? 0;

  const checklistId = randomUUID();
  dbRun(INSERT_CHECKLIST_SQL, [
    checklistId,
    input.transactionId,
    input.templateId,
    input.templateName,
    sortOrder,
  ]);
  input.items.forEach((item, index) => {
    dbRun(INSERT_CHECKLIST_ITEM_SQL, [
      // BACKLOG-3596: a pulled broker checklist keeps the cloud item id. A
      // PK clash throws and rolls back this whole checklist; there is no
      // fallback to a random id, which would lose the broker's ticks silently.
      item.id ?? randomUUID(),
      checklistId,
      item.title,
      item.description ?? null,
      item.isRequired ? 1 : 0,
      item.expectedDocumentType ?? null,
      item.sortOrder ?? index,
    ]);
  });

  return { status: "added", checklistId };
}

/**
 * Remove ONE checklist of one transaction; every other checklist on it is
 * untouched. Resolves the removed checklist, or `null` when that id is not a
 * checklist of that transaction (nothing is deleted then).
 */
export function removeChecklistSync(
  transactionId: string,
  checklistId: string,
): TransactionChecklist | null {
  const row = dbGet<ChecklistRow>(GET_CHECKLIST_IN_TRANSACTION_SQL, [checklistId, transactionId]);
  if (!row) return null;
  dbRun(DELETE_CHECKLIST_IN_TRANSACTION_SQL, [row.id, transactionId]);
  return toChecklist(row);
}

/**
 * No production caller: the promise half that syncTwin.guard requires for
 * `removeChecklistSync`; a fixture producer for the checklist tests.
 */
export function removeChecklist(
  transactionId: string,
  checklistId: string,
): Promise<TransactionChecklist | null> {
  return Promise.resolve(
    dbTransaction<TransactionChecklist | null>(() => removeChecklistSync(transactionId, checklistId)),
  );
}

/** What `applyReviewChecklistPull` did (BACKLOG-3607). */
export interface ReviewChecklistPullApplied {
  /** The local transaction no longer exists; nothing was written. */
  noTransaction: boolean;
  /** Template ids of the checklists deleted. */
  removedTemplateIds: string[];
  /** Template ids of the checklists written. */
  addedTemplateIds: string[];
  /** Adds skipped because the transaction already carries that template. */
  existing: number;
}

/**
 * BACKLOG-3607 — apply one review pull to one transaction in ONE
 * `dbTransaction`: delete the checklists the broker removed at review, then
 * add the checklists the broker added (or added back). Either all of it lands
 * or none of it does.
 *
 * A removal is keyed on the template (local `UNIQUE (transaction_id,
 * template_id)`), never on an id: the cloud header id is not a local id. The
 * checklist's items, ticks, notes and evidence links go with it (ON DELETE
 * CASCADE); the attachments and emails stay on the transaction. A template the
 * transaction does not carry is a no-op, so a re-delivered pull or an owed
 * retry removes nothing twice. An add behaves exactly as
 * `selectChecklistTemplate` (an existing template is `exists`, untouched).
 */
export function applyReviewChecklistPull(
  transactionId: string,
  removeTemplateIds: string[],
  adds: SelectChecklistTemplateInput[],
): Promise<ReviewChecklistPullApplied> {
  const result = dbTransaction<ReviewChecklistPullApplied>(() => {
    const applied: ReviewChecklistPullApplied = {
      noTransaction: false,
      removedTemplateIds: [],
      addedTemplateIds: [],
      existing: 0,
    };
    const transaction = dbGet<{ id: string }>(TRANSACTION_EXISTS_SQL, [transactionId]);
    if (!transaction) return { ...applied, noTransaction: true };

    for (const templateId of removeTemplateIds) {
      const existing = dbGet<{ id: string }>(GET_CHECKLIST_BY_TEMPLATE_SQL, [transactionId, templateId]);
      if (!existing) continue;
      dbRun(DELETE_CHECKLIST_IN_TRANSACTION_SQL, [existing.id, transactionId]);
      applied.removedTemplateIds.push(templateId);
    }
    for (const add of adds) {
      const outcome = insertTemplateChecklist({ ...add, transactionId });
      if (outcome.status === "added") applied.addedTemplateIds.push(add.templateId);
      else if (outcome.status === "exists") applied.existing++;
    }
    return applied;
  });
  return Promise.resolve(result);
}

/** One checklist's items, evidence groups and counts. */
function loadChecklistDetail(checklistRow: ChecklistRow): ChecklistDetail {
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
      kind: toLinkKind(row.kind),
      attachmentId: row.attachment_id,
      emailId: row.email_id,
      messageId: row.message_id,
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
      kind: toLinkKind(row.kind),
      label: row.label,
      sortOrder: row.sort_order,
      includeOutsideDates: row.include_outside_dates === 1,
      members: membersByLinkId.get(row.id) ?? [],
    };
    const bucket = linksByItemId[row.item_id];
    if (bucket) bucket.push(link);
    else linksByItemId[row.item_id] = [link];
  }

  const required = items.filter((item) => item.isRequired);
  return {
    checklist: toChecklist(checklistRow),
    items,
    linksByItemId,
    requiredDone: required.filter((item) => item.isChecked).length,
    requiredTotal: required.length,
    allItemsChecked: items.length > 0 && items.every((item) => item.isChecked),
  };
}

/**
 * Every checklist on one transaction, in display order, each with its items,
 * evidence groups keyed by item and its own counts, plus the required
 * done/total summed across them. An empty list when there are none.
 */
export function getChecklistsForTransaction(
  transactionId: string,
  audience: ChecklistAudience,
): Promise<ChecklistsForTransaction> {
  // BACKLOG-3966: `audience` is required, with no default — a new caller
  // must say which side it is on. `broker` leaves the private checklist out
  // in SQL, so none of its items, links or members are even loaded.
  const statement =
    audience === "broker"
      ? GET_BROKER_CHECKLISTS_BY_TRANSACTION_SQL
      : GET_CHECKLISTS_BY_TRANSACTION_SQL;
  const checklists = dbAll<ChecklistRow>(statement, [transactionId]).map(loadChecklistDetail);
  return Promise.resolve({
    checklists,
    requiredDone: checklists.reduce((sum, detail) => sum + detail.requiredDone, 0),
    requiredTotal: checklists.reduce((sum, detail) => sum + detail.requiredTotal, 0),
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

    // BACKLOG-3764: main decides "outside the dates", never the renderer, and
    // with the submit's own bounds. Asked before anything is written.
    const dates = dbGet<{ started_at: string | null; closed_at: string | null }>(
      GET_TRANSACTION_AUDIT_DATES_SQL,
      [context.transaction_id],
    );
    const outside = outsideAuditDates(input.kind, targetIds, dates?.started_at, dates?.closed_at);
    if (outside.length > 0 && input.includeOutsideDates !== true) {
      return {
        status: "outside_dates",
        outside,
        auditStart: dates?.started_at ?? null,
        auditEnd: dates?.closed_at ?? null,
      };
    }
    // The answer is stored only when there was a question: a group made inside
    // the dates is asked like any other if the dates later move.
    const includeOutsideDates = outside.length > 0 ? 1 : 0;

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
    dbRun(INSERT_CHECKLIST_LINK_SQL, [
      linkId,
      input.itemId,
      input.kind,
      label,
      sortOrder,
      includeOutsideDates,
    ]);
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
 * BACKLOG-3764 — the targets dated outside these audit dates. The bounds are
 * the submit's (`auditPeriodFromRow`, then `auditWindowEnd` for the closing
 * day), so the question at link time and the filter at submit time cannot
 * disagree on a boundary. No dates at all: nothing is outside.
 */
export function outsideAuditDates(
  kind: AddChecklistLinkInput["kind"],
  targetIds: string[],
  startedAt: string | null | undefined,
  closedAt: string | null | undefined,
): OutsideAuditDatesTarget[] {
  if (targetIds.length === 0) return [];
  const { auditStartDate, auditEndDate } = auditPeriodFromRow({
    started_at: startedAt ?? null,
    closed_at: closedAt ?? null,
  });
  // An unparseable stored date is no bound here (the submit's own reader
  // throws on it, so that submit fails loudly rather than sending anything).
  const iso = (d: Date | null): string | null => (d && !isNaN(d.getTime()) ? d.toISOString() : null);
  const start = iso(auditStartDate);
  const end = iso(auditWindowEnd(auditEndDate));
  if (start === null && end === null) return [];
  return dbAll<{ id: string; sent_at: string | null }>(outsideAuditDatesSql(kind, targetIds.length), [
    ...targetIds,
    start,
    start,
    end,
    end,
  ]).map((row) => ({ id: row.id, sentAt: row.sent_at }));
}

/**
 * BACKLOG-3764 — the agent answered "Include it" for an existing group at the
 * submit pre-flight. Resolves true when the group is on this transaction and
 * was updated.
 */
export function setChecklistLinkIncludeOutsideDates(
  transactionId: string,
  linkId: string,
): Promise<boolean> {
  const result = dbRun(SET_LINK_INCLUDE_OUTSIDE_DATES_SQL, [linkId, transactionId]);
  return Promise.resolve(result.changes > 0);
}

/**
 * Remove one evidence group. Its members follow by cascade. Resolves true when
 * a group was removed.
 */
export function removeChecklistLink(linkId: string): Promise<boolean> {
  const result = dbRun(DELETE_CHECKLIST_LINK_SQL, [linkId]);
  return Promise.resolve(result.changes > 0);
}

/**
 * BACKLOG-3767 — the evidence rows the PDF export's checklist block names its
 * members by: for each attachment member, its owner ids and whether the text it
 * belongs to is hidden from this transaction's export; for each email member,
 * its subject. Read once per export, after the export's own sync and load.
 */
export function getChecklistExportTargets(
  transactionId: string,
  checklists: ChecklistDetail[],
): Promise<ChecklistExportTargets> {
  const attachmentIds = new Set<string>();
  const emailIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const detail of checklists) {
    for (const links of Object.values(detail.linksByItemId)) {
      for (const link of links) {
        for (const member of link.members) {
          if (member.attachmentId) attachmentIds.add(member.attachmentId);
          if (member.emailId) emailIds.add(member.emailId);
          if (member.messageId) messageIds.add(member.messageId);
        }
      }
    }
  }

  const attachmentTargets: ChecklistExportTargets["attachmentTargets"] = {};
  if (attachmentIds.size > 0) {
    const rows = dbAll<{
      id: string;
      filename: string | null;
      email_id: string | null;
      message_id: string | null;
      external_message_id: string | null;
      message_external_id: string | null;
      hidden: number;
    }>(GET_CHECKLIST_EXPORT_ATTACHMENTS_SQL, [transactionId, JSON.stringify([...attachmentIds])]);
    for (const row of rows) {
      attachmentTargets[row.id] = {
        attachmentId: row.id,
        filename: row.filename,
        emailId: row.email_id,
        messageId: row.message_id,
        externalMessageId: row.external_message_id,
        messageExternalId: row.message_external_id,
        hidden: row.hidden === 1,
      };
    }
  }

  const emailSubjects: ChecklistExportTargets["emailSubjects"] = {};
  if (emailIds.size > 0) {
    const rows = dbAll<{ id: string; subject: string | null }>(
      GET_CHECKLIST_EXPORT_EMAIL_SUBJECTS_SQL,
      [JSON.stringify([...emailIds])],
    );
    for (const row of rows) emailSubjects[row.id] = row.subject;
  }

  // BACKLOG-3968: the texts behind text members, with the same hidden test.
  const textTargets: ChecklistExportTargets["textTargets"] = {};
  if (messageIds.size > 0) {
    const rows = dbAll<{
      id: string;
      external_id: string | null;
      sent_at: string | null;
      hidden: number;
    }>(GET_CHECKLIST_EXPORT_TEXTS_SQL, [transactionId, JSON.stringify([...messageIds])]);
    for (const row of rows) {
      textTargets[row.id] = {
        messageId: row.id,
        externalId: row.external_id,
        sentAt: row.sent_at,
        hidden: row.hidden === 1,
      };
    }
  }

  return Promise.resolve({ attachmentTargets, emailSubjects, textTargets });
}

// ---------------------------------------------------------------------------
// Dashboard "Todo" — BACKLOG-3965 PR-3
// ---------------------------------------------------------------------------

/** The most Todo rows one read returns ("Show more" stops here). */
export const OPEN_REQUIRED_ITEMS_MAX_LIMIT = 50;

/**
 * Every required, unticked checklist item on this user's active, unlocked
 * deals: how many there are in all, and the first `limit` of them in display
 * order. See `listOpenRequiredItemsSql` for the filters and the order.
 *
 * `lockedStatuses` is the caller's `LOCKED_SUBMISSION_STATUSES`. An empty list
 * is refused rather than read: `NOT IN ()` would treat every deal as open,
 * including submitted and approved ones.
 */
export function listOpenRequiredChecklistItems(
  userId: string,
  lockedStatuses: readonly string[],
  limit: number,
): Promise<OpenRequiredChecklistItems> {
  if (lockedStatuses.length === 0) {
    throw new Error("Refusing to read the Todo list with no locked status");
  }
  const bounded = Math.max(1, Math.min(OPEN_REQUIRED_ITEMS_MAX_LIMIT, Math.floor(limit)));
  const filterParams = [userId, ...lockedStatuses];
  const counted = dbGet<{ total: number }>(
    countOpenRequiredItemsSql(lockedStatuses.length),
    filterParams,
  );
  const items = dbAll<OpenRequiredChecklistItem>(listOpenRequiredItemsSql(lockedStatuses.length), [
    ...filterParams,
    bounded,
  ]);
  return Promise.resolve({ totalCount: counted?.total ?? 0, items });
}
