/**
 * SQL for Learn's per-email signal measurement — BACKLOG-4257 (M3) PR2.
 *
 * Read only. Reads `emails`, `attachments`, `communications`, `transactions`
 * and the answered bulk sample. Writes nothing. Every body and attachment
 * text column is cut IN SQL (`substr`) to a bound cap, so a large message
 * never reaches main whole (SR R3/R4).
 *
 * "Non-rejected deal" is the clause used by DEAL_LINKED_EMAILS_SQL
 * (learnModeSql.ts): status 'rejected' OR detection_status 'rejected' is
 * rejected, NULL reads as the column default (SR R5).
 */

import { sql } from "./core/sqlText";

/**
 * One keyset page of messages linked to the user's NON-rejected deals, with
 * capped text, oldest id first. Bound, in order: body cap, body cap, user id,
 * user id, cursor id ('' for the first page), page size.
 */
export const DEAL_LINKED_SIGNAL_PAGE_SQL = sql`
  SELECT e.id AS id, e.subject AS subject, e.sender AS sender,
         COALESCE(e.recipients, '') || ', ' || COALESCE(e.cc, '') AS recipients,
         substr(e.body_plain, 1, ?) AS body_plain, substr(e.body_html, 1, ?) AS body_html,
         e.bulk_mail_headers AS bulk_mail_headers
  FROM emails e
  WHERE e.user_id = ? AND e.id IN (
    SELECT c.email_id
    FROM communications c
    JOIN transactions t ON t.id = c.transaction_id
    WHERE t.user_id = ? AND c.email_id IS NOT NULL
      AND NOT (COALESCE(t.status, 'active') = 'rejected' OR COALESCE(t.detection_status, 'confirmed') = 'rejected')
  )
    AND e.id > ?
  ORDER BY e.id
  LIMIT ?
`;

/**
 * Messages by local id, scoped to the user, with capped text. Bound, in
 * order: body cap, body cap, user id, JSON array of email ids.
 */
export const SIGNAL_EMAILS_BY_IDS_SQL = sql`
  SELECT e.id AS id, e.subject AS subject, e.sender AS sender,
         COALESCE(e.recipients, '') || ', ' || COALESCE(e.cc, '') AS recipients,
         substr(e.body_plain, 1, ?) AS body_plain, substr(e.body_html, 1, ?) AS body_html,
         e.bulk_mail_headers AS bulk_mail_headers
  FROM emails e
  WHERE e.user_id = ? AND e.id IN (SELECT value FROM json_each(?))
  ORDER BY e.id
`;

/**
 * Attachment filenames and capped extracted text of the given messages,
 * scoped to the user. Bound, in order: text cap, user id, JSON array of
 * email ids.
 */
export const SIGNAL_ATTACHMENTS_BY_EMAIL_IDS_SQL = sql`
  SELECT a.email_id AS email_id, a.filename AS filename, substr(a.text_content, 1, ?) AS text_content
  FROM attachments a
  JOIN emails e ON e.id = a.email_id
  WHERE e.user_id = ? AND a.email_id IN (SELECT value FROM json_each(?))
  ORDER BY a.email_id, a.id
`;

/**
 * Answered sample rows (newsletter/spam and real estate; skip left out) with
 * the local id and capped text of their message, resolved through the
 * provider key like ANSWERED_BULK_WITH_TEXT_SQL. A row whose message is no
 * longer cached has a NULL id. Bound, in order: body cap, body cap, user id.
 */
export const ANSWERED_BULK_SIGNAL_ROWS_SQL = sql`
  SELECT b.answer AS answer, e.id AS id, e.subject AS subject, e.sender AS sender,
         COALESCE(e.recipients, '') || ', ' || COALESCE(e.cc, '') AS recipients,
         substr(e.body_plain, 1, ?) AS body_plain, substr(e.body_html, 1, ?) AS body_html,
         e.bulk_mail_headers AS bulk_mail_headers
  FROM learn_bulk_answers b
  LEFT JOIN emails e ON e.id = (
    SELECT e2.id FROM emails e2
    WHERE e2.user_id = b.user_id AND e2.source = b.source AND e2.external_id = b.external_id
    ORDER BY e2.id LIMIT 1
  )
  WHERE b.user_id = ? AND b.deleted_at IS NULL AND b.answer IN ('real_estate', 'newsletter_spam')
`;
