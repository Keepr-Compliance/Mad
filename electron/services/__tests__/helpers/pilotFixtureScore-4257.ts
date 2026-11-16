/**
 * BACKLOG-4219 / 4257 test helpers for the Learn pilot report (no I/O beyond
 * reading the committed fixture).
 *
 *   scoreFromFixture   the camelCase producer shape whose builder output is the
 *                      REAL fixture report (moved from learnPilotReportService-4219)
 *   syntheticSignals   a complete SignalScore over PILOT_SIGNAL_VALUE_NAMES with
 *                      varied small counts (synthetic; the real pass is exercised
 *                      in pilotReport-4257.test.ts)
 */
import * as fs from "fs";
import * as nodePath from "path";

import { PILOT_SIGNAL_FAMILIES, PILOT_SIGNAL_VALUE_NAMES } from "../../learn/pilotReport";
import type { LearnScore, SenderCensus } from "../../learn/scoring";
import type { SignalScore, SignalValueScore } from "../../learn/signalScoring";

export const PILOT_FIXTURE = nodePath.join(__dirname, "..", "..", "learn", "__tests__", "fixtures", "pilotReport-real-4219.json");
const FIXTURE = PILOT_FIXTURE;

export function fixtureReport(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")).report;
}

/**
 * A LearnScore + detector census whose builder output is the REAL fixture's
 * report: the camelCase producer shape, mapped back from that file (not invented
 * numbers). Only senderRulesVersion varies per test.
 */
export function scoreFromFixture(version = 1): { score: LearnScore; detector: SenderCensus } {
  const r = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).report;
  const rate = (x: { k: number; n: number }) => ({ k: x.k, n: x.n, interval: null });
  const block = (c: typeof r.census.learn_questions): SenderCensus => ({
    dealLinkedSuppressed: c.mailboxes.map((m: typeof c.mailboxes[number]) => ({
      label: m.ordinal === 0 ? "unknown mailbox" : `mailbox ${m.ordinal}`,
      provider: m.provider,
      n: m.n,
      full: { k: m.full.k, bySignal: m.full.by_signal },
      minusContactKeeps: { k: m.minus_contact_keeps.k, bySignal: m.minus_contact_keeps.by_signal },
      addressPassReady: m.address_pass_ready,
      detectorReady: m.detector_ready,
    })),
    minCensusLinkedEmails: c.min_linked_emails,
    bulkCaught: rate(c.bulk_caught),
    realEstateSuppressed: rate(c.real_estate_suppressed),
    foundDealsLost: { full: c.found_deals_lost.full, minusContactKeeps: c.found_deals_lost.minus },
    cleanupYesLost: { full: c.cleanup_yes_lost.full, minusContactKeeps: c.cleanup_yes_lost.minus },
    keptBy: c.kept_by,
    keepConflicts: c.keep_conflicts,
    coverage: c.coverage,
  });
  const score = {
    ruleVersion: r.learn_rules_version,
    windowMonths: r.window_months,
    earliestDay: null,
    latestDay: null,
    rowsScanned: r.rows_scanned,
    nullSentAt: r.null_sent_at,
    labelsWithoutLocalMail: r.labels_without_local_mail,
    buckets: r.deals_in_key,
    detections: r.detections,
    trueDetections: r.true_detections,
    knownWrong: r.known_wrong,
    matchedNeutral: r.matched_neutral,
    unmatched: r.unmatched,
    unmatchedDeals: r.unmatched_deals,
    unaskable: r.unaskable,
    cleanupYes: r.cleanup.yes,
    // Not in the report; the fixture's one Yes is on a street with no deal in the key.
    cleanupYesNotCounted: 0,
    cleanupNo: r.cleanup.no,
    cleanupUnanswered: r.cleanup.unanswered,
    hiddenBySeed: r.hidden_by_seed,
    seedLinkedToDeals: r.seed_linked_to_deals,
    answersByRuleVersion: r.answers_by_rule_version.map((a: { rule_version: number; deal: number; bulk: number }) => ({
      ruleVersion: a.rule_version,
      deal: a.deal,
      bulk: a.bulk,
    })),
    senderRulesVersion: version,
    senderRulesSource: r.sender_rules_source,
    senderRulesDownloadRejected: r.sender_rules_download_rejected,
    senderCensus: block(r.census.learn_questions),
    positives: r.positives,
    legacyManualPositives: r.legacy_manual_positives,
    legacyCutoffDay: "2026-01-01",
    legacyCutoffIsMinimum: false,
    found: r.found,
    missed: r.missed,
    recall: rate(r.recall),
    recallWithCleanupYes: rate(r.recall_with_cleanup_yes),
    recallExcludingLegacy: rate(r.recall_excluding_legacy),
    recallWithCleanupYesExcludingLegacy: rate(r.recall_with_cleanup_yes_excluding_legacy),
    precisionBeforeCleanup: rate(r.precision_before_cleanup),
    precisionAfterCleanup: rate(r.precision_after_cleanup),
    side: { correct: r.side.correct, wrong: r.side.wrong, notPredicted: r.side.not_predicted, skipped: r.side.skipped },
    outcome: r.outcome,
    bulk: {
      answered: r.bulk.answered,
      realEstate: r.bulk.real_estate,
      newsletterSpam: r.bulk.newsletter_spam,
      skip: r.bulk.skip,
      notCached: r.bulk.not_cached,
      newsletterFlagged: rate(r.bulk.newsletter_flagged),
      realEstateFlagged: rate(r.bulk.real_estate_flagged),
    },
  } as LearnScore;
  return { score, detector: block(r.census.detector) };
}

/** A complete signalsVersion-1 pass; `seed` varies every count. */
export function syntheticSignals(seed = 1, over: Partial<SignalScore> = {}): SignalScore {
  let i = 0;
  const n = () => ((seed * 31 + (i += 7)) % 89) + 1;
  const rate = () => {
    const k = n();
    return { k, n: k + n(), interval: null };
  };
  const values: SignalValueScore[] = [];
  for (const fam of PILOT_SIGNAL_FAMILIES) {
    const baseline = rate();
    for (const name of PILOT_SIGNAL_VALUE_NAMES[fam]) {
      values.push({
        id: `${fam}.${name}`,
        family: fam,
        newsletter: rate(),
        newsletterBaseline: { ...baseline },
        positives: rate(),
        gate: {
          trueKept: n(),
          trueLost: n(),
          knownWrongDropped: n(),
          knownWrongTotal: n(),
          cleanupNoDropped: n(),
          cleanupNoTotal: n(),
          cleanupYesLost: n(),
          cleanupYesTotal: n(),
          unmeasured: n(),
        },
        verdict: "not_enough_data",
        reasons: ["newsletter_n"],
      });
    }
  }
  const cov = () => ({ emails: n(), withAttachments: n(), withAttachmentText: n() });
  return {
    signalsVersion: 1,
    termsVersion: 1,
    complete: true,
    stoppedBy: null,
    timeLimitMs: 20_000,
    sampled: { dealLinkedCapped: false, detectionCapped: true, dealLinkedCap: 5_000, detectionCap: 5_000 },
    emails: {
      newsletter: n(),
      realEstateSample: n(),
      dealLinked: n(),
      contentPositives: n(),
      trueDetection: n(),
      gate: n(),
      bodyTruncated: n(),
    },
    textCoverage: { newsletter: cov(), contentPositives: cov(), trueDetection: cov() },
    values,
    ...over,
  };
}
