/**
 * Learn mode scoring — BACKLOG-4120.
 *
 * Scores a baseline-0 run against the answer key (hand-entered deals), the
 * cleanup answers and the bulk sample. Output = counts, rates and 95% Wilson
 * intervals only: no address, no subject, no row id. The Copy block is built
 * from this output and holds aggregates only (SR R9).
 *
 * Pure apart from `analyzeEmail` on the sampled messages' cached text.
 */
import transactionExtractorService from "../transactionExtractorService";
import type { AnswerKeyRow, AnsweredBulkRow, DealAnswerRow } from "../db/learnModeDbService";
import { buildAnswerKey, type AnswerKeyBucket, type KeyedTransaction } from "./answerKey";
import type { LearnDetection, LearnRunResult } from "./baselineRunner";
import { isSameDeal } from "./dealMatcher";
import { wilsonInterval, type WilsonInterval } from "./wilson";

export interface Rate {
  k: number;
  n: number;
  interval: WilsonInterval | null;
}

function rate(k: number, n: number): Rate {
  return { k, n, interval: wilsonInterval(k, n) };
}

export interface LearnScore {
  ruleVersion: number;
  windowMonths: number;
  earliestDay: string | null;
  latestDay: string | null;
  rowsScanned: number;
  nullSentAt: number;
  labelsWithoutLocalMail: number;
  buckets: Record<AnswerKeyBucket, number>;

  detections: number;
  /** Detections matched to a hand-entered deal. */
  trueDetections: number;
  /** Detections matched to a rejected deal. */
  knownWrong: number;
  /** Detections matched to an auto/hybrid row only (asked in the cleanup pass). */
  matchedNeutral: number;
  /** Detections matching no hand-entered or rejected deal. */
  unmatched: number;
  /** Distinct unmatched deals (addressKey) the cleanup pass can ask about. */
  unmatchedDeals: number;
  /** Unmatched detections with no addressKey: never asked, own count. */
  unaskable: number;
  /** Cleanup answers, per distinct deal key (not per detection). */
  cleanupYes: number;
  cleanupNo: number;
  cleanupUnanswered: number;

  positives: number;
  /** Positives that are 'manual' rows created before 2.33.0 (subset of positives). */
  legacyManualPositives: number;
  found: number;
  missed: number;

  recall: Rate;
  recallWithCleanupYes: Rate;
  /** Same two rates with the pre-2.33.0 'manual' rows left out of the answer key. */
  recallExcludingLegacy: Rate;
  recallWithCleanupYesExcludingLegacy: Rate;
  precisionBeforeCleanup: Rate;
  precisionAfterCleanup: Rate;

  side: { correct: number; wrong: number; notPredicted: number; skipped: number };
  outcome: { scorable: number; skipped: number; predicted: number };

  bulk: {
    answered: number;
    realEstate: number;
    newsletterSpam: number;
    skip: number;
    notCached: number;
    /** newsletter/spam messages that analyzeEmail flags as real estate. */
    newsletterFlagged: Rate;
    /** real estate messages that analyzeEmail flags as real estate. */
    realEstateFlagged: Rate;
  };
}

export interface CleanupCandidate {
  detectionId: string;
  address: string;
  addressKey: string;
}

type DetectionClass = "true" | "knownWrong" | "unmatched";

interface Classified {
  detection: LearnDetection;
  cls: DetectionClass;
  neutral: boolean;
  positive: KeyedTransaction | null;
}

function classify(
  detections: LearnDetection[],
  positives: KeyedTransaction[],
  negatives: KeyedTransaction[],
  neutral: KeyedTransaction[],
): Classified[] {
  return detections.map((d) => {
    const positive = positives.find((t) => isSameDeal(d, t)) ?? null;
    if (positive) return { detection: d, cls: "true", neutral: false, positive };
    if (negatives.some((t) => isSameDeal(d, t))) {
      return { detection: d, cls: "knownWrong", neutral: false, positive: null };
    }
    return { detection: d, cls: "unmatched", neutral: neutral.some((t) => isSameDeal(d, t)), positive: null };
  });
}

function scannedRange(run: LearnRunResult): { firstMs: number; lastMs: number } | null {
  return run.firstMs === null || run.lastMs === null ? null : { firstMs: run.firstMs, lastMs: run.lastMs };
}

