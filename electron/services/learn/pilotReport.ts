/**
 * Learn pilot report — BACKLOG-4219 PR2 (pure; no I/O).
 *
 * Builds the numbers-only snapshot a pilot user sends to Keepr when "Share my
 * score with Keepr" is ON. Field by field from the score and the two sender
 * censuses (never a spread), then checked against `PilotReportSchema`, a Zod
 * strictObject that mirrors the server's schema-1 validator exactly
 * (supabase/migrations/20261112130000_backlog_4219_learn_pilot_report.sql,
 * header "PAYLOAD"). Anything the schema refuses is NOT sent.
 *
 * What is sent: integers, booleans, {k, n} pairs, and exactly three strings:
 * `app_version` (x.y.z), `sender_rules_source` (download | cache | bundled) and
 * each mailbox `provider` (gmail | outlook | unknown). Map keys are fixed names.
 * Left out: dates (earliest / latest day, the legacy cutoff day), the Copy
 * block, Wilson intervals (the server recomputes from k / n), mailbox labels,
 * run / detection / account / user / org ids, addresses, rule content.
 *
 * Mailbox `ordinal`: "mailbox N" -> N (account order, as the score numbers
 * them); the NULL-account bucket ("unknown mailbox") -> 0.
 * Caps (the server's): at most 10 mailboxes per census block (the first 10 in
 * the score's order) and the 10 highest rules versions in answers_by_rule_version.
 */
import { z } from "zod/v4";

import type { SenderRuleSignal } from "../../utils/senderFilter/bundledRules";
import type { CensusCount, LearnScore, MailboxCensus, Rate, SenderCensus } from "./scoring";

export const PILOT_REPORT_SCHEMA_VERSION = 1;
export const PILOT_MAX_INT = 10_000_000;
export const PILOT_MAX_MAILBOXES = 10;
export const PILOT_MAX_ANSWER_VERSIONS = 10;
export const PILOT_MAX_BYTES = 32_768;

/** The 7 signal names, in the server's order. A new name = schema 2 + a migration. */
export const PILOT_SIGNALS = [
  "seedAddress",
  "approvedHost",
  "localPart",
  "bulkHeaders",
  "gmailPromotions",
  "gmailSocial",
  "gmailUpdates",
] as const satisfies readonly SenderRuleSignal[];

// ---- schema (mirrors the migration header, key for key) ---------------------

const Int = z.number().int().min(0).max(PILOT_MAX_INT);
const RateKN = z.strictObject({ k: Int, n: Int });
const BySignal = z.strictObject({
  seedAddress: Int,
  approvedHost: Int,
  localPart: Int,
  bulkHeaders: Int,
  gmailPromotions: Int,
  gmailSocial: Int,
  gmailUpdates: Int,
});
const MailboxCount = z.strictObject({ k: Int, by_signal: BySignal });
const Coverage = z.strictObject({ rows: Int, headers: Int, labels: Int });
const FullMinus = z.strictObject({ full: Int, minus: Int });

const CensusBlock = z.strictObject({
  mailboxes: z
    .array(
      z.strictObject({
        ordinal: Int,
        provider: z.enum(["gmail", "outlook", "unknown"]),
        n: Int,
        full: MailboxCount,
        minus_contact_keeps: MailboxCount,
        address_pass_ready: z.boolean(),
        detector_ready: z.boolean(),
      }),
    )
    .max(PILOT_MAX_MAILBOXES),
  min_linked_emails: Int,
  bulk_caught: RateKN,
  real_estate_suppressed: RateKN,
  found_deals_lost: FullMinus,
  cleanup_yes_lost: FullMinus,
  kept_by: z.strictObject({ K1: Int, K2: Int, K3: Int }),
  keep_conflicts: Int,
  coverage: z.strictObject({ gmail: Coverage, outlook: Coverage, unknown: Coverage }),
});

