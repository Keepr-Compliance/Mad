/**
 * Submission Database Service
 * Handles submission-related queries for audit package submission and sync
 */

import type { Message, Attachment } from "../../types";
import { ensureDb } from "./core/dbConnection";
// BACKLOG-2781: the closing-day end bound is the export resolver's, not a
// local re-derivation. Each call below is its own call site on purpose —
// three independent queries (texts, emails, email attachments), three
// independent regressions to guard. Text attachments have no window of their
// own: they follow the texts `getTransactionMessages` returns (BACKLOG-3731).
import { auditWindowEnd, type SelectedTextIds } from "../exportPlan";
import { selectTextAttachmentsForMessages } from "./textAttachmentLookupSql";

/**
 * An attachment row as the submit sees it. Text rows carry
 * `resolved_message_id` — the text they belong to under the shared lookup
 * (BACKLOG-3731). Key text rows on it, never on `message_id`.
 */
export type SubmissionAttachment = Attachment & {
  email_id?: string | null;
  external_message_id?: string | null;
  resolved_message_id?: string;
};

// ============================================
// SUBMISSION QUERIES (TASK-2100)
// ============================================

/** Submission transaction row shape */
export type SubmissionTransactionRow = {
  id: string;
  property_address: string;
  submission_id: string;
  submission_status: string | null;
  last_review_notes: string | null;
};

// ============================================
// CHECKLIST LINKS SENT REGARDLESS OF THE DATES (BACKLOG-3764)
// ============================================

/**
 * The members of this transaction's checklist groups the agent chose to send
 * although they are dated outside the audit dates
 * (`transaction_checklist_links.include_outside_dates = 1`). One bound
 * parameter: the transaction id. Scoped through items -> checklists to THIS
 * transaction, so a flagged group on another deal pulls nothing in.
 *
 * Used INSIDE the shared readers below, never by the gather alone: the scope
 * preview and the submit read through the same functions, so the summary
 * still counts exactly what is sent (BACKLOG-3683).
 */
const FLAGGED_LINK_EMAIL_IDS_SQL = `
  SELECT lm.email_id
  FROM transaction_checklist_link_members lm
  JOIN transaction_checklist_links l ON l.id = lm.link_id
  JOIN transaction_checklist_items i ON i.id = l.item_id
  JOIN transaction_checklists cl ON cl.id = i.checklist_id
  WHERE cl.transaction_id = ? AND l.include_outside_dates = 1 AND lm.email_id IS NOT NULL
`;

/** As {@link FLAGGED_LINK_EMAIL_IDS_SQL}, for attachment members. One bound parameter. */
const FLAGGED_LINK_ATTACHMENT_IDS_SQL = `
  SELECT lm.attachment_id
  FROM transaction_checklist_link_members lm
  JOIN transaction_checklist_links l ON l.id = lm.link_id
  JOIN transaction_checklist_items i ON i.id = l.item_id
  JOIN transaction_checklists cl ON cl.id = i.checklist_id
  WHERE cl.transaction_id = ? AND l.include_outside_dates = 1 AND lm.attachment_id IS NOT NULL
`;

/**
 * Load messages linked to a transaction via communications junction table,
 * with optional audit date range filter.
 *
 * BACKLOG-3733: only texts in `selected` are returned — the texts the export of
 * this deal would include (`selectSubmissionTextIds`). Required, so a caller
 * that has not been switched to the shared set does not compile.
 */
export function getTransactionMessages(
  transactionId: string,
  auditStartDate: Date | null | undefined,
  auditEndDate: Date | null | undefined,
  selected: SelectedTextIds
): Message[] {
  const db = ensureDb();

  let sql = `
    SELECT DISTINCT m.*
    FROM messages m
    INNER JOIN communications c ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      -- BACKLOG-3733: the same thread arm as the export's reader
      -- (getCommunicationsWithMessages): an email link that carries a thread
      -- id is not a text link, and only the linking user's copy of a thread.
      (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL
       AND c.thread_id = m.thread_id AND m.user_id = c.user_id)
    )
    WHERE c.transaction_id = ?
  `;
  const params: (string | number)[] = [transactionId];

  if (auditStartDate) {
    sql += ` AND m.sent_at >= ?`;
    params.push(auditStartDate.toISOString());
  }
  const messagesEnd = auditWindowEnd(auditEndDate);
  if (messagesEnd) {
    sql += ` AND m.sent_at <= ?`;
    params.push(messagesEnd.toISOString());
  }

  sql += ` ORDER BY m.sent_at ASC`;
  const rows = db.prepare(sql).all(...params) as Message[];
  return rows.filter((m) => selected.has(m.id));
}

