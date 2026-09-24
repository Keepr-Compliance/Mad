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
 * - On `listTemplates`, a failed read is the `success: false` arm, which has no
 *   `templates` at all, and a brokerage with no templates is `success: true`
 *   with an **empty array**. A renderer cannot accidentally say "your brokerage
 *   has not set up any checklists" to someone whose wifi is off.
 * - `selectTemplate` and `addLink` answer `success: true` with a `result`
 *   whenever the write ran, including when it declined (`exists`,
 *   `targets_not_in_transaction`). `success: false` means it never ran.
 */

import type {
  AddChecklistLinkResult,
  ChecklistLinkKind,
  ChecklistsForTransaction,
  ChecklistTemplate,
  ChecklistTemplateSource,
  SelectChecklistTemplateResult,
} from "../checklist";

/**
 * The one declaration of the `checklists:list-templates` answer (BACKLOG-3476).
 *
 * The handler, the preload bridge and {@link WindowApiChecklists} all use THIS
 * type. They used to carry three hand-kept copies, and the bridge's
 * `ipcRenderer.invoke` is `any`, so nothing made them agree. With one union a
 * main-process branch that answers `success: true` without a listing is a
 * compile error at the handler, not a shape the renderer has to guess about.
 *
 * `source` is required on success: every producer branch sets it.
 */
export type ListChecklistTemplatesResult =
  | { success: true; templates: ChecklistTemplate[]; source: ChecklistTemplateSource }
  | { success: false; error: string };

/** Every write that either changed a row or did not. */
export interface ChecklistWriteResult {
  success: boolean;
  changed?: boolean;
  error?: string;
}

export interface WindowApiChecklists {
  /** Broker templates for this organization. Gated; a failed read carries no `templates`. */
  listTemplates: () => Promise<ListChecklistTemplatesResult>;
  /** Add a checklist from a template, or replace the one named by `replaceChecklistId`. */
  selectTemplate: (args: {
    transactionId: string;
    templateId: string;
    replaceChecklistId?: string;
  }) => Promise<{ success: boolean; result?: SelectChecklistTemplateResult; error?: string }>;
  /** Every checklist on this transaction. Never gated. */
  get: (args: {
    transactionId: string;
  }) => Promise<{ success: boolean; checklists?: ChecklistsForTransaction; error?: string }>;
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
  /** Take one checklist off a transaction. Never gated. */
  remove: (args: { transactionId: string; checklistId: string }) => Promise<ChecklistWriteResult>;
  /** Discard the cached templates so the next listing goes to the cloud. */
  invalidateTemplates: () => Promise<{ success: boolean; error?: string }>;
}
