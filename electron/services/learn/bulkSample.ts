/**
 * Bulk sample — BACKLOG-4120.
 *
 * ~200 messages from the window, drawn ONCE and persisted with no answer, so
 * the same sample comes back across sessions. Keyed by (user, provider,
 * provider message id): a force re-cache re-inserts emails under new local
 * ids, and the sample still resolves (C12).
 *
 * One combined question per message (founder, 2026-11-04): "Is this real
 * estate business, or a newsletter / spam?" -> real_estate / newsletter_spam /
 * skip.
 */
import { computeEmailCacheSinceDate } from "../../utils/preferenceHelper";
import {
  answerBulk,
  countLiveBulkSample,
  drawBulkCandidates,
  insertBulkSample,
  nextUnansweredBulk,
} from "../db/learnModeDbService";
import { LEARN_RULES, type BulkAnswer } from "./learnRules";
import { validateWindowMonths } from "./baselineRunner";

export interface SampleDrawResult {
  /** Live sample rows after the call. */
  sampleSize: number;
  /** Rows written by this call (0 when a sample already existed). */
  drawn: number;
}

/** Draw the sample unless a live one exists. Counts only in the return. */
export function ensureBulkSample(
  userId: string,
  windowMonthsInput: unknown,
  nowMs: number = Date.now(),
): SampleDrawResult {
  const existing = countLiveBulkSample(userId);
  if (existing > 0) return { sampleSize: existing, drawn: 0 };
  const windowMonths = validateWindowMonths(windowMonthsInput);
  const sinceIso = computeEmailCacheSinceDate(windowMonths, nowMs).toISOString();
  const candidates = drawBulkCandidates(userId, sinceIso, LEARN_RULES.bulkSampleSize);
  const drawn = insertBulkSample(userId, candidates, LEARN_RULES.version);
  return { sampleSize: countLiveBulkSample(userId), drawn };
}

/** The next unanswered sample row id, or null when the sample is done. */
export function nextBulkQuestion(userId: string): { rowId: string } | null {
  const row = nextUnansweredBulk(userId);
  return row ? { rowId: row.id } : null;
}

export function isBulkAnswer(value: unknown): value is BulkAnswer {
  return typeof value === "string" && (LEARN_RULES.bulkAnswers as readonly string[]).includes(value);
}

/** Returns false for an unknown value or a row that is not the user's live sample row. */
export function answerBulkQuestion(userId: string, rowId: string, answer: unknown): boolean {
  if (!isBulkAnswer(answer)) return false;
  return answerBulk(userId, rowId, answer);
}
