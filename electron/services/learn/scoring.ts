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
import type { AnswerKeyRow, AnsweredBulkRow, DealAnswerRow, DealLinkedEmailRow } from "../db/learnModeDbService";
import { buildAnswerKey, type AnswerKeyBucket, type KeyedTransaction } from "./answerKey";
import type {
  FilteredDetection,
  LearnDetection,
  LearnRunResult,
  ProviderBucket,
} from "./baselineRunner";
import { isSameDeal, sameStreet } from "./dealMatcher";
import { wilsonInterval, type WilsonInterval } from "./wilson";
import type { SenderRuleSet, SenderRuleSignal } from "../../utils/senderFilter/bundledRules";
import {
  decide,
  matchesExactAddress,
  storedFilterRow,
  type KeepRuleId,
  type KeepSets,
} from "../../utils/senderFilter/senderFilter";

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

  /**
   * BACKLOG-4175: what the exact sender seeds hide from the cleanup pass.
   * `keys`: unanswered deal keys whose every candidate detection is all-seed
   * (left out of cleanupUnanswered; an already answered key still counts in
   * cleanupYes / cleanupNo). `detections`: all-seed candidate detections.
   * `emails`: seed messages in candidate detections (hidden from previews).
   */
  hiddenBySeed: { keys: number; detections: number; emails: number };
  /** Seed-matched messages linked to a non-rejected deal (expected 0). */
  seedLinkedToDeals: number;
  /** Saved answers per rules version (deal = cleanup answers, bulk = answered sample rows). */
  answersByRuleVersion: Array<{ ruleVersion: number; deal: number; bulk: number }>;
  senderRulesVersion: number;
  /** BACKLOG-4175: the sender filter, measured (aggregates only). */
  senderCensus: SenderCensus;

  positives: number;
  /** Positives that are 'manual' rows created before this user's cutoff (subset of positives). */
  legacyManualPositives: number;
  /** Day of this user's cutoff (UTC). */
  legacyCutoffDay: string;
  /** No auto/hybrid row proved the upgrade time: legacyManualPositives is a minimum. */
  legacyCutoffIsMinimum: boolean;
  found: number;
  missed: number;

  recall: Rate;
  recallWithCleanupYes: Rate;
  /** Same two rates with the legacy 'manual' rows (created before the user's cutoff) left out. */
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

/** One of the two counts the census reports: full precedence, and without K1/K3. */
export interface CensusCount {
  k: number;
  bySignal: Partial<Record<SenderRuleSignal, number>>;
}

export interface MailboxCensus {
  /** "mailbox 1", "mailbox 2", ... in account order, or "unknown mailbox" (NULL account). Never the account id. */
  label: string;
  provider: ProviderBucket;
  /** Messages linked to a non-rejected deal. */
  n: number;
  full: CensusCount;
  /** Without the contact keep rules K1 and K3. */
  minusContactKeeps: CensusCount;
  /** Full k = 0 (the address-pass exit criterion). */
  addressPassReady: boolean;
  /** Minus-K1/K3 k = 0 and n >= thresholds.minCensusLinkedEmails (the detector exit criterion). */
  detectorReady: boolean;
}

export interface SenderCensus {
  /** Deal-linked messages the filter would suppress, per mailbox. */
  dealLinkedSuppressed: MailboxCensus[];
  minCensusLinkedEmails: number;
  /** Newsletter/spam sample messages the filter would suppress. */
  bulkCaught: Rate;
  /** Real-estate sample messages the filter would suppress (sampled). */
  realEstateSuppressed: Rate;
  /** Hand-entered deals found by the run and NOT by the filtered run, per deal. */
  foundDealsLost: { full: number; minusContactKeeps: number };
  /** Cleanup-Yes deals with no detection left in the filtered run, per deal. */
  cleanupYesLost: { full: number; minusContactKeeps: number };
  keptBy: Record<KeepRuleId, number>;
  keepConflicts: number;
  coverage: Record<ProviderBucket, { rows: number; headers: number; labels: number }>;
}