/**
 * Detections the cleanup pass asks about: matched no hand-entered and no
 * rejected deal. Addresses stay in main; the asking channel is PR2's.
 */
export function cleanupCandidates(run: LearnRunResult, keyRows: AnswerKeyRow[]): CleanupCandidate[] {
  const key = buildAnswerKey(keyRows, scannedRange(run));
  return classify(run.detections, key.positives, key.negatives, key.neutral)
    .filter((c) => c.cls === "unmatched" && c.detection.addressKey !== null)
    .map((c) => ({
      detectionId: c.detection.id,
      address: c.detection.address,
      addressKey: c.detection.addressKey as string,
    }));
}

function toDay(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

export function scoreRun(
  run: LearnRunResult,
  keyRows: AnswerKeyRow[],
  dealAnswers: DealAnswerRow[],
  bulkRows: AnsweredBulkRow[],
): LearnScore {
  const key = buildAnswerKey(keyRows, scannedRange(run));
  const classified = classify(run.detections, key.positives, key.negatives, key.neutral);
  const answerByKey = new Map(dealAnswers.map((a) => [a.address_key, a.answer]));

  let trueDetections = 0;
  let knownWrong = 0;
  let unmatched = 0;
  let matchedNeutral = 0;
  let yesDetections = 0;
  let noDetections = 0;
  let unaskable = 0;
  const unmatchedKeys = new Set<string>();
  const yesKeys = new Set<string>();
  const noKeys = new Set<string>();
  const side = { correct: 0, wrong: 0, notPredicted: 0, skipped: 0 };
  const outcome = { scorable: 0, skipped: 0, predicted: 0 };

  for (const c of classified) {
    if (c.cls === "true") {
      trueDetections += 1;
      const pos = c.positive as KeyedTransaction;
      if (pos.side === null) side.skipped += 1;
      else if (c.detection.side === null) side.notPredicted += 1;
      else if (c.detection.side === pos.side) side.correct += 1;
      else side.wrong += 1;
      // Baseline 0 predicts no outcome; count what could be scored.
      if (pos.outcome === null) outcome.skipped += 1;
      else outcome.scorable += 1;
    } else if (c.cls === "knownWrong") {
      knownWrong += 1;
    } else {
      unmatched += 1;
      if (c.neutral) matchedNeutral += 1;
      const k = c.detection.addressKey;
      if (k) unmatchedKeys.add(k);
      else unaskable += 1;
      const answer = k ? answerByKey.get(k) : undefined;
      if (answer === "yes") {
        yesDetections += 1;
        yesKeys.add(k as string);
      } else if (answer === "no") {
        noDetections += 1;
        noKeys.add(k as string);
      }
    }
  }

  const foundOf = (list: KeyedTransaction[]) =>
    list.filter((p) => run.detections.some((d) => isSameDeal(d, p))).length;
  const nonLegacy = key.positives.filter((p) => !p.legacyManual);
  const found = foundOf(key.positives);
  const foundNonLegacy = foundOf(nonLegacy);
  const positives = key.positives.length;
  // Recall counts deals: one deal split into two keys by groupByProperty is one Yes.
  const cleanupYes = yesKeys.size;
  const cleanupNo = noKeys.size;
  const detections = run.detections.length;

  let realEstate = 0;
  let newsletterSpam = 0;
  let skip = 0;
  let notCached = 0;
  let nlFlagged = 0;
  let nlCached = 0;
  let reFlagged = 0;
  let reCached = 0;
  for (const b of bulkRows) {
    if (b.answer === "real_estate") realEstate += 1;
    else if (b.answer === "newsletter_spam") newsletterSpam += 1;
    else skip += 1;
    if (b.answer === "skip") continue;
    if (!b.cached) {
      notCached += 1;
      continue;
    }
    const flagged = transactionExtractorService.analyzeEmail({
      subject: b.subject ?? undefined,
      body: b.body_html ?? undefined,
      bodyPlain: b.body_plain ?? undefined,
      date: "",
    }).isRealEstateRelated;
    if (b.answer === "newsletter_spam") {
      nlCached += 1;
      if (flagged) nlFlagged += 1;
    } else {
      reCached += 1;
      if (flagged) reFlagged += 1;
    }
  }

  return {
    ruleVersion: run.ruleVersion,
    windowMonths: run.windowMonths,
    earliestDay: toDay(run.firstMs),
    latestDay: toDay(run.lastMs),
    rowsScanned: run.rowsScanned,
    nullSentAt: run.nullSentAt,
    labelsWithoutLocalMail: key.labelsWithoutLocalMail,
    buckets: key.buckets,
    detections,
    trueDetections,
    knownWrong,
    matchedNeutral,
    unmatched,
    unmatchedDeals: unmatchedKeys.size,
    unaskable,
    cleanupYes,
    cleanupNo,
    cleanupUnanswered: unmatchedKeys.size - cleanupYes - cleanupNo,
    positives,
    legacyManualPositives: key.legacyManualPositives,
    found,
    missed: positives - found,
    recall: rate(found, positives),
    recallWithCleanupYes: rate(found + cleanupYes, positives + cleanupYes),
    recallExcludingLegacy: rate(foundNonLegacy, nonLegacy.length),
    recallWithCleanupYesExcludingLegacy: rate(foundNonLegacy + cleanupYes, nonLegacy.length + cleanupYes),
    precisionBeforeCleanup: rate(trueDetections, detections),
    precisionAfterCleanup: rate(
      trueDetections + yesDetections,
      trueDetections + yesDetections + noDetections + knownWrong,
    ),
    side,
    outcome,
    bulk: {
      answered: bulkRows.length,
      realEstate,
      newsletterSpam,
      skip,
      notCached,
      newsletterFlagged: rate(nlFlagged, nlCached),
      realEstateFlagged: rate(reFlagged, reCached),
    },
  };
}

function fmt(r: Rate): string {
  if (!r.interval) return `${r.k}/${r.n} (n/a)`;
  return `${r.k}/${r.n} = ${r.interval.rate}% (95% CI ${r.interval.low}-${r.interval.high}%)`;
}

/** Aggregates only (SR R9): no ids, no addresses, no per-detection rows. */
export function formatCopyBlock(s: LearnScore): string {
  return [
    `Keepr Learn mode score (rules v${s.ruleVersion})`,
    `Window: ${s.windowMonths} months, ${s.earliestDay ?? "-"} to ${s.latestDay ?? "-"}`,
    `Emails scanned: ${s.rowsScanned}; without a sent date: ${s.nullSentAt}`,
    `Deals in key: manual ${s.buckets.manual} (of which created before 2.33.0, possibly auto-detected: ${s.legacyManualPositives} in the mail window), auto ${s.buckets.auto}, hybrid ${s.buckets.hybrid}, rejected ${s.buckets.rejected}; outside the mail window: ${s.labelsWithoutLocalMail}`,
    `Detections: ${s.detections}; true ${s.trueDetections}; known wrong ${s.knownWrong}; unmatched ${s.unmatched} = ${s.unmatchedDeals} deals + ${s.unaskable} without a key (cleanup yes ${s.cleanupYes}, no ${s.cleanupNo}, unanswered ${s.cleanupUnanswered})`,
    `Deals found: ${s.found}; missed: ${s.missed}`,
    `Recall: ${fmt(s.recall)}`,
    `Recall with cleanup Yes: ${fmt(s.recallWithCleanupYes)}`,
    `Recall without pre-2.33.0 manual deals: ${fmt(s.recallExcludingLegacy)}`,
    `Recall with cleanup Yes, without pre-2.33.0 manual deals: ${fmt(s.recallWithCleanupYesExcludingLegacy)}`,
    `Precision before cleanup: ${fmt(s.precisionBeforeCleanup)}`,
    `Precision after cleanup: ${fmt(s.precisionAfterCleanup)}`,
    `Side: correct ${s.side.correct}, wrong ${s.side.wrong}, not predicted ${s.side.notPredicted}, skipped ${s.side.skipped}`,
    `Outcome: scorable ${s.outcome.scorable}, skipped ${s.outcome.skipped}, predicted by baseline 0 ${s.outcome.predicted}`,
    `Bulk sample: answered ${s.bulk.answered} (real estate ${s.bulk.realEstate}, newsletter/spam ${s.bulk.newsletterSpam}, skip ${s.bulk.skip}, no longer cached ${s.bulk.notCached})`,
    `Newsletter/spam flagged as real estate: ${fmt(s.bulk.newsletterFlagged)}`,
    `Real estate flagged as real estate: ${fmt(s.bulk.realEstateFlagged)}`,
  ].join("\n");
}
