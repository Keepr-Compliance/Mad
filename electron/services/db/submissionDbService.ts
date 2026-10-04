/**
 * Submission Database Service
 * Handles submission-related queries for audit package submission and sync
 */

import type { Message, Attachment } from "../../types";
import { ensureDb } from "./core/dbConnection";
// BACKLOG-2781: the closing-day end bound is the export resolver's, not a
// local re-derivation. Each call below is its own call site on purpose —
// four independent queries, four independent regressions to guard.
import { auditWindowEnd } from "../exportPlan";

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

/**
 * Load messages linked to a transaction via communications junction table,
 * with optional audit date range filter.
 */
export function getTransactionMessages(
  transactionId: string,
  auditStartDate?: Date | null,
  auditEndDate?: Date | null
): Message[] {
  const db = ensureDb();

  let sql = `
    SELECT DISTINCT m.*
    FROM messages m
    INNER JOIN communications c ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
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
  return db.prepare(sql).all(...params) as Message[];
}

/**
 * Load emails linked to a transaction via communications.email_id,
 * with optional audit date range filter.
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

  if (auditStartDate) {
    sql += ` AND e.sent_at >= ?`;
    params.push(auditStartDate.toISOString());
  }
  const emailsEnd = auditWindowEnd(auditEndDate);
  if (emailsEnd) {
    sql += ` AND e.sent_at <= ?`;
    params.push(emailsEnd.toISOString());
  }

  sql += ` ORDER BY e.sent_at ASC`;
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

/**
 * Load attachments linked to a transaction (both text message and email attachments),
 * with optional audit date range filter.
 */
export function getTransactionAttachments(
  transactionId: string,
  auditStartDate?: Date | null,
  auditEndDate?: Date | null
): Attachment[] {
  const db = ensureDb();

  // Build date filter conditions for text messages
  let dateFilter = "";
  const dateParams: string[] = [];
  if (auditStartDate) {
    dateFilter += " AND m.sent_at >= ?";
    dateParams.push(auditStartDate.toISOString());
  }
  const textAttachmentsEnd = auditWindowEnd(auditEndDate);
  if (textAttachmentsEnd) {
    dateFilter += " AND m.sent_at <= ?";
    dateParams.push(textAttachmentsEnd.toISOString());
  }

  // Query 1: Text message attachments
  const textAttachmentsSql = `
    SELECT DISTINCT a.*
    FROM attachments a
    INNER JOIN messages m ON a.message_id = m.id
    INNER JOIN communications c ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id = ?
    AND a.storage_path IS NOT NULL
    ${dateFilter}
  `;
  const textAttachments = db
    .prepare(textAttachmentsSql)
    .all(transactionId, ...dateParams) as Attachment[];

  // Build email date filter
  let emailDateFilter = "";
  const emailDateParams: string[] = [];
  if (auditStartDate) {
    emailDateFilter += " AND e.sent_at >= ?";
    emailDateParams.push(auditStartDate.toISOString());
  }
  const emailAttachmentsEnd = auditWindowEnd(auditEndDate);
  if (emailAttachmentsEnd) {
    emailDateFilter += " AND e.sent_at <= ?";
    emailDateParams.push(emailAttachmentsEnd.toISOString());
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
