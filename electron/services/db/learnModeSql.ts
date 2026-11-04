/**
 * SQL for Learn mode ("Help Keepr learn") — BACKLOG-4120.
 *
 * Reads `emails` and `transactions`; writes ONLY the three learn_ tables
 * (`learn_mode_settings`, `learn_deal_answers`, `learn_bulk_answers`). No
 * statement here writes any other table. Local only: these tables are read by
 * no sync and no export path.
 *
 * Soft removal: nothing here removes a learn row. "Delete my answers" sets
 * deleted_at; every read filters `deleted_at IS NULL`.
 */

import { sql } from "./core/sqlText";

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

/** One bound parameter: user id. Missing row = OFF. */
export const GET_LEARN_MODE_ENABLED_SQL = sql`
  SELECT enabled FROM learn_mode_settings
  WHERE user_id = ? AND deleted_at IS NULL
`;

/**
 * Set the switch, updating the live row in place (a toggle never removes a
 * row). Bound, in order: id (new UUID, used only when no live row exists),
 * user id, enabled (0/1), created_at, updated_at.
 */
export const UPSERT_LEARN_MODE_ENABLED_SQL = sql`
  INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) WHERE deleted_at IS NULL
  DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
`;

// ---------------------------------------------------------------------------
// Cleanup pass answers
// ---------------------------------------------------------------------------

/**
 * Record (or change) a cleanup answer for one address. Bound, in order: id,
 * user id, run id, address key, property address, answer, answered_at,
 * rule_version, created_at, updated_at.
 */
export const UPSERT_DEAL_ANSWER_SQL = sql`
  INSERT INTO learn_deal_answers (
    id, user_id, run_id, address_key, property_address, answer, answered_at,
    rule_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, address_key) WHERE deleted_at IS NULL
  DO UPDATE SET
    run_id = excluded.run_id,
    property_address = excluded.property_address,
    answer = excluded.answer,
    answered_at = excluded.answered_at,
    rule_version = excluded.rule_version,
    updated_at = excluded.updated_at
`;

/** One bound parameter: user id. Live answers only. */
export const LIST_DEAL_ANSWERS_SQL = sql`
  SELECT address_key, answer, rule_version
  FROM learn_deal_answers
  WHERE user_id = ? AND deleted_at IS NULL
`;

/** Soft-remove every live cleanup answer. Bound: deleted_at, updated_at, user id. */
export const SOFT_CLEAR_DEAL_ANSWERS_SQL = sql`
  UPDATE learn_deal_answers SET deleted_at = ?, updated_at = ?
  WHERE user_id = ? AND deleted_at IS NULL
`;

// ---------------------------------------------------------------------------
// Bulk sample
// ---------------------------------------------------------------------------

/** One bound parameter: user id. */
export const COUNT_LIVE_BULK_SAMPLE_SQL = sql`
  SELECT COUNT(*) AS n FROM learn_bulk_answers
  WHERE user_id = ? AND deleted_at IS NULL
`;

/**
 * Draw candidates for the bulk sample from the window. One row per provider
 * message. Bound: user id, since (ISO), limit.
 */
export const DRAW_BULK_CANDIDATES_SQL = sql`
  SELECT source, external_id
  FROM emails
  WHERE user_id = ? AND sent_at >= ?
    AND external_id IS NOT NULL AND source IN ('gmail', 'outlook')
  GROUP BY source, external_id
  ORDER BY random()
  LIMIT ?
`;

/**
 * Persist one sampled message with no answer yet. Bound: id, user id, source,
 * external id, sampled_at, rule_version, created_at, updated_at. An already
 * live row for the message is kept as is.
 */
export const INSERT_BULK_SAMPLE_SQL = sql`
  INSERT INTO learn_bulk_answers (
    id, user_id, source, external_id, sampled_at, answer, answered_at,
    rule_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  ON CONFLICT(user_id, source, external_id) WHERE deleted_at IS NULL DO NOTHING
`;

/** The next unanswered sample row. Bound: user id. */
export const NEXT_UNANSWERED_BULK_SQL = sql`
  SELECT id, source, external_id
  FROM learn_bulk_answers
  WHERE user_id = ? AND deleted_at IS NULL AND answer IS NULL
  ORDER BY sampled_at, id
  LIMIT 1
`;

/** Answer one sample row. Bound: answer, answered_at, updated_at, user id, row id. */
export const ANSWER_BULK_SQL = sql`
  UPDATE learn_bulk_answers SET answer = ?, answered_at = ?, updated_at = ?
  WHERE user_id = ? AND id = ? AND deleted_at IS NULL
`;

/** Soft-remove the whole live sample. Bound: deleted_at, updated_at, user id. */
export const SOFT_CLEAR_BULK_SQL = sql`
  UPDATE learn_bulk_answers SET deleted_at = ?, updated_at = ?
  WHERE user_id = ? AND deleted_at IS NULL
`;

