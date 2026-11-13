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
  COUNT_LIVE_ANSWERS_SQL,
  COUNT_LIVE_BULK_SAMPLE_SQL,
  COUNT_NULL_SENT_AT_SQL,
  DEAL_LINKED_EMAILS_SQL,
  DEAL_LINKED_SEED_CANDIDATES_SQL,
  DRAW_BULK_CANDIDATES_SQL,
  EMAIL_KEYSET_PAGE_SQL,
  GET_LEARN_MODE_ENABLED_SQL,
  GET_PILOT_STATE_SQL,
  LATEST_ANSWER_AT_SQL,
  PILOT_SET_SENT_VERSIONS_SQL,
  PILOT_SET_UNSETTLED_SQL,
  PILOT_TURN_OFF_SQL,
  PILOT_TURN_ON_SQL,
  PILOT_WITHDRAW_DONE_SQL,
  INSERT_BULK_SAMPLE_SQL,
  LIST_ANSWERS_SQL,
  LIST_DEAL_ANSWERS_SQL,
  NEXT_UNANSWERED_BULK_SQL,
  IS_LIVE_BULK_ROW_SQL,
  PREVIEW_ATTACHMENTS_SQL,
  PREVIEW_EMAILS_BY_IDS_SQL,
  PREVIEW_EMAIL_FOR_BULK_ROW_SQL,
  QUESTION_ATTACHMENT_SQL,
  REQUEUE_BULK_SQL,
  SOFT_DELETE_BULK_ANSWER_SQL,
  SOFT_DELETE_DEAL_ANSWER_SQL,
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
  source: string | null;
  account_id: string | null;
  labels: string | null;
  bulk_mail_headers: string | null;
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
  rule_version: number;
  subject: string | null;
  body_plain: string | null;
  body_html: string | null;
  cached: number;
  sender: string | null;
  source: string | null;
  account_id: string | null;
  labels: string | null;
  bulk_mail_headers: string | null;
}