/**
 * Load emails linked to a transaction via communications.email_id,
 * with optional audit date range filter.
 *
 * BACKLOG-3764: plus the emails of checklist groups the agent chose to send
 * regardless of the dates (they are still emails linked to this transaction).
 */
export function getTransactionEmails(
  transactionId: string,
  auditStartDate?: Date | null,
  auditEndDate?: Date | null
): Record<string, unknown>[] {
  const db = ensureDb();

  let sql = `
    SELECT DISTINCT e.*
    FROM emails e
    INNER JOIN communications c ON c.email_id = e.id
    WHERE c.transaction_id = ?
  `;
  const params: (string | number)[] = [transactionId];

  const inWindow: string[] = [];
  if (auditStartDate) {
    inWindow.push(`e.sent_at >= ?`);
    params.push(auditStartDate.toISOString());
  }
  const emailsEnd = auditWindowEnd(auditEndDate);
  if (emailsEnd) {
    inWindow.push(`e.sent_at <= ?`);
    params.push(emailsEnd.toISOString());
  }
  if (inWindow.length > 0) {
    sql += ` AND ((${inWindow.join(" AND ")}) OR e.id IN (${FLAGGED_LINK_EMAIL_IDS_SQL}))`;
    params.push(transactionId);
  }

  sql += ` ORDER BY e.sent_at ASC`;
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

/**
 * Load attachments linked to a transaction (both text message and email attachments),
 * with optional audit date range filter.
 *
 * BACKLOG-3733: text attachments belong to the texts in `selected` only, the
 * same set {@link getTransactionMessages} sends.
 */
export function getTransactionAttachments(
  transactionId: string,
  auditStartDate: Date | null | undefined,
  auditEndDate: Date | null | undefined,
  selected: SelectedTextIds
): SubmissionAttachment[] {
  const db = ensureDb();

  // BACKLOG-3731: text attachments come from the shared lookup the Messages
  // view uses, over exactly the texts this submission sends. Read-only.
  const textMessageIds = getTransactionMessages(transactionId, auditStartDate, auditEndDate, selected).map(
    (m) => m.id
  );
  const textAttachments: SubmissionAttachment[] = selectTextAttachmentsForMessages<
    SubmissionAttachment & { message_id: string }
  >(db, textMessageIds)
    .filter(({ row }) => typeof row.storage_path === "string")
    .map(({ row, resolved_message_id }) => ({ ...row, resolved_message_id }));

  // BACKLOG-3764: a text attachment of a checklist group the agent chose to
  // send regardless of the dates. Still only the attachments of texts in
  // `selected` (hidden texts, owner copies and duplicates stay out), and still
  // only rows with a local file; the date is the only thing waived.
  const flaggedAttachmentIds = new Set(
    (db.prepare(FLAGGED_LINK_ATTACHMENT_IDS_SQL).all(transactionId) as { attachment_id: string }[]).map(
      (r) => r.attachment_id
    )
  );
  if (flaggedAttachmentIds.size > 0 && (auditStartDate || auditEndDate)) {
    const inWindowTexts = new Set(textMessageIds);
    const outsideTexts = getTransactionMessages(transactionId, null, null, selected)
      .map((m) => m.id)
      .filter((id) => !inWindowTexts.has(id));
    textAttachments.push(
      ...selectTextAttachmentsForMessages<SubmissionAttachment & { message_id: string }>(db, outsideTexts)
        .filter(({ row }) => typeof row.storage_path === "string" && flaggedAttachmentIds.has(row.id))
        .map(({ row, resolved_message_id }) => ({ ...row, resolved_message_id }))
    );
  }

  // Build email date filter. BACKLOG-3764: a flagged checklist group's email
  // brings ALL its files, and a flagged file comes on its own; both still need
  // a local file (`storage_path`), which stays outside the OR.
  let emailDateFilter = "";
  const emailDateParams: string[] = [];
  const emailInWindow: string[] = [];
  if (auditStartDate) {
    emailInWindow.push("e.sent_at >= ?");
    emailDateParams.push(auditStartDate.toISOString());
  }
  const emailAttachmentsEnd = auditWindowEnd(auditEndDate);
  if (emailAttachmentsEnd) {
    emailInWindow.push("e.sent_at <= ?");
    emailDateParams.push(emailAttachmentsEnd.toISOString());
  }
  if (emailInWindow.length > 0) {
    emailDateFilter = ` AND ((${emailInWindow.join(" AND ")}) OR e.id IN (${FLAGGED_LINK_EMAIL_IDS_SQL}) OR a.id IN (${FLAGGED_LINK_ATTACHMENT_IDS_SQL}))`;
    emailDateParams.push(transactionId, transactionId);
  }

  // Query 2: Email attachments
  const emailAttachmentsSql = `
    SELECT DISTINCT a.*
    FROM attachments a
    INNER JOIN emails e ON a.email_id = e.id
    INNER JOIN communications c ON c.email_id = e.id
    WHERE c.transaction_id = ?
    AND a.email_id IS NOT NULL
    AND a.storage_path IS NOT NULL
    ${emailDateFilter}
  `;
  const emailAttachments = db
    .prepare(emailAttachmentsSql)
    .all(transactionId, ...emailDateParams) as Attachment[];

  // Combine, deduplicate by id, and sort by created_at
  const allAttachments = [...textAttachments, ...emailAttachments];
  const uniqueAttachments = Array.from(
    new Map(allAttachments.map((a) => [a.id, a])).values()
  );
  uniqueAttachments.sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at as string).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at as string).getTime() : 0;
    return aTime - bTime;
  });

  return uniqueAttachments;
}