/**
 * Answered sample rows with the text baseline 0 reads, resolved through the
 * provider key (never emails.id), one email row per message. Bound: user id.
 * subject / body columns are NULL when the message is no longer cached.
 */
export const ANSWERED_BULK_WITH_TEXT_SQL = sql`
  SELECT b.answer AS answer, e.subject AS subject, e.body_plain AS body_plain, e.body_html AS body_html,
         e.id IS NOT NULL AS cached
  FROM learn_bulk_answers b
  LEFT JOIN emails e ON e.id = (
    SELECT e2.id FROM emails e2
    WHERE e2.user_id = b.user_id AND e2.source = b.source AND e2.external_id = b.external_id
    ORDER BY e2.id LIMIT 1
  )
  WHERE b.user_id = ? AND b.deleted_at IS NULL AND b.answer IS NOT NULL
`;

// ---------------------------------------------------------------------------
// Baseline 0 inputs (read only)
// ---------------------------------------------------------------------------

/**
 * One keyset page of the user's mail in the window, oldest first. Walks
 * idx_emails_user_sent. Bound, in order: user id, since (ISO), cursor
 * sent_at, cursor id, page size. The first page passes ('', '').
 * `(sent_at, id) > (?, ?)`: rows sharing one sent_at are neither skipped nor
 * repeated across a page boundary. NULL sent_at never matches `>=`.
 */
export const EMAIL_KEYSET_PAGE_SQL = sql`
  SELECT id, subject, sender, recipients, body_plain, body_html, sent_at
  FROM emails
  WHERE user_id = ? AND sent_at >= ? AND (sent_at, id) > (?, ?)
  ORDER BY sent_at, id
  LIMIT ?
`;

/** Rows with no sent_at: counted and left out of the run. Bound: user id. */
export const COUNT_NULL_SENT_AT_SQL = sql`
  SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND sent_at IS NULL
`;

/**
 * Every local transaction of the user, for the answer key. Bound: user id.
 * NULL status / detection_source / detection_status read as the column
 * defaults ('active', 'manual', 'confirmed'): those columns have defaults but
 * no NOT NULL.
 */
export const ANSWER_KEY_TRANSACTIONS_SQL = sql`
  SELECT property_address,
         property_zip,
         transaction_type,
         COALESCE(status, 'active') AS status,
         COALESCE(detection_source, 'manual') AS detection_source,
         COALESCE(detection_status, 'confirmed') AS detection_status,
         started_at,
         closed_at,
         created_at
  FROM transactions
  WHERE user_id = ?
`;

// ---------------------------------------------------------------------------
// Preview (PR2): read only. The handler decides which ids may be asked for.
// ---------------------------------------------------------------------------

/**
 * Messages of one detection, by local id, scoped to the user. Bound: user id,
 * JSON array of email ids, limit. Newest first.
 */
export const PREVIEW_EMAILS_BY_IDS_SQL = sql`
  SELECT id, subject, sender, recipients, sent_at, body_html, body_plain
  FROM emails
  WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))
  ORDER BY sent_at DESC, id DESC
  LIMIT ?
`;

/**
 * The message behind one LIVE bulk sample row, resolved through the provider
 * key (never emails.id), scoped to the user. Bound: user id, sample row id.
 * No row when the sample row is not the user's live row or the message is no
 * longer cached.
 */
export const PREVIEW_EMAIL_FOR_BULK_ROW_SQL = sql`
  SELECT e.id AS id, e.subject AS subject, e.sender AS sender, e.recipients AS recipients,
         e.sent_at AS sent_at, e.body_html AS body_html, e.body_plain AS body_plain
  FROM learn_bulk_answers b
  JOIN emails e ON e.id = (
    SELECT e2.id FROM emails e2
    WHERE e2.user_id = b.user_id AND e2.source = b.source AND e2.external_id = b.external_id
    ORDER BY e2.id LIMIT 1
  )
  WHERE b.user_id = ? AND b.id = ? AND b.deleted_at IS NULL
`;

/** Is this a live sample row of the user? Bound: user id, row id. */
export const IS_LIVE_BULK_ROW_SQL = sql`
  SELECT 1 AS ok FROM learn_bulk_answers
  WHERE user_id = ? AND id = ? AND deleted_at IS NULL
`;

/**
 * Attachment metadata for the given messages of the user. Bound: user id,
 * JSON array of email ids. storage_path is set only when the file is already
 * on disk; Learn mode never downloads one.
 */
export const PREVIEW_ATTACHMENTS_SQL = sql`
  SELECT a.id AS id, a.email_id AS email_id, a.filename AS filename, a.mime_type AS mime_type,
         a.file_size_bytes AS file_size_bytes, a.storage_path AS storage_path
  FROM attachments a
  JOIN emails e ON e.id = a.email_id
  WHERE e.user_id = ? AND a.email_id IN (SELECT value FROM json_each(?))
  ORDER BY a.email_id, a.filename, a.id
`;
