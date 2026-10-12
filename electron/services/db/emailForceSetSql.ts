/**
 * The email force-set SQL — BACKLOG-2989 commit A2, rewritten by BACKLOG-3910a.
 *
 * `EmailForceSet` carries DATA (whose mail) and every statement is built here.
 *
 * ## The rule, and why the builders below are allowed
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter.
 *
 * `emailForceReadView` takes a `columns` string and returns text; it executes
 * nothing, and its caller keeps its own verb. The functions that DO execute
 * take no SQL — only the set, ids and bound values.
 *
 * ## What a force re-cache replaces (BACKLOG-3910a, founder rules 2026-10-11)
 *
 * EVERY email of the user, whatever its account, provider, age, provider id
 * or sent date — EXCEPT the protected ones. Protected = the email is tied to
 * a deal by any of four links: a transaction link, a rejected suggestion, an
 * email-kind checklist member, or an attachment-kind checklist member on one
 * of its attachments. Protected rows are never removed; the swap pairs them
 * with their fresh copy instead (see `emailForceStaging.ts`).
 *
 * Suggestions still waiting for review are deliberately NOT a protecting tie.
 *
 * The older scope (`external_id IS NOT NULL AND source IN (…) AND sent_at >=
 * window`) is gone: it existed to spare rows a run could not re-download, and
 * under the new rule those rows are removed unless protected.
 */

import type { Database as DatabaseType } from "better-sqlite3";

import { stagingTableSql } from "./core/identifierSql";
import { placeholderList } from "./core/sqlFragments";
import { sql, type SafeSql } from "./core/sqlText";
import type { StagingTableName } from "./stagingDdlSql";

export type EmailForceProvider = "gmail" | "outlook";

/**
 * A force set, as DATA. No SQL crosses this type.
 */
export interface EmailForceSet {
  readonly userId: string;
}

/**
 * INTERNAL. "This email is tied to a deal", one EXISTS arm per link table,
 * correlated on `e.id` (every caller aliases `emails` as `e`).
 *
 * Written as EXISTS per arm rather than `id IN (SELECT email_id …)` on
 * purpose (SR S1). `attachments.email_id` is NULL for text attachments, and
 * `id NOT IN (a list holding one NULL)` is NULL for EVERY row — so a NOT IN
 * removal would silently remove nothing while the run reported success.
 * EXISTS cannot evaluate to NULL.
 */
function protectedPredicate(): SafeSql {
  return sql`(EXISTS (SELECT 1 FROM communications c WHERE c.email_id = e.id)
    OR EXISTS (SELECT 1 FROM ignored_communications i WHERE i.email_id = e.id)
    OR EXISTS (SELECT 1 FROM transaction_checklist_link_members m WHERE m.email_id = e.id)
    OR EXISTS (SELECT 1 FROM attachments a
                 JOIN transaction_checklist_link_members am ON am.attachment_id = a.id
                WHERE a.email_id = e.id))`;
}

/**
 * INTERNAL. "This email is part of a LOCKED deal's record" (frozen): linked to
 * the deal, or a checklist member (email-kind, or attachment-kind on one of its
 * attachments) on a checklist of the deal. A rejected suggestion on a locked
 * deal keeps the email but does not freeze it (SR R3(b)).
 */
function frozenPredicate(statusCount: number): SafeSql {
  const statuses = placeholderList(statusCount);
  return sql`(EXISTS (SELECT 1 FROM communications c
                 JOIN transactions t ON t.id = c.transaction_id
                WHERE c.email_id = e.id AND t.submission_status IN (${statuses}))
    OR EXISTS (SELECT 1 FROM transaction_checklist_link_members m
                 JOIN transaction_checklist_links l ON l.id = m.link_id
                 JOIN transaction_checklist_items it ON it.id = l.item_id
                 JOIN transaction_checklists ck ON ck.id = it.checklist_id
                 JOIN transactions t ON t.id = ck.transaction_id
                WHERE m.email_id = e.id AND t.submission_status IN (${statuses}))
    OR EXISTS (SELECT 1 FROM attachments a
                 JOIN transaction_checklist_link_members m ON m.attachment_id = a.id
                 JOIN transaction_checklist_links l ON l.id = m.link_id
                 JOIN transaction_checklist_items it ON it.id = l.item_id
                 JOIN transaction_checklists ck ON ck.id = it.checklist_id
                 JOIN transactions t ON t.id = ck.transaction_id
                WHERE a.email_id = e.id AND t.submission_status IN (${statuses})))`;
}

