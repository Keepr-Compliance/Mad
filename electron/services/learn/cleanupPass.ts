/**
 * Cleanup pass — BACKLOG-4120 (SR 1ec75158 change 4).
 *
 * Asks Yes/No about each detection of the last run that matched no
 * hand-entered and no rejected deal. An answer is stored in
 * the local cleanup-answer table ONLY. Yes never creates a transaction: the same card as
 * the product's F6 is reused for looks only.
 */
import { listAnswerKeyTransactions, listDealAnswers, recordDealAnswer } from "../db/learnModeDbService";
import { LEARN_RULES, type DealAnswer } from "./learnRules";
import type { LearnRunResult } from "./baselineRunner";
import { cleanupCandidates, type CleanupCandidate } from "./scoring";

export function isDealAnswer(value: unknown): value is DealAnswer {
  return typeof value === "string" && (LEARN_RULES.dealAnswers as readonly string[]).includes(value);
}

/**
 * The next unanswered candidate of the run, or null when the pass is done.
 * `excludeDetectionIds` (PR3): detections skipped for now in this session;
 * every candidate sharing a skipped detection's deal key is skipped too, so
 * the same deal is not asked again under its other key.
 */
export function nextCleanupQuestion(
  userId: string,
  run: LearnRunResult,
  excludeDetectionIds: readonly string[] = [],
): CleanupCandidate | null {
  const answered = new Set(listDealAnswers(userId).map((a) => a.address_key));
  const candidates = cleanupCandidates(run, listAnswerKeyTransactions(userId));
  const excluded = new Set(excludeDetectionIds);
  const skippedKeys = new Set(candidates.filter((c) => excluded.has(c.detectionId)).map((c) => c.addressKey));
  return candidates.find((c) => !answered.has(c.addressKey) && !skippedKeys.has(c.addressKey)) ?? null;
}

/**
 * Store an answer for one detection of the run. Refused (false) when the
 * value is not yes/no or the detection is not a cleanup candidate of this run.
 */
export function answerCleanupQuestion(
  userId: string,
  run: LearnRunResult,
  detectionId: string,
  answer: unknown,
): boolean {
  if (!isDealAnswer(answer)) return false;
  const candidate = cleanupCandidates(run, listAnswerKeyTransactions(userId)).find(
    (c) => c.detectionId === detectionId,
  );
  if (!candidate) return false;
  recordDealAnswer({
    userId,
    runId: run.runId,
    addressKey: candidate.addressKey,
    propertyAddress: candidate.address,
    answer,
    ruleVersion: LEARN_RULES.version,
  });
  return true;
}
