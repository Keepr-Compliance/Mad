/**
 * BACKLOG-3339 slice 1: what a deal create / edit / delete does when its audit
 * entry cannot be written.
 *
 * The change and its entry are written in one `dbTransaction`
 * (`auditService.recordInTransaction`), so a failed entry cancels the change.
 * The caller then:
 *   1. records the failed attempt with `auditService.recordFailure`, after the
 *      rollback, with a fixed code from `dealChangeFailureCode` (never the raw
 *      error text: it can carry a name or an address);
 *   2. rethrows `dealChangeUserError(kind, err)`. When the entry was the part
 *      that failed, the user sees one of the fixed messages below instead of
 *      the database driver's text. When the change itself failed, the
 *      original error goes through unchanged, as it did before.
 *
 * The messages say the change was NOT made. They must never read as saved.
 */

import { AuditNotRecordedError } from "./auditService";

export type DealChangeKind = "create" | "update" | "delete";

export const DEAL_AUDIT_NOT_SAVED_MESSAGE: Record<DealChangeKind, string> = {
  create:
    "The deal was not created because its audit record could not be saved. Nothing was changed. Please try again.",
  update:
    "Your changes were not saved because their audit record could not be saved. Please try again.",
  delete:
    "The deal was not deleted because its audit record could not be saved. Please try again.",
};

/** Bulk: how many of the selected deals were left unchanged for this reason. */
export function bulkAuditNotSavedMessage(
  kind: "update" | "delete",
  notChanged: number,
): string {
  const deals = notChanged === 1 ? "1 deal was" : `${notChanged} deals were`;
  const verb = kind === "delete" ? "deleted" : "changed";
  return `${deals} not ${verb} because the audit record could not be saved. Those deals are unchanged. Please try again.`;
}

export function isAuditNotRecorded(err: unknown): boolean {
  return err instanceof AuditNotRecordedError;
}

/**
 * The `errorMessage` stored on the failure entry: a fixed code, never the
 * error's text.
 */
export function dealChangeFailureCode(err: unknown): string {
  if (err instanceof AuditNotRecordedError) return "audit_entry_not_written";
  const name = err instanceof Error && /^[A-Za-z]+$/.test(err.name) ? err.name : "Error";
  return `change_failed:${name}`;
}

/** The error to rethrow to the user (see the file header). */
export function dealChangeUserError(kind: DealChangeKind, err: unknown): unknown {
  return err instanceof AuditNotRecordedError
    ? new Error(DEAL_AUDIT_NOT_SAVED_MESSAGE[kind])
    : err;
}
