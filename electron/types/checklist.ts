/**
 * Transaction checklist types — BACKLOG-3475.
 *
 * Type-only, and in `electron/types/` rather than beside the db service, so the
 * renderer may import it (the BACKLOG-2075 rule: a renderer import of a file
 * holding VALUES drags main-process code into the Vite bundle).
 *
 * A checklist is a broker template COPIED onto one transaction at the moment
 * the user picks it. A transaction may hold several, each from a different
 * template (BACKLOG-3476). Every field below that came from a template is a copy:
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
  /** Display position among this transaction's checklists (BACKLOG-3476). */
  sortOrder: number;
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

/** One checklist with everything its section of the tab needs. */
export interface ChecklistDetail {
  checklist: TransactionChecklist;
  items: ChecklistItem[];
  /** Keyed by `ChecklistItem.id`. An item with no evidence has no entry. */
  linksByItemId: Record<string, ChecklistLink[]>;
  /** Required items ticked / required items total. Optional items are not counted. */
  requiredDone: number;
  requiredTotal: number;
  /**
   * Every item ticked, optional ones included (BACKLOG-3476: such a section
   * opens collapsed). False for a checklist with no items.
   */
  allItemsChecked: boolean;
}

/**
 * Every checklist on one transaction, in display order, in one read
 * (BACKLOG-3476). The sums are computed in main so the renderer never derives
 * progress from items. An empty list when the transaction has none.
 */
export interface ChecklistsForTransaction {
  checklists: ChecklistDetail[];
  /** Sum of each checklist's `requiredDone`. */
  requiredDone: number;
  /** Sum of each checklist's `requiredTotal`. */
  requiredTotal: number;
}

// ---------------------------------------------------------------------------
// Broker templates, as read from the cloud — BACKLOG-3475 PR-B
// ---------------------------------------------------------------------------

/** One row of a broker template, before it is copied onto a transaction. */
export interface ChecklistTemplateItem {
  id: string;
  title: string;
  description: string | null;
  isRequired: boolean;
  expectedDocumentType: DocumentType | null;
  sortOrder: number;
}

/** One broker template the current organization may pick from. */
export interface ChecklistTemplate {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  updatedAt: string | null;
  /** Sorted by `sortOrder` here, not by the server: a PostgREST embed is unordered. */
  items: ChecklistTemplateItem[];
}

/**
 * Where a listing came from.
 *
 * There is deliberately no `"unavailable"` member. A listing that could not be
 * read is not a listing — it is `null`, and the surface above has to say
 * something different about it. An empty `templates` array means the
 * organization HAS no templates, which is a fact about the plan holder; a
 * failed read is a fact about the network, and the two produce different
 * sentences in front of a user.
 */
export type ChecklistTemplateSource = "live" | "cache";

export interface ChecklistTemplateListing {
  source: ChecklistTemplateSource;
  templates: ChecklistTemplate[];
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
}

/**
 * Why a write did nothing, or what it did. A refusal is a RESULT, never a
 * throw: the caller has to render the reason.
 *
 * ADD only (BACKLOG-3476 round 2: Change is gone, and with it the only route
 * that could delete a checklist's own ticks, notes and links out from under
 * it — the sole way to remove a checklist is `checklists:remove`, which
 * removes ONE named checklist and nothing else). There is no `"replaced"` or
 * `"no_checklist"` arm: this call never deletes.
 */
export type SelectChecklistTemplateResult =
  | { status: "added"; checklistId: string }
  /** This template is already on this transaction (as `checklistId`). Nothing written. */
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
   * The request named no targets at all (BACKLOG-3476). Nothing is written.
   * Distinct from `targets_not_in_transaction`, whose `rejectedIds` would be
   * empty and so say nothing true about the cause. Unreachable over IPC — the
   * Zod schema refuses an empty list — so this is the db contract for any
   * in-process caller.
   */
  | { status: "no_targets" }
  /**
   * At least one target is not evidence of this item's transaction. Nothing is
   * written — not even the targets that WOULD have been valid.
   */
  | { status: "targets_not_in_transaction"; rejectedIds: string[] };