/** What the census reads besides the run. */
export interface SenderCensusInput {
  rules: SenderRuleSet;
  keep: KeepSets;
  linked: DealLinkedEmailRow[];
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

/**
 * BACKLOG-4175: a detection is hidden from the cleanup pass when EVERY message
 * of it is suppressed by a sender signal that is live for Learn questions
 * (with the shipped rules: the exact seeds only). A mixed detection is still
 * asked (its preview leaves the hidden mail out).
 */
export function isHiddenBySenderRules(_run: LearnRunResult, d: LearnDetection): boolean {
  return d.emailIds.length > 0 && d.hiddenEmailIds.length === d.emailIds.length;
}

/**
 * BACKLOG-4175: the messages of a detection the user is shown: every message
 * except those a live sender signal suppresses on Learn questions.
 */
export function visibleEmailIds(_run: LearnRunResult, d: LearnDetection): string[] {
  if (d.hiddenEmailIds.length === 0) return d.emailIds;
  const hidden = new Set(d.hiddenEmailIds);
  return d.emailIds.filter((id) => !hidden.has(id));
}

/**
 * Deal keys hidden from the cleanup pass: keys whose every candidate
 * detection is hidden. Counted per key, the unit `cleanupUnanswered` uses.
 */
export function hiddenCleanupKeys(run: LearnRunResult, candidates: CleanupCandidate[]): Set<string> {
  const byId = new Map(run.detections.map((d) => [d.id, d]));
  const askable = new Set<string>();
  const all = new Set<string>();
  for (const c of candidates) {
    all.add(c.addressKey);
    const d = byId.get(c.detectionId);
    if (!d || !isHiddenBySenderRules(run, d)) askable.add(c.addressKey);
  }
  return new Set([...all].filter((k) => !askable.has(k)));
}

/**
 * BACKLOG-4175: of the candidate rows (deal-linked messages whose sender
 * contains a seed), those whose parsed From address IS a seed.
 */
export function countSeedLinkedToDeals(
  rows: ReadonlyArray<{ id: string; sender: string | null }>,
  rules: SenderRuleSet,
): number {
  return new Set(rows.filter((r) => matchesExactAddress(r.sender, rules)).map((r) => r.id)).size;
}

function answersByRuleVersion(
  dealAnswers: DealAnswerRow[],
  bulkRows: AnsweredBulkRow[],
): Array<{ ruleVersion: number; deal: number; bulk: number }> {
  const byVersion = new Map<number, { ruleVersion: number; deal: number; bulk: number }>();
  const slot = (v: number) => {
    let e = byVersion.get(v);
    if (!e) {
      e = { ruleVersion: v, deal: 0, bulk: 0 };
      byVersion.set(v, e);
    }
    return e;
  };
  for (const a of dealAnswers) slot(a.rule_version).deal += 1;
  for (const b of bulkRows) slot(b.rule_version).bulk += 1;
  return [...byVersion.values()].sort((a, b) => a.ruleVersion - b.ruleVersion);
}

function toDay(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

export function scoreRun(
  run: LearnRunResult,
  keyRows: AnswerKeyRow[],
  dealAnswers: DealAnswerRow[],
  bulkRows: AnsweredBulkRow[],
  seedLinkedToDeals: number,
  census: SenderCensusInput,
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

  // BACKLOG-4175: hidden per KEY; a key already answered stays in yes / no.
  const candidates = cleanupCandidates(run, keyRows);
  const hiddenUnanswered = [...hiddenCleanupKeys(run, candidates)].filter((k) => !answerByKey.has(k));
  const candidateDetections = candidates
    .map((c) => run.detections.find((d) => d.id === c.detectionId))
    .filter((d): d is LearnDetection => d !== undefined);
  const hiddenBySeed = {
    keys: hiddenUnanswered.length,
    detections: candidateDetections.filter((d) => isHiddenBySenderRules(run, d)).length,
    emails: candidateDetections.reduce((n, d) => n + d.hiddenEmailIds.length, 0),
  };

  let realEstate = 0;
  let newsletterSpam = 0;
  let skip = 0;
  let notCached = 0;
  let nlFlagged = 0;
  let nlCached = 0;
  let reFlagged = 0;
  let reCached = 0;
  let nlSuppressed = 0;
  let reSuppressed = 0;
  const suppressesInLearn = (b: AnsweredBulkRow) =>
    decide(storedFilterRow(b), census.rules, "learnQuestions", census.keep).outcome === "suppress";
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
      if (suppressesInLearn(b)) nlSuppressed += 1;
    } else {
      reCached += 1;
      if (flagged) reFlagged += 1;
      if (suppressesInLearn(b)) reSuppressed += 1;
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
    cleanupUnanswered: unmatchedKeys.size - cleanupYes - cleanupNo - hiddenBySeed.keys,
    hiddenBySeed,
    seedLinkedToDeals,
    answersByRuleVersion: answersByRuleVersion(dealAnswers, bulkRows),
    senderRulesVersion: run.senderRulesVersion,
    senderCensus: {
      dealLinkedSuppressed: dealLinkedCensus(census),
      minCensusLinkedEmails: census.rules.thresholds.minCensusLinkedEmails,
      bulkCaught: rate(nlSuppressed, nlCached),
      realEstateSuppressed: rate(reSuppressed, reCached),
      foundDealsLost: {
        full: dealsLost(run.detections, run.filtered.full, key.positives),
        minusContactKeeps: dealsLost(run.detections, run.filtered.minusContactKeeps, key.positives),
      },
      cleanupYesLost: {
        full: yesLost(candidateDetections, run.filtered.full, yesKeys),
        minusContactKeeps: yesLost(candidateDetections, run.filtered.minusContactKeeps, yesKeys),
      },
      keptBy: run.senderStats.keptBy,
      keepConflicts: run.senderStats.keepConflicts,
      coverage: run.senderStats.coverage,
    },
    positives,
    legacyManualPositives: key.legacyManualPositives,
    legacyCutoffDay: new Date(key.legacyCutoffMs).toISOString().slice(0, 10),
    legacyCutoffIsMinimum: key.legacyCutoffIsMinimum,
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

/** Deals found by the unfiltered run and by no detection of the filtered run (per deal, never a count difference). */
function dealsLost(
  unfiltered: LearnDetection[],
  filtered: FilteredDetection[],
  positives: KeyedTransaction[],
): number {
  return positives.filter(
    (p) => unfiltered.some((d) => isSameDeal(d, p)) && !filtered.some((d) => isSameDeal(d, p)),
  ).length;
}

/** Cleanup-Yes deal keys whose candidate detections have no same-street detection left in the filtered run. */
function yesLost(candidates: LearnDetection[], filtered: FilteredDetection[], yesKeys: Set<string>): number {
  let lost = 0;
  for (const k of yesKeys) {
    const mine = candidates.filter((d) => d.addressKey === k);
    if (mine.length === 0) continue;
    const kept = mine.some((d) => filtered.some((f) => sameStreet(f.address, d.address, null)));
    if (!kept) lost += 1;
  }
  return lost;
}

function emptyCount(): CensusCount {
  return { k: 0, bySignal: {} };
}

/** Per mailbox (emails.account_id; NULL is its own bucket), full and without K1/K3. */
function dealLinkedCensus(census: SenderCensusInput): MailboxCensus[] {
  const groups = new Map<string | null, DealLinkedEmailRow[]>();
  for (const r of census.linked) {
    const g = groups.get(r.account_id);
    if (g) g.push(r);
    else groups.set(r.account_id, [r]);
  }
  const accounts = [...groups.keys()].filter((a): a is string => a !== null).sort();
  const ordered: Array<[string | null, string]> = accounts.map((a, i) => [a, `mailbox ${i + 1}`]);
  if (groups.has(null)) ordered.push([null, "unknown mailbox"]);
  const min = census.rules.thresholds.minCensusLinkedEmails;
  return ordered.map(([account, label]) => {
    const rows = groups.get(account) as DealLinkedEmailRow[];
    const full = emptyCount();
    const minus = emptyCount();
    for (const r of rows) {
      const fr = storedFilterRow(r);
      const a = decide(fr, census.rules, "learnQuestions", census.keep);
      if (a.outcome === "suppress" && a.signal) {
        full.k += 1;
        full.bySignal[a.signal] = (full.bySignal[a.signal] ?? 0) + 1;
      }
      const b = decide(fr, census.rules, "learnQuestions", census.keep, { withoutContactKeeps: true });
      if (b.outcome === "suppress" && b.signal) {
        minus.k += 1;
        minus.bySignal[b.signal] = (minus.bySignal[b.signal] ?? 0) + 1;
      }
    }
    const src = rows[0]?.source;
    return {
      label,
      provider: src === "gmail" || src === "outlook" ? src : "unknown",
      n: rows.length,
      full,
      minusContactKeeps: minus,
      addressPassReady: full.k === 0,
      detectorReady: minus.k === 0 && rows.length >= min,
    };
  });
}

function bySignalText(c: CensusCount): string {
  const parts = Object.entries(c.bySignal).map(([sig, n]) => `${sig} ${n}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
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
    `Deals in key: manual ${s.buckets.manual} (of which created before ${s.legacyCutoffDay}, possibly auto-detected: ${s.legacyManualPositives} in the mail window${s.legacyCutoffIsMinimum ? ", minimum" : ""}), auto ${s.buckets.auto}, hybrid ${s.buckets.hybrid}, rejected ${s.buckets.rejected}; outside the mail window: ${s.labelsWithoutLocalMail}`,
    `Detections: ${s.detections}; true ${s.trueDetections}; known wrong ${s.knownWrong}; unmatched ${s.unmatched} = ${s.unmatchedDeals} deals + ${s.unaskable} without a key (cleanup yes ${s.cleanupYes}, no ${s.cleanupNo}, unanswered ${s.cleanupUnanswered})`,
    `Hidden by live sender rules (sender rules v${s.senderRulesVersion}): ${s.hiddenBySeed.keys} deals, ${s.hiddenBySeed.detections} detections, ${s.hiddenBySeed.emails} emails; seed emails linked to deals: ${s.seedLinkedToDeals}`,
    ...senderCensusLines(s.senderCensus),
    `Answers by rules version: ${s.answersByRuleVersion.length ? s.answersByRuleVersion.map((v) => `v${v.ruleVersion} deal ${v.deal} / bulk ${v.bulk}`).join(", ") : "none"}`,
    `Deals found: ${s.found}; missed: ${s.missed}`,
    `Recall: ${fmt(s.recall)}`,
    `Recall with cleanup Yes: ${fmt(s.recallWithCleanupYes)}`,
    `Recall without manual deals created before the cutoff: ${fmt(s.recallExcludingLegacy)}`,
    `Recall with cleanup Yes, without manual deals created before the cutoff: ${fmt(s.recallWithCleanupYesExcludingLegacy)}`,
    `Precision before cleanup: ${fmt(s.precisionBeforeCleanup)}`,
    `Precision after cleanup: ${fmt(s.precisionAfterCleanup)}`,
    `Side: correct ${s.side.correct}, wrong ${s.side.wrong}, not predicted ${s.side.notPredicted}, skipped ${s.side.skipped}`,
    `Outcome: scorable ${s.outcome.scorable}, skipped ${s.outcome.skipped}, predicted by baseline 0 ${s.outcome.predicted}`,
    `Bulk sample: answered ${s.bulk.answered} (real estate ${s.bulk.realEstate}, newsletter/spam ${s.bulk.newsletterSpam}, skip ${s.bulk.skip}, no longer cached ${s.bulk.notCached})`,
    `Newsletter/spam flagged as real estate: ${fmt(s.bulk.newsletterFlagged)}`,
    `Real estate flagged as real estate: ${fmt(s.bulk.realEstateFlagged)}`,
  ].join("\n");
}

/** The sender census as Copy-block lines (aggregates only; mailboxes by ordinal, never by id). */
export function senderCensusLines(c: SenderCensus): string[] {
  const mailboxes = c.dealLinkedSuppressed.length
    ? c.dealLinkedSuppressed.map(
        (m) =>
          `${m.label} (${m.provider}): ${m.full.k}/${m.n}${bySignalText(m.full)}; without contact keeps ${m.minusContactKeeps.k}/${m.n}${bySignalText(m.minusContactKeeps)}; address pass ${m.addressPassReady ? "ready" : "not ready"}, detector ${m.detectorReady ? "ready" : "not ready"}`,
      )
    : ["none"];
  const cov = (["gmail", "outlook", "unknown"] as const)
    .map((p) => `${p} headers ${c.coverage[p].headers}/${c.coverage[p].rows}, labels ${c.coverage[p].labels}/${c.coverage[p].rows}`)
    .join("; ");
  return [
    `Sender filter, deal-linked mail suppressed (detector needs >= ${c.minCensusLinkedEmails} per mailbox): ${mailboxes.join(" | ")}`,
    `Sender filter on the bulk sample: newsletter/spam caught ${fmt(c.bulkCaught)}; real estate suppressed ${fmt(c.realEstateSuppressed)}`,
    `Sender filter losses: deals found lost ${c.foundDealsLost.full} (without contact keeps ${c.foundDealsLost.minusContactKeeps}); cleanup Yes lost ${c.cleanupYesLost.full} (without contact keeps ${c.cleanupYesLost.minusContactKeeps})`,
    `Sender filter keeps: contact ${c.keptBy.K1}, platform ${c.keptBy.K2}, contact domain ${c.keptBy.K3}; exact-address conflicts ${c.keepConflicts}`,
    `Stored header coverage: ${cov}`,
  ];
}
