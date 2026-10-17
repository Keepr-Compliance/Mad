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
  const raw = errorField(err, "name");
  const name = raw !== undefined && /^[A-Za-z]+$/.test(raw) ? raw : "Error";
  return `change_failed:${name}`;
}

/**
 * The error to rethrow to the user (see the file header).
 *
 * Driver errors are read by shape, never by `instanceof Error`: the database
 * driver creates its error class once per process, so an error it throws can
 * come from a different `Error` than the one this module sees. `wrapHandler`
 * shows only `instanceof Error` messages, so such an error is copied into a
 * local `Error` with the same name and message (original kept as `cause`).
 */
export function dealChangeUserError(kind: DealChangeKind, err: unknown): unknown {
  if (err instanceof AuditNotRecordedError) {
    return new Error(DEAL_AUDIT_NOT_SAVED_MESSAGE[kind]);
  }
  if (err instanceof Error) return err;
  const message = errorField(err, "message");
  if (message === undefined) return err;
  const copy: Error & { cause?: unknown } = new Error(message);
  copy.cause = err;
  const name = errorField(err, "name");
  if (name !== undefined) copy.name = name;
  return copy;
}

function errorField(err: unknown, key: "name" | "message"): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
