/**
 * Classification Feedback Database Service
 * Handles all classification feedback database operations
 *
 * Maps to the classification_feedback table in schema.sql.
 * Columns: id, user_id, message_id, attachment_id, transaction_id,
 *          contact_id, feedback_type, original_value, corrected_value,
 *          reason, created_at
 */

import crypto from "crypto";
import type { UserFeedback } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun } from "./core/dbConnection";

/**
 * Save user feedback on classified data
 */
export async function saveFeedback(
  feedbackData: Omit<UserFeedback, "id" | "created_at">,
): Promise<UserFeedback> {
  const id = crypto.randomUUID();

  // BACKLOG-2560: `attachment_id` is a real column (schema.sql:956) and
  // `UserFeedback` declares it (models.ts:1421), but the INSERT used to omit it
  // — so document-type feedback about an attachment landed with no attachment on
  // it. The declared model and the writer now agree.
  const sql = `
    INSERT INTO classification_feedback (
      id, user_id, transaction_id, message_id, attachment_id, contact_id,
      feedback_type, original_value, corrected_value, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    feedbackData.user_id,
    feedbackData.transaction_id || null,
    feedbackData.message_id || null,
    feedbackData.attachment_id || null,
    feedbackData.contact_id || null,
    feedbackData.feedback_type,
    feedbackData.original_value || null,
    feedbackData.corrected_value || null,
    feedbackData.reason || null,
  ];

  dbRun(sql, params);

  const feedback = dbGet<UserFeedback>(
    "SELECT * FROM classification_feedback WHERE id = ?",
    [id],
  );
  if (!feedback) {
    throw new DatabaseError("Failed to save feedback");
  }

  return feedback;
}

/**
 * Get all feedback for a transaction
 */
export async function getFeedbackByTransaction(
  transactionId: string,
): Promise<UserFeedback[]> {
  const sql = `
    SELECT * FROM classification_feedback
    WHERE transaction_id = ?
    ORDER BY created_at DESC
  `;

  return dbAll<UserFeedback>(sql, [transactionId]);
}

/**
 * Get feedback by feedback type
 */
export async function getFeedbackByField(
  userId: string,
  fieldName: string,
  limit: number = 100,
): Promise<UserFeedback[]> {
  const sql = `
    SELECT * FROM classification_feedback
    WHERE user_id = ? AND feedback_type = ?
    ORDER BY created_at DESC
    LIMIT ?
  `;

  return dbAll<UserFeedback>(sql, [userId, fieldName, limit]);
}

/**
 * Get all feedback for a user
 */
export async function getFeedbackByUser(
  userId: string,
  limit: number = 100,
): Promise<UserFeedback[]> {
  const sql = `
    SELECT * FROM classification_feedback
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `;

  return dbAll<UserFeedback>(sql, [userId, limit]);
}

/**
 * Get feedback by ID
 */
export async function getFeedbackById(
  feedbackId: string,
): Promise<UserFeedback | null> {
  const sql = "SELECT * FROM classification_feedback WHERE id = ?";
  const feedback = dbGet<UserFeedback>(sql, [feedbackId]);
  return feedback || null;
}

/**
 * Delete feedback
 */
export async function deleteFeedback(feedbackId: string): Promise<void> {
  const sql = "DELETE FROM classification_feedback WHERE id = ?";
  dbRun(sql, [feedbackId]);
}