/**
 * The read source for a run with a rebuild in flight: every OTHER user's live
 * rows, unioned with what this run has staged so far.
 *
 * The user's own live rows are hidden for the whole run, so every message the
 * run fetches is staged fresh and the swap decides, per row, whether it
 * replaces, refreshes or is discarded. Consequence: the BACKLOG-1769
 * resurrection repair cannot fire on a force run (no live row of the user is
 * visible to match); it stays for the incremental sync.
 *
 * A pure text builder — it executes nothing. `stagingTable` is
 * `StagingTableName`, so an unchecked name is a compile error.
 */
export function emailForceReadView(
  set: EmailForceSet,
  stagingTable: StagingTableName,
  columns: SafeSql,
): { sql: SafeSql; params: readonly string[] } {
  return {
    // `user_id` is NOT NULL, so `<>` needs no NULL handling.
    sql: sql`(SELECT ${columns} FROM emails WHERE user_id <> ? UNION ALL SELECT ${columns} FROM ${stagingTableSql(stagingTable)})`,
    params: [set.userId],
  };
}

/** A protected live email, as the swap's pairing step reads it. */
export interface ProtectedLiveEmail {
  readonly id: string;
  readonly external_id: string | null;
  readonly message_id_header: string | null;
  readonly account_id: string | null;
  readonly source: string | null;
  readonly thread_id: string | null;
  readonly created_at: string | null;
  /** 1 when the email is part of a locked deal's record. */
  readonly frozen: number;
}

/**
 * Every protected email of the user, with its frozen flag. Read INSIDE the
 * swap transaction, so nothing can link or unlink between this read and the
 * removal.
 *
 * `lockedStatuses` is passed in rather than imported: `db/` does not import
 * from `services/`. The caller passes `LOCKED_SUBMISSION_STATUSES`.
 */
export function selectProtectedLiveEmails(
  db: DatabaseType,
  set: EmailForceSet,
  lockedStatuses: readonly string[],
): ProtectedLiveEmail[] {
  if (lockedStatuses.length === 0) {
    throw new Error("Refusing to read the frozen set with no locked status");
  }
  const frozen = frozenPredicate(lockedStatuses.length);
  // The frozen predicate appears three times with the same list, so the
  // statuses are bound three times, in placeholder order.
  const params = [...lockedStatuses, ...lockedStatuses, ...lockedStatuses, set.userId];
  return db
    .prepare(
      `SELECT e.id, e.external_id, e.message_id_header, e.account_id, e.source, e.thread_id,
              e.created_at, CASE WHEN ${frozen} THEN 1 ELSE 0 END AS frozen
         FROM emails e
        WHERE e.user_id = ? AND ${protectedPredicate()}`,
    )
    .all(...params) as ProtectedLiveEmail[];
}

/**
 * Remove every UNPROTECTED live email of the user — any account, provider,
 * age, provider id or sent date (founder rule 1).
 *
 * An ordinary DELETE: every ON DELETE CASCADE fires for the removed rows
 * (participants, attachments, the pending-review sibling). Protected rows are
 * not touched, so their links never cascade.
 */
export function deleteLiveForceSet(db: DatabaseType, set: EmailForceSet): number {
  return db
    .prepare(`DELETE FROM emails AS e WHERE e.user_id = ? AND NOT ${protectedPredicate()}`)
    .run(set.userId).changes;
}
