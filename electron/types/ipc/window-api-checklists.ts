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

/**
 * BACKLOG-3617: may this user create checklist templates (the portal
 * Checklists page)? Asked of the database — `can_edit_checklist_templates`,
 * the same function the portal page's gate and the template RLS use.
 *
 * Three answers, never two: `canEdit: true` (creator), `canEdit: false`
 * (cannot create), and `success: false` (the answer is unknown — plan refused,
 * no organization, offline, or a reply that was not a boolean).
 */
export type CanEditChecklistTemplatesResult =
  | { success: true; canEdit: boolean }
  | { success: false; error: string };

/**
 * BACKLOG-3617: the answer of `checklists:open-templates-portal`.
 * `portalAddress` (an origin main built and allowed) is present only when the
 * address was fine but the browser could not be opened; a refused address is
 * never sent back.
 */
export type OpenChecklistsPortalResult =
  | { success: true }
  | { success: false; error: string; portalAddress?: string };

/** Every write that either changed a row or did not. */
export interface ChecklistWriteResult {
  success: boolean;
  changed?: boolean;
  error?: string;
}

export interface WindowApiChecklists {
  /** Broker templates for this organization. Gated; a failed read carries no `templates`. */
  listTemplates: () => Promise<ListChecklistTemplatesResult>;
  /**
   * Add a checklist from a template (BACKLOG-3476 round 2: Change is gone, so
   * this never replaces one already there).
   */
  selectTemplate: (args: {
    transactionId: string;
    templateId: string;
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
    /** BACKLOG-3764: the agent's "Include it" to the outside-the-dates question. */
    includeOutsideDates?: boolean;
  }) => Promise<{ success: boolean; result?: AddChecklistLinkResult; error?: string }>;
  /** BACKLOG-3764: "Include it" for an existing group, from the submit pre-flight. */
  includeLinkOutsideDates: (args: {
    transactionId: string;
    linkId: string;
  }) => Promise<ChecklistWriteResult>;
  /** Remove one evidence group. */
  removeLink: (args: { linkId: string }) => Promise<ChecklistWriteResult>;
  /** Take one checklist off a transaction. Never gated. */
  remove: (args: { transactionId: string; checklistId: string }) => Promise<ChecklistWriteResult>;
  /** Discard the cached templates so the next listing goes to the cloud. */
  invalidateTemplates: () => Promise<{ success: boolean; error?: string }>;
  /** BACKLOG-3617: may this user create templates? Gated; unknown is `success: false`. */
  canEditTemplates: () => Promise<CanEditChecklistTemplatesResult>;
  /**
   * BACKLOG-3617: open the portal's Checklists page in the browser. Takes no
   * URL — main builds it and refuses anything that is not the portal origin.
   */
  openTemplatesPortal: () => Promise<OpenChecklistsPortalResult>;
}
