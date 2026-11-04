/**
 * Learn mode storage — BACKLOG-4120.
 *
 * Writes only the three learn_ tables; reads `emails` and `transactions`.
 * See learnModeSql.ts. Nothing here creates, changes or removes a
 * transaction, and nothing here removes a learn row (soft removal only).
 */
import crypto from "crypto";
import { dbAll, dbGet, dbRun, dbTransaction } from "./core/dbConnection";
import {
  ANSWERED_BULK_WITH_TEXT_SQL,
  ANSWER_BULK_SQL,
  ANSWER_KEY_TRANSACTIONS_SQL,
  COUNT_LIVE_BULK_SAMPLE_SQL,
  COUNT_NULL_SENT_AT_SQL,
  DRAW_BULK_CANDIDATES_SQL,
  EMAIL_KEYSET_PAGE_SQL,
  GET_LEARN_MODE_ENABLED_SQL,
  INSERT_BULK_SAMPLE_SQL,
  LIST_DEAL_ANSWERS_SQL,
  NEXT_UNANSWERED_BULK_SQL,
  IS_LIVE_BULK_ROW_SQL,
  PREVIEW_ATTACHMENTS_SQL,
  PREVIEW_EMAILS_BY_IDS_SQL,
  PREVIEW_EMAIL_FOR_BULK_ROW_SQL,
  SOFT_CLEAR_BULK_SQL,
  SOFT_CLEAR_DEAL_ANSWERS_SQL,
  UPSERT_DEAL_ANSWER_SQL,
  UPSERT_LEARN_MODE_ENABLED_SQL,
} from "./learnModeSql";
import type { BulkAnswer, DealAnswer } from "../learn/learnRules";

export interface LearnEmailRow {
  id: string;
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  body_plain: string | null;
  body_html: string | null;
  sent_at: string;
}

export interface AnswerKeyRow {
  property_address: string;
  property_zip: string | null;
  transaction_type: string | null;
  status: string;
  detection_source: string;
  detection_status: string;
  started_at: string | null;
  closed_at: string | null;
  /** transactions.created_at (CURRENT_TIMESTAMP default, or ISO from a writer). */
  created_at: string | null;
}

export interface DealAnswerRow {
  address_key: string;
  answer: DealAnswer;
  rule_version: number;
}

export interface BulkSampleRow {
  id: string;
  source: "gmail" | "outlook";
  external_id: string;
}

