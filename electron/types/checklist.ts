/**
 * Transaction checklist types — BACKLOG-3475.
 *
 * Type-only, and in `electron/types/` rather than beside the db service, so the
 * renderer may import it (the BACKLOG-2075 rule: a renderer import of a file
 * holding VALUES drags main-process code into the Vite bundle).
 *
 * A checklist is a broker template COPIED onto one transaction at the moment
 * the user picks it. Every field below that came from a template is a copy:
 * `templateId` records which template it came from and nothing reads through
 * it, so editing or deleting the broker template never rewrites a checklist
 * already in use.
 */

import type { DocumentType } from "./models";

/** What kind of evidence a link group holds. Mirrors the local CHECK and the cloud one. */
export type ChecklistLinkKind = "attachment" | "email";

/** One checklist, as stored. */
export interface TransactionChecklist {
  id: string;
  transactionId: string;
  /** The source template's cloud id. Provenance only — no read joins through it. */
  templateId: string;
  templateName: string;
  selectedAt: string | null;
}

/** One copied checklist row. */
export interface ChecklistItem {
  id: string;
  checklistId: string;
  title: string;
  description: string | null;
  isRequired: boolean;
  expectedDocumentType: DocumentType | null;
  isChecked: boolean;
  /**
   * Set exactly when `isChecked` is true. The pair is held by a CHECK in
   * schema.sql, so the two can never disagree — which is why a tick writes no
   * audit row: this column IS the record of it.
   */
  checkedAt: string | null;
  note: string | null;
  sortOrder: number;
}

/** One email or attachment inside a group. */
export interface ChecklistLinkMember {
  id: string;
  linkId: string;
  kind: ChecklistLinkKind;
  /** Exactly one of these two is set, matching `kind`. */
  attachmentId: string | null;
  emailId: string | null;
  /**
   * Whether the target is STILL linked to this checklist's transaction.
   *
   * False means the evidence survives but was unlinked from the transaction —
   * the row is stale, not broken. A member whose target was DELETED (a force
   * re-cache, a message re-import) is gone entirely, cascaded away with it, and
   * never appears here as `false`.
   */
  inTransaction: boolean;
}

/** One evidence group attached to a checklist item. */
export interface ChecklistLink {
  id: string;
  itemId: string;
  kind: ChecklistLinkKind;
  /** Derived in the main process from the target rows, never taken from the renderer. */
  label: string;
  sortOrder: number;
  members: ChecklistLinkMember[];
}

/** Everything one transaction's checklist tab needs, in one read. */
export interface ChecklistDetail {
  checklist: TransactionChecklist;
  items: ChecklistItem[];
  /** Keyed by `ChecklistItem.id`. An item with no evidence has no entry. */
  linksByItemId: Record<string, ChecklistLink[]>;
  /** Required items ticked / required items total. Optional items are not counted. */
  requiredDone: number;
  requiredTotal: number;
}

/** A template row as copied in. The cloud read that produces these is BACKLOG-3475 PR-B. */
export interface ChecklistTemplateItemInput {
  title: string;
  description?: string | null;
  isRequired: boolean;
  expectedDocumentType?: DocumentType | null;
  sortOrder: number;
}

export interface SelectChecklistTemplateInput {
  transactionId: string;
  templateId: string;
  templateName: string;
  items: ChecklistTemplateItemInput[];
  /**
   * A transaction holds at most one checklist. Picking a second template
   * without this flag is REFUSED and writes nothing; with it, the existing
   * checklist and everything under it is replaced in the same transaction.
   */
  replaceExisting?: boolean;
}

/**
 * Why a write did nothing, or what it did. A refusal is a RESULT, never a
 * throw: the caller has to render the reason.
 */
export type SelectChecklistTemplateResult =
  | { status: "selected"; checklistId: string }
  | { status: "replaced"; checklistId: string; previousChecklistId: string }
  | { status: "exists"; checklistId: string }
  | { status: "no_transaction" };

export interface AddChecklistLinkInput {
  itemId: string;
  kind: ChecklistLinkKind;
  /** `attachments.id` or `emails.id`, depending on `kind`. At least one. */
  targetIds: string[];
}

export type AddChecklistLinkResult =
  | { status: "added"; linkId: string; memberCount: number }
  | { status: "no_item" }
  /**
   * At least one target is not evidence of this item's transaction. Nothing is
   * written — not even the targets that WOULD have been valid.
   */
  | { status: "targets_not_in_transaction"; rejectedIds: string[] };
