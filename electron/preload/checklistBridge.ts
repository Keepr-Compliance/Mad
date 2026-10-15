/**
 * Checklist Bridge — BACKLOG-3475.
 *
 * `window.api.checklists`. Every method is one `ipcRenderer.invoke` of one
 * channel and nothing else: the gate, the organization lookup, the evidence
 * membership check and the label a link carries are all decided in the main
 * process, because the renderer is not the authority on any of them.
 *
 * Arguments are a single object per channel rather than a positional list, so
 * the Zod schema in `electron/schemas/checklist.ts` has exactly one shape to
 * validate and a caller cannot transpose two ids of the same type.
 *
 * The consumer is BACKLOG-3476's transaction tab, through `checklistService`.
 */

import { ipcRenderer } from "electron";

import type {
  AddChecklistLinkResult,
  ChecklistLinkKind,
  ChecklistsForTransaction,
  SelectChecklistTemplateResult,
} from "../types/checklist";
import type {
  CanEditChecklistTemplatesResult,
  ListChecklistTemplatesResult,
  OpenChecklistsPortalResult,
} from "../types/ipc/window-api-checklists";

export const checklistBridge = {
  /**
   * The broker templates this organization may pick from.
   * Gated: refused with `success: false` when the plan does not carry checklists.
   * A failed read is the `success: false` arm, with no `templates` at all — an
   * empty array means the brokerage genuinely has none.
   */
  listTemplates: (): Promise<ListChecklistTemplatesResult> =>
    ipcRenderer.invoke("checklists:list-templates"),

  /**
   * Copy a template onto a transaction: ADD a checklist (a template already on
   * the transaction answers `exists`). BACKLOG-3476 round 2: Change is gone,
   * so this never replaces one already there.
   */
  selectTemplate: (args: {
    transactionId: string;
    templateId: string;
  }): Promise<{ success: boolean; result?: SelectChecklistTemplateResult; error?: string }> =>
    ipcRenderer.invoke("checklists:select-template", args),

  /** Every checklist on this transaction. Never gated — a local read of the user's own rows. */
  get: (args: {
    transactionId: string;
  }): Promise<{ success: boolean; checklists?: ChecklistsForTransaction; error?: string }> =>
    ipcRenderer.invoke("checklists:get", args),

  /** Tick or untick one item. `checked_at` is written by the same statement. */
  setItemChecked: (args: {
    itemId: string;
    checked: boolean;
  }): Promise<{ success: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:set-item-checked", args),

  /** Set or clear one item's note. Empty and whitespace-only both clear it. */
  setItemNote: (args: {
    itemId: string;
    note: string | null;
  }): Promise<{ success: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:set-item-note", args),

  /**
   * Attach evidence to an item as ONE group. Every target must already be on
   * the item's transaction; if any is not, nothing is written — not even the
   * targets that would have been valid.
   */
  addLink: (args: {
    itemId: string;
    kind: ChecklistLinkKind;
    targetIds: string[];
    /** BACKLOG-3764: the agent's "Include it" to the outside-the-dates question. */
    includeOutsideDates?: boolean;
  }): Promise<{ success: boolean; result?: AddChecklistLinkResult; error?: string }> =>
    ipcRenderer.invoke("checklists:add-link", args),

  /** BACKLOG-3764: "Include it" for an existing group, from the submit pre-flight. */
  includeLinkOutsideDates: (args: {
    transactionId: string;
    linkId: string;
  }): Promise<{ success: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:include-link-outside-dates", args),

  /** Remove one evidence group. Its members follow by cascade. */
  removeLink: (args: {
    linkId: string;
  }): Promise<{ success: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:remove-link", args),

  /**
   * Take one checklist off a transaction. Never gated: a user whose plan later
   * loses the feature must still be able to clear his own rows.
   */
  remove: (args: {
    transactionId: string;
    checklistId: string;
  }): Promise<{ success: boolean; changed?: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:remove", args),

  /** Discard the cached templates so the next listing goes to the cloud. */
  invalidateTemplates: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("checklists:invalidate-templates"),

  /** BACKLOG-3617: may this user create templates? `success: false` = unknown. */
  canEditTemplates: (): Promise<CanEditChecklistTemplatesResult> =>
    ipcRenderer.invoke("checklists:can-edit-templates"),

  /** BACKLOG-3617: open the portal Checklists page. No URL crosses the bridge. */
  openTemplatesPortal: (): Promise<OpenChecklistsPortalResult> =>
    ipcRenderer.invoke("checklists:open-templates-portal"),
};