/**
 * BACKLOG-3403: email attachment rows that still have no local file. Run AFTER
 * the on-demand download, so what it returns is what the download could not
 * fetch. Keyed by the in-window email ids the gather already chose.
 */
export function getUndownloadedEmailAttachments(
  emailIds: string[]
): { id: string; email_id: string; filename: string | null }[] {
  if (emailIds.length === 0) return [];
  const db = ensureDb();
  const out: { id: string; email_id: string; filename: string | null }[] = [];
  // SQLite caps bound parameters; 500 per statement stays well under it.
  for (let i = 0; i < emailIds.length; i += 500) {
    const chunk = emailIds.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, email_id, filename FROM attachments
          WHERE email_id IN (${placeholders}) AND storage_path IS NULL
          ORDER BY id`
      )
      .all(...chunk) as { id: string; email_id: string; filename: string | null }[];
    out.push(...rows);
  }
  return out;
}

// ============================================
// SUBMISSION SYNC QUERIES (TASK-2100)
// ============================================

/**
 * Find a local transaction by its cloud submission_id.
 */
export function getTransactionBySubmissionId(
  submissionId: string
): SubmissionTransactionRow | undefined {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT id, property_address, submission_id, submission_status, last_review_notes
       FROM transactions WHERE submission_id = ?`
    )
    .get(submissionId) as SubmissionTransactionRow | undefined;
}

/**
 * Find a local transaction by id that has a submission_id (i.e., has been submitted).
 */
export function getSubmittedTransactionById(
  transactionId: string
): SubmissionTransactionRow | undefined {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT id, property_address, submission_id, submission_status, last_review_notes
       FROM transactions WHERE id = ? AND submission_id IS NOT NULL`
    )
    .get(transactionId) as SubmissionTransactionRow | undefined;
}

/**
 * Get all locally submitted transactions that still have active (non-final) statuses.
 */
export function getActiveSubmittedTransactions(): SubmissionTransactionRow[] {
  const db = ensureDb();
  return db
    .prepare(
      `SELECT id, property_address, submission_id, submission_status, last_review_notes
       FROM transactions
       WHERE submission_id IS NOT NULL
       AND submission_status NOT IN ('approved', 'rejected', 'not_submitted')
       ORDER BY submitted_at DESC`
    )
    .all() as SubmissionTransactionRow[];
}

/**
 * Update a transaction's submission status and review notes.
 */
export function updateTransactionSubmissionStatus(
  transactionId: string,
  submissionStatus: string,
  lastReviewNotes: string | null
): void {
  const db = ensureDb();
  db.prepare(
    `UPDATE transactions
     SET submission_status = ?,
         last_review_notes = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(submissionStatus, lastReviewNotes, new Date().toISOString(), transactionId);
}