export const PilotReportSchema = z.strictObject({
  schema: z.literal(PILOT_REPORT_SCHEMA_VERSION),
  app_version: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/),
  learn_rules_version: Int,
  sender_rules_version: Int.min(1),
  sender_rules_source: z.enum(["download", "cache", "bundled"]),
  sender_rules_download_rejected: z.boolean(),
  window_months: Int,
  rows_scanned: Int,
  null_sent_at: Int,
  labels_without_local_mail: Int,
  legacy_manual_positives: Int,
  detections: Int,
  true_detections: Int,
  known_wrong: Int,
  matched_neutral: Int,
  unmatched: Int,
  unmatched_deals: Int,
  unaskable: Int,
  seed_linked_to_deals: Int,
  positives: Int,
  found: Int,
  missed: Int,
  deals_in_key: z.strictObject({ manual: Int, auto: Int, hybrid: Int, rejected: Int }),
  cleanup: z.strictObject({ yes: Int, no: Int, unanswered: Int }),
  hidden_by_seed: z.strictObject({ keys: Int, detections: Int, emails: Int }),
  recall: RateKN,
  recall_with_cleanup_yes: RateKN,
  recall_excluding_legacy: RateKN,
  recall_with_cleanup_yes_excluding_legacy: RateKN,
  precision_before_cleanup: RateKN,
  precision_after_cleanup: RateKN,
  side: z.strictObject({ correct: Int, wrong: Int, not_predicted: Int, skipped: Int }),
  outcome: z.strictObject({ scorable: Int, skipped: Int, predicted: Int }),
  bulk: z.strictObject({
    answered: Int,
    real_estate: Int,
    newsletter_spam: Int,
    skip: Int,
    not_cached: Int,
    newsletter_flagged: RateKN,
    real_estate_flagged: RateKN,
  }),
  answers_by_rule_version: z
    .array(z.strictObject({ rule_version: Int, deal: Int, bulk: Int }))
    .max(PILOT_MAX_ANSWER_VERSIONS),
  census: z.strictObject({ learn_questions: CensusBlock, detector: CensusBlock }),
});

export type PilotReport = z.infer<typeof PilotReportSchema>;

// ---- builder ------------------------------------------------------------------

function kn(r: Rate): { k: number; n: number } {
  return { k: r.k, n: r.n };
}

/** All 7 keys, zero-filled: the server checks the keys exactly (R6 / C-FILL). */
function bySignal(c: CensusCount): z.infer<typeof BySignal> {
  const out = {} as Record<(typeof PILOT_SIGNALS)[number], number>;
  for (const s of PILOT_SIGNALS) out[s] = c.bySignal[s] ?? 0;
  return out;
}

function ordinalOf(label: string): number {
  const m = /^mailbox (\d+)$/.exec(label);
  return m ? Number(m[1]) : 0;
}

function mailbox(m: MailboxCensus) {
  return {
    ordinal: ordinalOf(m.label),
    provider: m.provider,
    n: m.n,
    full: { k: m.full.k, by_signal: bySignal(m.full) },
    minus_contact_keeps: { k: m.minusContactKeeps.k, by_signal: bySignal(m.minusContactKeeps) },
    address_pass_ready: m.addressPassReady,
    detector_ready: m.detectorReady,
  };
}

function cov(c: { rows: number; headers: number; labels: number }) {
  return { rows: c.rows, headers: c.headers, labels: c.labels };
}

function censusBlock(c: SenderCensus) {
  return {
    mailboxes: c.dealLinkedSuppressed.slice(0, PILOT_MAX_MAILBOXES).map(mailbox),
    min_linked_emails: c.minCensusLinkedEmails,
    bulk_caught: kn(c.bulkCaught),
    real_estate_suppressed: kn(c.realEstateSuppressed),
    found_deals_lost: { full: c.foundDealsLost.full, minus: c.foundDealsLost.minusContactKeeps },
    cleanup_yes_lost: { full: c.cleanupYesLost.full, minus: c.cleanupYesLost.minusContactKeeps },
    kept_by: { K1: c.keptBy.K1, K2: c.keptBy.K2, K3: c.keptBy.K3 },
    keep_conflicts: c.keepConflicts,
    coverage: { gmail: cov(c.coverage.gmail), outlook: cov(c.coverage.outlook), unknown: cov(c.coverage.unknown) },
  };
}