/** BACKLOG-4175: a message linked to a non-rejected deal, as the sender census reads it. */
export interface DealLinkedEmailRow {
  id: string;
  sender: string | null;
  source: string | null;
  account_id: string | null;
  labels: string | null;
  bulk_mail_headers: string | null;
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

// ---- pilot report switch (BACKLOG-4219) -------------------------------------

export interface PilotState {
  enabled: boolean;
  pendingWithdraw: boolean;
  /** {sender_rules_version: ISO time of the last successful submit}; max 5 entries. */
  sentVersions: Record<string, string>;
  unsettledAt: string | null;
}

function parseSentVersions(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      if (/^[0-9]+$/.test(k) && typeof t === "string" && Number.isFinite(Date.parse(t))) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

/** Missing row = OFF, nothing pending, nothing sent. */
export function getPilotState(userId: string): PilotState {
  const row = dbGet<{
    pilot_report: number;
    pilot_pending_withdraw: number;
    pilot_sent_versions: string | null;
    pilot_unsettled_at: string | null;
  }>(GET_PILOT_STATE_SQL, [userId]);
  return {
    enabled: row?.pilot_report === 1,
    pendingWithdraw: row?.pilot_pending_withdraw === 1,
    sentVersions: parseSentVersions(row?.pilot_sent_versions),
    unsettledAt: row?.pilot_unsettled_at ?? null,
  };
}

export function setPilotOn(userId: string): void {
  dbRun(PILOT_TURN_ON_SQL, [nowIso(), userId]);
}

/** OFF + withdraw owed, in one statement. */
export function setPilotOffPending(userId: string): void {
  dbRun(PILOT_TURN_OFF_SQL, [nowIso(), userId]);
}

/** Also clears pilot_unsettled_at (one statement). */
export function markPilotWithdrawDone(userId: string): void {
  dbRun(PILOT_WITHDRAW_DONE_SQL, [nowIso(), userId]);
}

/** Sharing OFF + withdraw owed, only if the user shares or already owes one. Returns whether a withdraw is owed. */
function stopPilotSharingIfOn(userId: string): boolean {
  const st = getPilotState(userId);
  if (!st.enabled && !st.pendingWithdraw) return false;
  setPilotOffPending(userId);
  return true;
}

/**
 * The pilot sharing switch OFF: sharing OFF + withdraw owed, only when the user
 * shares or already owes one (one transaction). Returns whether a withdraw is owed.
 */
export function turnPilotSharingOff(userId: string): { pilotWithdrawOwed: boolean } {
  return dbTransaction(() => ({ pilotWithdrawOwed: stopPilotSharingIfOn(userId) }));
}

/**
 * Learn mode OFF and, in the same transaction, sharing OFF + withdraw owed
 * (when the user shares). Returns whether a withdraw is owed.
 */
export function turnLearnModeOff(userId: string): { pilotWithdrawOwed: boolean } {
  return dbTransaction(() => {
    setLearnModeEnabled(userId, false);
    return { pilotWithdrawOwed: stopPilotSharingIfOn(userId) };
  });
}

/**
 * Delete all answers (soft) and, in the same transaction, sharing OFF +
 * withdraw owed (when the user shares).
 */
export function softClearAnswersAndStopSharing(userId: string): {
  removed: { deal: number; bulk: number };
  pilotWithdrawOwed: boolean;
} {
  return dbTransaction(() => {
    const removed = softClearAnswers(userId);
    return { removed, pilotWithdrawOwed: stopPilotSharingIfOn(userId) };
  });
}

export function setPilotSentVersions(userId: string, map: Record<string, string>): void {
  dbRun(PILOT_SET_SENT_VERSIONS_SQL, [JSON.stringify(map), nowIso(), userId]);
}

export function setPilotUnsettledAt(userId: string, at: string | null): void {
  dbRun(PILOT_SET_UNSETTLED_SQL, [at, nowIso(), userId]);
}

/** Newest live answer time (deal or bulk), or null. */
export function latestAnswerAt(userId: string): string | null {
  return dbGet<{ latest: string | null }>(LATEST_ANSWER_AT_SQL, [userId, userId])?.latest ?? null;
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

// ---- "Your answers" (2.46.2) ---------------------------------------------

export interface LearnAnswerListRow {
  kind: "deal" | "bulk";
  id: string;
  label: string | null;
  item_date: string | null;
  answered_at: string | null;
  answer: string;
}

/** Most answers listed at once: ~200 sample rows plus the deals. */
export const LEARN_LIST_ANSWERS_LIMIT = 500;

/** The user's saved answers, newest first (own rows only). */
export function listAnswers(userId: string): LearnAnswerListRow[] {
  return dbAll<LearnAnswerListRow>(LIST_ANSWERS_SQL, [userId, userId, LEARN_LIST_ANSWERS_LIMIT]);
}

/**
 * Soft-remove ONE saved answer of the user. A deal answer is simply removed
 * (the cleanup pass asks the deal again while it is a candidate). A mail
 * answer is removed and its message put back in the sample with no answer,
 * in one transaction, so the sample keeps its size and the message is asked
 * again. Returns false when the id is not one of the user's live answers.
 */
export function softDeleteAnswer(userId: string, kind: "deal" | "bulk", id: string, ruleVersion: number): boolean {
  const now = nowIso();
  if (kind === "deal") {
    return dbRun(SOFT_DELETE_DEAL_ANSWER_SQL, [now, now, userId, id]).changes === 1;
  }
  return dbTransaction(() => {
    if (dbRun(SOFT_DELETE_BULK_ANSWER_SQL, [now, now, userId, id]).changes !== 1) return false;
    dbRun(REQUEUE_BULK_SQL, [crypto.randomUUID(), now, ruleVersion, now, now, id, userId]);
    return true;
  });
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

/**
 * BACKLOG-4175: candidate seed messages linked to the user's non-rejected
 * deals (substring prefilter; the caller matches the From address exactly).
 */
export function listDealLinkedSeedCandidates(
  userId: string,
  seedAddresses: readonly string[],
): Array<{ id: string; sender: string | null }> {
  if (seedAddresses.length === 0) return [];
  return dbAll<{ id: string; sender: string | null }>(DEAL_LINKED_SEED_CANDIDATES_SQL, [
    userId,
    userId,
    JSON.stringify(seedAddresses),
  ]);
}

/** BACKLOG-4175 (K1): contact emails on the user's non-rejected deals (shared reader). */
export { listDealContactEmails } from "./dealContactEmailsDb";

/** BACKLOG-4175 (census): messages linked to the user's non-rejected deals, once each. */
export function listDealLinkedEmails(userId: string): DealLinkedEmailRow[] {
  return dbAll<DealLinkedEmailRow>(DEAL_LINKED_EMAILS_SQL, [userId, userId]);
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

// ---- settings screen (PR3) ------------------------------------------------

/** Saved answers of the user (live cleanup answers + answered sample rows). */
export function countLiveAnswers(userId: string): { deal: number; bulk: number } {
  const row = dbGet<{ deal: number; bulk: number }>(COUNT_LIVE_ANSWERS_SQL, [userId, userId]);
  return { deal: row?.deal ?? 0, bulk: row?.bulk ?? 0 };
}

export interface QuestionAttachmentRow {
  id: string;
  email_id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
  provider_attachment_id: string | null;
  external_id: string | null;
  source: string | null;
}

/** One attachment on one of the user's own messages, or null. */
export function getQuestionAttachment(userId: string, attachmentId: string): QuestionAttachmentRow | null {
  return dbGet<QuestionAttachmentRow>(QUESTION_ATTACHMENT_SQL, [userId, attachmentId]) ?? null;
}