export interface AnsweredBulkRow {
  answer: BulkAnswer;
  subject: string | null;
  body_plain: string | null;
  body_html: string | null;
  cached: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- switch ---------------------------------------------------------------

/** Missing row = OFF. */
export function getLearnModeEnabled(userId: string): boolean {
  const row = dbGet<{ enabled: number }>(GET_LEARN_MODE_ENABLED_SQL, [userId]);
  return row?.enabled === 1;
}

export function setLearnModeEnabled(userId: string, enabled: boolean): void {
  const now = nowIso();
  dbRun(UPSERT_LEARN_MODE_ENABLED_SQL, [crypto.randomUUID(), userId, enabled ? 1 : 0, now, now]);
}

// ---- cleanup pass ---------------------------------------------------------

export function recordDealAnswer(input: {
  userId: string;
  runId: string;
  addressKey: string;
  propertyAddress: string;
  answer: DealAnswer;
  ruleVersion: number;
}): void {
  const now = nowIso();
  dbRun(UPSERT_DEAL_ANSWER_SQL, [
    crypto.randomUUID(),
    input.userId,
    input.runId,
    input.addressKey,
    input.propertyAddress,
    input.answer,
    now,
    input.ruleVersion,
    now,
    now,
  ]);
}

export function listDealAnswers(userId: string): DealAnswerRow[] {
  return dbAll<DealAnswerRow>(LIST_DEAL_ANSWERS_SQL, [userId]);
}

// ---- bulk sample ----------------------------------------------------------

export function countLiveBulkSample(userId: string): number {
  return dbGet<{ n: number }>(COUNT_LIVE_BULK_SAMPLE_SQL, [userId])?.n ?? 0;
}

export function drawBulkCandidates(
  userId: string,
  sinceIso: string,
  limit: number,
): Array<{ source: "gmail" | "outlook"; external_id: string }> {
  return dbAll(DRAW_BULK_CANDIDATES_SQL, [userId, sinceIso, limit]);
}

/** Persist sampled messages (answer NULL) in one transaction. Returns rows written. */
export function insertBulkSample(
  userId: string,
  rows: Array<{ source: "gmail" | "outlook"; external_id: string }>,
  ruleVersion: number,
): number {
  const now = nowIso();
  return dbTransaction(() => {
    let written = 0;
    for (const r of rows) {
      written += dbRun(INSERT_BULK_SAMPLE_SQL, [
        crypto.randomUUID(),
        userId,
        r.source,
        r.external_id,
        now,
        ruleVersion,
        now,
        now,
      ]).changes;
    }
    return written;
  });
}

export function nextUnansweredBulk(userId: string): BulkSampleRow | null {
  return dbGet<BulkSampleRow>(NEXT_UNANSWERED_BULK_SQL, [userId]) ?? null;
}

/** Returns false when the row is not the user's live sample row. */
export function answerBulk(userId: string, rowId: string, answer: BulkAnswer): boolean {
  const now = nowIso();
  return dbRun(ANSWER_BULK_SQL, [answer, now, now, userId, rowId]).changes > 0;
}

export function listAnsweredBulkWithText(userId: string): AnsweredBulkRow[] {
  return dbAll<AnsweredBulkRow>(ANSWERED_BULK_WITH_TEXT_SQL, [userId]);
}

// ---- delete my answers ----------------------------------------------------

/** Soft-removes every live cleanup answer and sample row. Rows stay on disk. */
export function softClearAnswers(userId: string): { deal: number; bulk: number } {
  const now = nowIso();
  return dbTransaction(() => ({
    deal: dbRun(SOFT_CLEAR_DEAL_ANSWERS_SQL, [now, now, userId]).changes,
    bulk: dbRun(SOFT_CLEAR_BULK_SQL, [now, now, userId]).changes,
  }));
}

// ---- baseline 0 inputs (read only) ----------------------------------------

export function emailKeysetPage(
  userId: string,
  sinceIso: string,
  cursor: { sentAt: string; id: string },
  pageSize: number,
): LearnEmailRow[] {
  return dbAll<LearnEmailRow>(EMAIL_KEYSET_PAGE_SQL, [userId, sinceIso, cursor.sentAt, cursor.id, pageSize]);
}

export function countNullSentAt(userId: string): number {
  return dbGet<{ n: number }>(COUNT_NULL_SENT_AT_SQL, [userId])?.n ?? 0;
}

export function listAnswerKeyTransactions(userId: string): AnswerKeyRow[] {
  return dbAll<AnswerKeyRow>(ANSWER_KEY_TRANSACTIONS_SQL, [userId]);
}

// ---- preview (read only) --------------------------------------------------

export interface PreviewEmailRow {
  id: string;
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  sent_at: string | null;
  body_html: string | null;
  body_plain: string | null;
}

export interface PreviewAttachmentRow {
  id: string;
  email_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

export function previewEmailsByIds(userId: string, emailIds: string[], limit: number): PreviewEmailRow[] {
  if (emailIds.length === 0) return [];
  return dbAll<PreviewEmailRow>(PREVIEW_EMAILS_BY_IDS_SQL, [userId, JSON.stringify(emailIds), limit]);
}

export function previewEmailForBulkRow(userId: string, rowId: string): PreviewEmailRow | null {
  return dbGet<PreviewEmailRow>(PREVIEW_EMAIL_FOR_BULK_ROW_SQL, [userId, rowId]) ?? null;
}

export function isLiveBulkRow(userId: string, rowId: string): boolean {
  return dbGet<{ ok: number }>(IS_LIVE_BULK_ROW_SQL, [userId, rowId])?.ok === 1;
}

export function previewAttachments(userId: string, emailIds: string[]): PreviewAttachmentRow[] {
  if (emailIds.length === 0) return [];
  return dbAll<PreviewAttachmentRow>(PREVIEW_ATTACHMENTS_SQL, [userId, JSON.stringify(emailIds)]);
}
