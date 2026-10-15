/**
 * BACKLOG-3926: the folder / label match candidate read, runnable on any connection —
 * the dedicated contact query worker's read-only one, or the main connection when no
 * worker ran it (same pattern as addressMatchCandidatesDb.ts). Worker-safe: imports
 * only SQL text.
 */
import { sql } from "./core/sqlText";

/**
 * Folder-match candidates for one deal: the user's cached emails inside the deal's
 * window that sit in one of the given (account id, folder id) pairs. Index-driven:
 * the pairs drive `idx_mail_folder_refs_folder`, the email lookup uses
 * `idx_emails_external_id`.
 *
 * Excluded, for THIS transaction: already linked (`communications`) and already
 * rejected (`ignored_communications`). NOT excluded: emails already waiting in Needs
 * Review (a folder match upgrades their stored reason — precedence folder > address >
 * contact) and emails with a deal contact on them (same reason).
 *
 * Bound, in order (FOLDER_MATCH_CANDIDATE_PARAM_COUNT): JSON array of
 * [accountId, folderId] pairs, user id, window start, window end, transaction id twice.
 * Newest first, one row per email.
 */
export const FOLDER_MATCH_CANDIDATE_EMAILS_SQL = sql`SELECT e.id
       FROM json_each(?) j
       JOIN mail_folder_refs r
         ON r.account_id = json_extract(j.value, '$[0]')
        AND r.folder_id = json_extract(j.value, '$[1]')
       JOIN emails e
         ON e.external_id = r.external_id
        AND e.user_id = r.user_id
      WHERE r.user_id = ?
        AND e.sent_at >= ?
        AND e.sent_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM communications c
           WHERE c.transaction_id = ? AND c.email_id = e.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ignored_communications ic
           WHERE ic.transaction_id = ? AND ic.email_id = e.id
        )
      GROUP BY e.id
      ORDER BY MAX(e.sent_at) DESC`;

export const FOLDER_MATCH_CANDIDATE_PARAM_COUNT = 6;

/** Run the folder-match candidate read on a given connection; returns email ids. */
export function readFolderMatchCandidatesOn(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  params: unknown[],
): string[] {
  return (db.prepare(FOLDER_MATCH_CANDIDATE_EMAILS_SQL).all(...params) as Array<{ id: string }>).map((r) => r.id);
}
