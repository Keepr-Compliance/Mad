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