export type BuildPilotReportResult =
  | { ok: true; report: PilotReport }
  /** `reason` names a field path or "too large", never a value. */
  | { ok: false; reason: string };

/**
 * The report for one score. `detector` = the census on the detector surface
 * (scoreRunWithDetector). Returns ok:false (nothing to send) when the result
 * would not pass the server's schema.
 */
export function buildPilotReport(score: LearnScore, detector: SenderCensus, appVersion: string): BuildPilotReportResult {
  const candidate = {
    schema: PILOT_REPORT_SCHEMA_VERSION,
    app_version: appVersion,
    learn_rules_version: score.ruleVersion,
    sender_rules_version: score.senderRulesVersion,
    sender_rules_source: score.senderRulesSource,
    sender_rules_download_rejected: score.senderRulesDownloadRejected,
    window_months: score.windowMonths,
    rows_scanned: score.rowsScanned,
    null_sent_at: score.nullSentAt,
    labels_without_local_mail: score.labelsWithoutLocalMail,
    legacy_manual_positives: score.legacyManualPositives,
    detections: score.detections,
    true_detections: score.trueDetections,
    known_wrong: score.knownWrong,
    matched_neutral: score.matchedNeutral,
    unmatched: score.unmatched,
    unmatched_deals: score.unmatchedDeals,
    unaskable: score.unaskable,
    seed_linked_to_deals: score.seedLinkedToDeals,
    positives: score.positives,
    found: score.found,
    missed: score.missed,
    deals_in_key: {
      manual: score.buckets.manual,
      auto: score.buckets.auto,
      hybrid: score.buckets.hybrid,
      rejected: score.buckets.rejected,
    },
    cleanup: { yes: score.cleanupYes, no: score.cleanupNo, unanswered: score.cleanupUnanswered },
    hidden_by_seed: {
      keys: score.hiddenBySeed.keys,
      detections: score.hiddenBySeed.detections,
      emails: score.hiddenBySeed.emails,
    },
    recall: kn(score.recall),
    recall_with_cleanup_yes: kn(score.recallWithCleanupYes),
    recall_excluding_legacy: kn(score.recallExcludingLegacy),
    recall_with_cleanup_yes_excluding_legacy: kn(score.recallWithCleanupYesExcludingLegacy),
    precision_before_cleanup: kn(score.precisionBeforeCleanup),
    precision_after_cleanup: kn(score.precisionAfterCleanup),
    side: {
      correct: score.side.correct,
      wrong: score.side.wrong,
      not_predicted: score.side.notPredicted,
      skipped: score.side.skipped,
    },
    outcome: { scorable: score.outcome.scorable, skipped: score.outcome.skipped, predicted: score.outcome.predicted },
    bulk: {
      answered: score.bulk.answered,
      real_estate: score.bulk.realEstate,
      newsletter_spam: score.bulk.newsletterSpam,
      skip: score.bulk.skip,
      not_cached: score.bulk.notCached,
      newsletter_flagged: kn(score.bulk.newsletterFlagged),
      real_estate_flagged: kn(score.bulk.realEstateFlagged),
    },
    answers_by_rule_version: [...score.answersByRuleVersion]
      .sort((a, b) => a.ruleVersion - b.ruleVersion)
      .slice(-PILOT_MAX_ANSWER_VERSIONS)
      .map((v) => ({ rule_version: v.ruleVersion, deal: v.deal, bulk: v.bulk })),
    census: { learn_questions: censusBlock(score.senderCensus), detector: censusBlock(detector) },
  };
  const parsed = PilotReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: first ? first.path.map(String).join(".") || first.code : "invalid" };
  }
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > PILOT_MAX_BYTES) return { ok: false, reason: "too large" };
  return { ok: true, report: parsed.data };
}
