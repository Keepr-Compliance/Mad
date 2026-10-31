/**
 * BACKLOG-3339 slice T: what the deal-screen toggles do when their audit entry
 * cannot be written. The toggles: hide / unhide a text from the export, restore
 * a party to a deal, add / remove a checklist.
 *
 * Same rule as the deal and contact changes (`dealChangeAudit.ts`,
 * `contactChangeAudit.ts`): the change and its entry are written in one
 * `dbTransaction` (`auditService.recordInTransaction`), so a failed entry
 * cancels the change. The caller records the failed attempt with
 * `auditService.recordFailure` (fixed code from `dealChangeFailureCode`) and
 * throws `dealToggleUserError(kind, err)`. When the change itself failed, the
 * original error goes through, as before.
 *
 * The messages say the change was NOT made. They must never read as saved.
 */

import { AuditNotRecordedError } from "./auditService";
import { dealChangeUserError } from "./dealChangeAudit";

export type DealToggleKind = "hide" | "unhide" | "restoreContact" | "addChecklist" | "removeChecklist";

export const DEAL_TOGGLE_AUDIT_NOT_SAVED_MESSAGE: Record<DealToggleKind, string> = {
  hide: "The text was not hidden from the export because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  unhide: "The text was not put back into the export because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  restoreContact: "The contact was not restored to this deal because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  addChecklist: "The checklist was not added because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  removeChecklist: "The checklist was not removed because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
};

/** The error to hand back to the user (see the file header). */
export function dealToggleUserError(kind: DealToggleKind, err: unknown): unknown {
  if (err instanceof AuditNotRecordedError) {
    return new Error(DEAL_TOGGLE_AUDIT_NOT_SAVED_MESSAGE[kind]);
  }
  // Not an audit failure: dealChangeUserError passes it through, copying a
  // driver error into a local Error so its message survives `instanceof Error`.
  return dealChangeUserError("update", err);
}
