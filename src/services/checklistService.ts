/**
 * Checklist Service — BACKLOG-3475.
 *
 * The renderer's abstraction over `window.api.checklists`. Components never
 * touch `window.api` directly (the architecture rule in CLAUDE.md), and they
 * never decide anything a checklist depends on: the plan check, the
 * organization lookup, the evidence membership check and the label a link
 * carries all live in the main process.
 *
 * **The consumer is BACKLOG-3476's transaction tab, which does not exist yet.**
 * Nothing in `src/` calls this file — that is the seam the plan set (PR-A local
 * data → PR-B templates and IPC → 3476 UI), recorded in `pm_dependencies` as
 * 3476 depends_on 3475, not an oversight. The `int-portal/transaction-checklists
 * → develop` PR carries the checklist line that refuses to merge this while it
 * is still uncalled.
 *
 * ## One thing this file is careful NOT to flatten
 *
 * `listTemplates` returns `data: undefined` when the read failed and
 * `data.templates: []` when the brokerage has no templates. A component that renders the
 * second as "no checklists have been set up" is right; rendering the first that
 * way tells a user something false about their brokerage's account. The
 * temptation is `data: result.templates ?? []` — one character, and it destroys
 * the distinction the whole main-process path preserves.
 */

import { type ApiResult, getErrorMessage } from "./index";

import type {
  AddChecklistLinkResult,
  ChecklistDetail,
  ChecklistLinkKind,
  ChecklistTemplate,
  ChecklistTemplateSource,
  SelectChecklistTemplateResult,
} from "../../electron/types/checklist";

/**
 * Said when main answered "success" with no listing. Written here rather than
 * imported: `electron/handlers/` is main-process code and the renderer may not
 * value-import from it.
 */
const TEMPLATES_UNREADABLE_ERROR =
  "Your brokerage's checklist templates could not be loaded right now.";

export interface ChecklistTemplateListing {
  templates: ChecklistTemplate[];
  source: ChecklistTemplateSource;
}

export const checklistService = {
  /**
   * The broker templates this organization may pick from.
   *
   * `success: false` covers both "your plan does not include checklists" and
   * "we could not read them"; the message says which. It never comes back
   * successful with an invented empty list.
   */
  async listTemplates(): Promise<ApiResult<ChecklistTemplateListing>> {
    try {
      const result = await window.api.checklists.listTemplates();
      if (!result.success) {
        return { success: false, error: result.error };
      }
      // The shared union says a success always carries `templates`, and the
      // handler cannot compile without one. This check is for the hop the
      // type cannot see: `ipcRenderer.invoke` is `any`, so what arrives here
      // is whatever main actually sent. A success with no listing is a
      // failure, never an empty brokerage.
      if (!Array.isArray(result.templates)) {
        return { success: false, error: TEMPLATES_UNREADABLE_ERROR };
      }
      return {
        success: true,
        data: { templates: result.templates, source: result.source },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Copy a template onto a transaction. At most one checklist per transaction. */
  async selectTemplate(
    transactionId: string,
    templateId: string,
    replaceExisting?: boolean,
  ): Promise<ApiResult<SelectChecklistTemplateResult>> {
    try {
      const result = await window.api.checklists.selectTemplate({
        transactionId,
        templateId,
        replaceExisting,
      });
      if (result.success && result.result) {
        return { success: true, data: result.result };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** This transaction's checklist, or `null` when it has none. Never gated. */
  async get(transactionId: string): Promise<ApiResult<ChecklistDetail | null>> {
    try {
      const result = await window.api.checklists.get({ transactionId });
      if (result.success) {
        return { success: true, data: result.checklist ?? null };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Tick or untick one item. `data` is whether a row actually changed. */
  async setItemChecked(itemId: string, checked: boolean): Promise<ApiResult<boolean>> {
    try {
      const result = await window.api.checklists.setItemChecked({ itemId, checked });
      if (result.success) {
        return { success: true, data: !!result.changed };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Set or clear one item's note. Empty and whitespace-only both clear it. */
  async setItemNote(itemId: string, note: string | null): Promise<ApiResult<boolean>> {
    try {
      const result = await window.api.checklists.setItemNote({ itemId, note });
      if (result.success) {
        return { success: true, data: !!result.changed };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Attach evidence to an item as one group. All-or-nothing: if any target is
   * not on the transaction, nothing is written.
   */
  async addLink(
    itemId: string,
    kind: ChecklistLinkKind,
    targetIds: string[],
  ): Promise<ApiResult<AddChecklistLinkResult>> {
    try {
      const result = await window.api.checklists.addLink({ itemId, kind, targetIds });
      if (result.success && result.result) {
        return { success: true, data: result.result };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Remove one evidence group. Its members follow by cascade. */
  async removeLink(linkId: string): Promise<ApiResult<boolean>> {
    try {
      const result = await window.api.checklists.removeLink({ linkId });
      if (result.success) {
        return { success: true, data: !!result.changed };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Take the checklist off a transaction. Never gated. */
  async remove(transactionId: string): Promise<ApiResult<boolean>> {
    try {
      const result = await window.api.checklists.remove({ transactionId });
      if (result.success) {
        return { success: true, data: !!result.changed };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /** Discard the cached templates so the next listing goes to the cloud. */
  async invalidateTemplates(): Promise<ApiResult> {
    try {
      const result = await window.api.checklists.invalidateTemplates();
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },
};

export default checklistService;