// ============================================
// OWED BROKER-CHECKLIST PULLS (BACKLOG-3599)
// ============================================

/**
 * Key in `transactions.metadata` (local-only JSON; no other writer or reader)
 * holding the submission ids whose broker-added checklists are still owed.
 *
 * A SET, not a slot: marking adds an id if absent, clearing removes exactly
 * one id, and nothing overwrites. With a single slot, a resubmit while S1 is
 * owed followed by three failed pulls for S2 would replace S1 and lose S1's
 * checklist for good.
 *
 * It lives in the database so it survives a restart, a crash and a sign-out.
 */
const OWED_PULLS_KEY = "reviewChecklistPullOwed";

/** One transaction with at least one owed pull. */
export interface OwedReviewChecklistPulls {
  transactionId: string;
  submissionIds: string[];
}

function readMetadataObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function owedIdsOf(meta: Record<string, unknown>): string[] {
  const value = meta[OWED_PULLS_KEY];
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

/**
 * Apply `change` to the owed set of one transaction, atomically. Returns false
 * when the transaction does not exist.
 */
function updateOwedSet(
  transactionId: string,
  change: (ids: string[]) => string[]
): boolean {
  const db = ensureDb();
  return db.transaction((): boolean => {
    const row = db
      .prepare(`SELECT metadata FROM transactions WHERE id = ?`)
      .get(transactionId) as { metadata: unknown } | undefined;
    if (!row) return false;
    const meta = readMetadataObject(row.metadata);
    const before = owedIdsOf(meta);
    const after = change(before);
    if (after.length === before.length && after.every((id, i) => id === before[i])) {
      return true;
    }
    if (after.length > 0) meta[OWED_PULLS_KEY] = after;
    else delete meta[OWED_PULLS_KEY];
    db.prepare(`UPDATE transactions SET metadata = ? WHERE id = ?`).run(
      Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
      transactionId
    );
    return true;
  })();
}

/** Record that `submissionId`'s broker-added checklists are owed. Adds if absent. */
export function markReviewChecklistPullOwed(
  transactionId: string,
  submissionId: string
): boolean {
  return updateOwedSet(transactionId, (ids) =>
    ids.includes(submissionId) ? ids : [...ids, submissionId]
  );
}

/** Remove exactly `submissionId` from the owed set; other ids stay. */
export function clearReviewChecklistPullOwed(
  transactionId: string,
  submissionId: string
): void {
  updateOwedSet(transactionId, (ids) => ids.filter((id) => id !== submissionId));
}

/** The owed ids of one transaction (empty when none). */
export function getOwedReviewChecklistPullsFor(transactionId: string): string[] {
  const db = ensureDb();
  const row = db
    .prepare(`SELECT metadata FROM transactions WHERE id = ?`)
    .get(transactionId) as { metadata: unknown } | undefined;
  return row ? owedIdsOf(readMetadataObject(row.metadata)) : [];
}

/** Every transaction with at least one owed pull. */
export function getOwedReviewChecklistPulls(): OwedReviewChecklistPulls[] {
  const db = ensureDb();
  const rows = db
    .prepare(
      `SELECT id, metadata FROM transactions
        WHERE json_valid(metadata)
          AND json_type(metadata, '$.${OWED_PULLS_KEY}') = 'array'`
    )
    .all() as Array<{ id: string; metadata: unknown }>;
  return rows
    .map((row) => ({
      transactionId: row.id,
      submissionIds: owedIdsOf(readMetadataObject(row.metadata)),
    }))
    .filter((row) => row.submissionIds.length > 0);
}
