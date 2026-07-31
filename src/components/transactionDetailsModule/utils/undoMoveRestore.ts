/**
 * BACKLOG-2390 fix — restore previously-removed emails by their CONTENT ids.
 *
 * ROOT CAUSE this fixes (email bulk-remove Undo restored nothing):
 *   The Undo passed `unlinkCommunication`'s returned `unlinkedIds` as the restore
 *   payload. Those ids are **communications.id** (the junction-row PK, `c.id`).
 *   But `getRemovedEmails()` returns suppression rows keyed by **emails.id**
 *   (`e.id`, aliased `email_id` from its JOIN to the `emails` table). The old
 *   filter `idSet.has(r.email_id)` therefore compared `communications.id` against
 *   `emails.id` — two disjoint id-spaces — matched ZERO rows, called
 *   `restoreRemovedEmail` zero times, and still reported "Move undone".
 *
 *   The renderer's own email object carries BOTH ids:
 *     • `email.id`             = COALESCE(m.id, e.id, c.id) = emails.id for an email
 *     • `email.communication_id` = c.id
 *   so callers must hand THIS helper the CONTENT ids (`email.id` = emails.id),
 *   which live in the same id-space as `getRemovedEmails().email_id`.
 *
 * This maps content ids → suppression rows (`ignored_id`) and restores each
 * distinct suppression row via the EXISTING `restoreRemovedEmail` IPC (which is
 * thread-aware + idempotent). Reuses existing IPC only — no new backend path.
 */

/** Minimal shape of a removed-email row this helper needs (from getRemovedEmails). */
interface RemovedEmailRowLike {
  ignored_id: string;
  /** emails.id — the CONTENT id-space (NOT communications.id). */
  email_id: string;
}

/** The two IPC methods this helper depends on (structurally satisfied by window.api.transactions). */
export interface EmailRestoreApi {
  getRemovedEmails: (transactionId: string) => Promise<{
    success: boolean;
    removedEmails?: RemovedEmailRowLike[];
    error?: string;
  }>;
  restoreRemovedEmail: (
    ignoredCommId: string,
    emailId: string,
    transactionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Outcome of an undo restore. Callers map this to a toast:
 *   success        → "Move undone"
 *   fetch_failed   → error (getRemovedEmails failed/threw)
 *   none_matched   → error ("Couldn't undo — emails are still removed")
 *   restore_failed → error (a restoreRemovedEmail returned success:false / threw)
 */
export type EmailUndoOutcome =
  | { status: "success"; restoredCount: number }
  | { status: "fetch_failed"; error?: string }
  | { status: "none_matched" }
  | { status: "restore_failed"; restoredCount: number };

export async function restoreRemovedEmailsByContentIds(
  api: EmailRestoreApi,
  transactionId: string,
  emailContentIds: string[],
): Promise<EmailUndoOutcome> {
  const res = await api.getRemovedEmails(transactionId);
  if (!res.success) {
    return { status: "fetch_failed", error: res.error };
  }

  // Match on emails.id — the SAME id-space getRemovedEmails() returns as email_id.
  const idSet = new Set(emailContentIds);
  const rows = (res.removedEmails ?? []).filter((r) => idSet.has(r.email_id));
  if (rows.length === 0) {
    return { status: "none_matched" };
  }

  // Dedup by ignored_id: restore is thread-aware + idempotent, so one call per
  // distinct suppression row clears every moved email's suppression.
  const seen = new Set<string>();
  let restoredCount = 0;
  let failed = false;
  for (const row of rows) {
    if (seen.has(row.ignored_id)) continue;
    seen.add(row.ignored_id);
    try {
      const r = await api.restoreRemovedEmail(row.ignored_id, row.email_id, transactionId);
      if (r?.success) restoredCount++;
      else failed = true;
    } catch {
      failed = true;
    }
  }

  return failed
    ? { status: "restore_failed", restoredCount }
    : { status: "success", restoredCount };
}
