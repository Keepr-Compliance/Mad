/**
 * BACKLOG-3339 slice C: what a contact create / edit / remove / restore, and a
 * phone-type save, do when their audit entry cannot be written.
 *
 * Same rule as the deal changes (`dealChangeAudit.ts`): the change and its
 * entry are written in one `dbTransaction` (`auditService.recordInTransaction`),
 * so a failed entry cancels the change. The caller records the failed attempt
 * with `auditService.recordFailure` (fixed code from `dealChangeFailureCode`)
 * and returns one of the fixed messages below. When the change itself failed,
 * the original error is used, as before.
 *
 * The messages say the change was NOT made. They must never read as saved.
 */

import { AuditNotRecordedError } from "./auditService";
import { dealChangeUserError } from "./dealChangeAudit";

export type ContactChangeKind = "save" | "remove" | "restore" | "phoneType";

export const CONTACT_AUDIT_NOT_SAVED_MESSAGE: Record<ContactChangeKind, string> = {
  save: "The contact was not saved because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  remove: "The contact was not removed because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  restore: "The contact was not restored because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
  phoneType: "Your phone type was not saved because its audit record could not be saved. Please try again. If this keeps happening, contact support.",
};

/** Edit / remove / restore of a contact row that is not there: nothing is written. */
export const CONTACT_NO_LONGER_EXISTS_MESSAGE = "This contact no longer exists.";

/** The error to hand back to the user (see the file header). */
export function contactChangeUserError(kind: ContactChangeKind, err: unknown): unknown {
  if (err instanceof AuditNotRecordedError) {
    return new Error(CONTACT_AUDIT_NOT_SAVED_MESSAGE[kind]);
  }
  // Not an audit failure: dealChangeUserError passes it through, copying a
  // driver error into a local Error so its message survives `instanceof Error`.
  return dealChangeUserError("update", err);
}
