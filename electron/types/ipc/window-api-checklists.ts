/**
 * WindowApi Checklists sub-interface — BACKLOG-3475.
 *
 * The renderer's view of `window.api.checklists`. Every decision the shapes
 * below carry is made in the main process: whether the plan includes
 * checklists, which organization's templates to read, whether a piece of
 * evidence belongs to the transaction, and what label a link gets. The renderer
 * renders the answer.
 *
 * Two distinctions the types hold on purpose:
 *
 * - On `listTemplates`, `templates` is **absent** when the read failed and an
 *   **empty array** when the brokerage has no templates. A renderer cannot
 *   accidentally say "your brokerage has not set up any checklists" to someone
 *   whose wifi is off.
 * - `selectTemplate` and `addLink` answer `success: true` with a `result`
 *   whenever the write ran, including when it declined (`exists`,
 *   `targets_not_in_transaction`). `success: false` means it never ran.
 */

import type {
  AddChecklistLinkResult,
  ChecklistDetail,
  ChecklistLinkKind,
  ChecklistTemplate,
  ChecklistTemplateSource,
  SelectChecklistTemplateResult,
} from "../checklist";

/** Every write that either changed a row or did not. */
export interface ChecklistWriteResult {
  success: boolean;
  changed?: boolean;
  error?: string;
}

export interface WindowApiChecklists {
  /** Broker templates for this organization. Gated; `templates` absent on a failed read. */
  listTemplates: () => Promise<{
    success: boolean;
    templates?: ChecklistTemplate[];
    source?: ChecklistTemplateSource;
    error?: string;
  }>;
  /** Copy a template onto a transaction, at most one per transaction. */
  selectTemplate: (args: {
    transactionId: string;
    templateId: string;
    replaceExisting?: boolean;
  }) => Promise<{ success: boolean; result?: SelectChecklistTemplateResult; error?: string }>;
  /** This transaction's checklist, or `null`. Never gated. */
  get: (args: {
    transactionId: string;
  }) => Promise<{ success: boolean; checklist?: ChecklistDetail | null; error?: string }>;
  /** Tick or untick one item. */
  setItemChecked: (args: { itemId: string; checked: boolean }) => Promise<ChecklistWriteResult>;
  /** Set or clear one item's note. */
  setItemNote: (args: { itemId: string; note: string | null }) => Promise<ChecklistWriteResult>;
  /** Attach evidence to an item as one group; all-or-nothing. */
  addLink: (args: {
    itemId: string;
    kind: ChecklistLinkKind;
    targetIds: string[];
  }) => Promise<{ success: boolean; result?: AddChecklistLinkResult; error?: string }>;
  /** Remove one evidence group. */
  removeLink: (args: { linkId: string }) => Promise<ChecklistWriteResult>;
  /** Take the checklist off a transaction. Never gated. */
  remove: (args: { transactionId: string }) => Promise<ChecklistWriteResult>;
  /** Discard the cached templates so the next listing goes to the cloud. */
  invalidateTemplates: () => Promise<{ success: boolean; error?: string }>;
}
