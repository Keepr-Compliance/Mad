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
 * A prerelease app version (`2.50.0-beta.1`) is sent as its release part
 * (`2.50.0`), the only form the schema and the server accept (BACKLOG-4245).
 * Left out: dates (earliest / latest day, the legacy cutoff day), the Copy
 * block, Wilson intervals (the server recomputes from k / n), mailbox labels,
 * run / detection / account / user / org ids, addresses, rule content.
 *
 * Mailbox `ordinal`: "mailbox N" -> N (account order, as the score numbers
 * them); the NULL-account bucket ("unknown mailbox") -> 0.
 * Caps (the server's): at most 10 mailboxes per census block (the first 10 in
 * the score's order) and the 10 highest rules versions in answers_by_rule_version.
 *
 * SCHEMA 2 (BACKLOG-4257): every schema-1 key, in the same order, plus `signals`:
 * the counts of one COMPLETE signal pass (signalScoring.ts), built field by field
 * (never a spread of SignalValueScore) and checked by `PilotReportV2Schema`, which
 * mirrors 20261117120000_backlog_4257_learn_pilot_signals.sql (strict at every
 * node, signals_version 1 only). Integers and booleans only: no Wilson intervals,
 * verdicts, reasons, ids or anything per email. No signals, an incomplete pass,
 * an unknown signals_version, a value list that is not PILOT_SIGNAL_VALUE_NAMES,
 * or a schema-2 report the server would refuse -> the schema-1 report, unchanged.
 * Size: the server measures `jsonb::text` (": " and ", " separators), so the
 * client measures `jsonbTextLength`, vs 65,536 for schema 2 and 32,768 for the
 * report without `signals`.
 */
import { z } from "zod/v4";

import type { SenderRuleSignal } from "../../utils/senderFilter/bundledRules";
import type { CensusCount, LearnScore, MailboxCensus, Rate, SenderCensus } from "./scoring";
import type { SignalScore, SignalValueScore } from "./signalScoring";

export const PILOT_REPORT_SCHEMA_VERSION = 1;
export const PILOT_MAX_INT = 10_000_000;
export const PILOT_MAX_MAILBOXES = 10;
export const PILOT_MAX_ANSWER_VERSIONS = 10;
export const PILOT_MAX_BYTES = 32_768;
/** BACKLOG-4257: schema 2 = schema 1 + `signals`. */
export const PILOT_REPORT_SCHEMA_V2 = 2;
/** The only signals_version the server accepts (an unknown one -> schema 1 is sent). */
export const PILOT_SIGNALS_VERSION = 1;
export const PILOT_MAX_BYTES_V2 = 65_536;

/**
 * The 40 signal value names per family, in the server's order: SIGNAL_VALUES ids
 * (signalScoring.ts) split on "." verbatim. Mirrored by the five ARRAYs in
 * _learn_pilot_signals_invalid. A changed list = a new signals_version + a
 * migration; until then the client sends schema 1.
 */
export const PILOT_SIGNAL_VALUE_NAMES = {
  anchor: ["subject", "bodyTop", "bodyMid", "afterSignature", "footer", "none", "nearFooterCue", "inQuoteOnly"],
  stage: ["offer", "counter", "underContract", "inspection", "appraisal", "closing", "any", "inSubject"],
  sender: ["dealContact", "vendorRoleDomain", "dealContactDomain", "platform", "freeMail", "other", "recipientIsDealContact", "bulk"],
  filename: ["purchaseAgreement", "counteroffer", "addendum", "inspection", "appraisal", "closing", "disclosure", "listing", "other"],
  forms: ["anyMatch", "purchase_agreement", "buyer_agreement", "listing_agreement", "counteroffer", "representation_termination", "other"],
} as const;
export type PilotSignalFamily = keyof typeof PILOT_SIGNAL_VALUE_NAMES;
export const PILOT_SIGNAL_FAMILIES = ["anchor", "stage", "sender", "filename", "forms"] as const satisfies readonly PilotSignalFamily[];

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

// ---- schema 2: the signals block (mirrors _learn_pilot_signals_invalid) ---------

const SignalGate = z.strictObject({
  true_kept: Int,
  true_lost: Int,
  known_wrong_dropped: Int,
  known_wrong_total: Int,
  cleanup_no_dropped: Int,
  cleanup_no_total: Int,
  cleanup_yes_lost: Int,
  cleanup_yes_total: Int,
  unmeasured: Int,
});
const SignalValue = z.strictObject({ newsletter: RateKN, positives: RateKN, gate: SignalGate });
function valueFamily<F extends PilotSignalFamily>(fam: F) {
  const shape = {} as Record<(typeof PILOT_SIGNAL_VALUE_NAMES)[F][number], typeof SignalValue>;
  for (const n of PILOT_SIGNAL_VALUE_NAMES[fam] as readonly (typeof PILOT_SIGNAL_VALUE_NAMES)[F][number][]) shape[n] = SignalValue;
  return z.strictObject(shape);
}
const TextCoverageBlock = z.strictObject({ emails: Int, with_attachments: Int, with_attachment_text: Int });

export const PilotSignalsSchema = z.strictObject({
  signals_version: z.literal(PILOT_SIGNALS_VERSION),
  terms_version: Int,
  deal_linked_capped: z.boolean(),
  detection_capped: z.boolean(),
  emails: z.strictObject({
    newsletter: Int,
    real_estate_sample: Int,
    deal_linked: Int,
    content_positives: Int,
    true_detection: Int,
    gate: Int,
    body_truncated: Int,
  }),
  text_coverage: z.strictObject({
    newsletter: TextCoverageBlock,
    content_positives: TextCoverageBlock,
    true_detection: TextCoverageBlock,
  }),
  baseline: z.strictObject({ anchor: RateKN, stage: RateKN, sender: RateKN, filename: RateKN, forms: RateKN }),
  values: z.strictObject({
    anchor: valueFamily("anchor"),
    stage: valueFamily("stage"),
    sender: valueFamily("sender"),
    filename: valueFamily("filename"),
    forms: valueFamily("forms"),
  }),
});

/** strictObject.extend stays strict (zod 4; SR plan review). `schema` keeps its place, `signals` is last. */
export const PilotReportV2Schema = PilotReportSchema.extend({
  schema: z.literal(PILOT_REPORT_SCHEMA_V2),
  signals: PilotSignalsSchema,
});

export type PilotSignals = z.infer<typeof PilotSignalsSchema>;
export type PilotReportV2 = z.infer<typeof PilotReportV2Schema>;

/**
 * The byte length of `value`'s Postgres `jsonb::text` (what octet_length measures
 * server side): compact JSON plus one space after every ':' and ',' outside a
 * string. Key order differs in jsonb; the length does not.
 */
export function jsonbTextLength(value: unknown): number {
  const s = JSON.stringify(value);
  let extra = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ":" || c === ",") extra += 1;
  }
  return Buffer.byteLength(s, "utf8") + extra;
}

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
  | {
      ok: true;
      report: PilotReport | PilotReportV2;
      /** Set only when `report` is schema 2: the same report as schema 1 (the 22023 fallback). */
      schema1?: PilotReport;
      /** Set only when signals were given and left out: a fixed name, never a value. */
      signalsLeftOut?: string;
    }
  /** `reason` names a field path or "too large", never a value. */
  | { ok: false; reason: string };

/** Without signals: exactly the BACKLOG-4219 result. */
export type BuildSchema1Result = { ok: true; report: PilotReport } | { ok: false; reason: string };

function gateCounts(v: SignalValueScore): z.infer<typeof SignalGate> {
  const g = v.gate;
  return {
    true_kept: g.trueKept,
    true_lost: g.trueLost,
    known_wrong_dropped: g.knownWrongDropped,
    known_wrong_total: g.knownWrongTotal,
    cleanup_no_dropped: g.cleanupNoDropped,
    cleanup_no_total: g.cleanupNoTotal,
    cleanup_yes_lost: g.cleanupYesLost,
    cleanup_yes_total: g.cleanupYesTotal,
    unmeasured: g.unmeasured,
  };
}

function coverageCounts(c: SignalScore["textCoverage"]["newsletter"]) {
  return { emails: c.emails, with_attachments: c.withAttachments, with_attachment_text: c.withAttachmentText };
}

/**
 * The signals block, field by field, or the reason it cannot be built (a fixed
 * name). An unknown signals_version is refused by the schema's literal (R3). The value list must be exactly PILOT_SIGNAL_VALUE_NAMES; the baseline
 * is per family (every value of a family measures the same newsletter mail).
 */
export function buildPilotSignals(s: SignalScore): { ok: true; signals: unknown } | { ok: false; reason: string } {
  if (!s.complete) return { ok: false, reason: "incomplete" };
  const byId = new Map<string, SignalValueScore>();
  for (const v of s.values) byId.set(v.id, v);
  const expected = PILOT_SIGNAL_FAMILIES.reduce((n, f) => n + PILOT_SIGNAL_VALUE_NAMES[f].length, 0);
  if (s.values.length !== expected || byId.size !== expected) return { ok: false, reason: "values" };
  const baseline = {} as Record<PilotSignalFamily, { k: number; n: number }>;
  const values = {} as Record<PilotSignalFamily, Record<string, unknown>>;
  for (const fam of PILOT_SIGNAL_FAMILIES) {
    const out: Record<string, unknown> = {};
    let base: { k: number; n: number } | null = null;
    for (const name of PILOT_SIGNAL_VALUE_NAMES[fam]) {
      const v = byId.get(`${fam}.${name}`);
      if (!v || v.family !== fam) return { ok: false, reason: `values.${fam}` };
      const b = kn(v.newsletterBaseline);
      if (base === null) base = b;
      else if (base.k !== b.k || base.n !== b.n) return { ok: false, reason: `baseline.${fam}` };
      out[name] = { newsletter: kn(v.newsletter), positives: kn(v.positives), gate: gateCounts(v) };
    }
    baseline[fam] = base as { k: number; n: number };
    values[fam] = out;
  }
  return {
    ok: true,
    signals: {
      signals_version: s.signalsVersion,
      terms_version: s.termsVersion,
      deal_linked_capped: s.sampled.dealLinkedCapped,
      detection_capped: s.sampled.detectionCapped,
      emails: {
        newsletter: s.emails.newsletter,
        real_estate_sample: s.emails.realEstateSample,
        deal_linked: s.emails.dealLinked,
        content_positives: s.emails.contentPositives,
        true_detection: s.emails.trueDetection,
        gate: s.emails.gate,
        body_truncated: s.emails.bodyTruncated,
      },
      text_coverage: {
        newsletter: coverageCounts(s.textCoverage.newsletter),
        content_positives: coverageCounts(s.textCoverage.contentPositives),
        true_detection: coverageCounts(s.textCoverage.trueDetection),
      },
      baseline,
      values,
    },
  };
}

/**
 * BACKLOG-4245: `x.y.z-pre` / `x.y.z+build` -> `x.y.z`. Anything else is
 * returned unchanged (and the schema decides).
 */
export function pilotAppVersion(appVersion: string): string {
  const m = /^([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6})[-+][0-9A-Za-z.+-]+$/.exec(appVersion);
  return m ? m[1] : appVersion;
}

/**
 * The report for one score. `detector` = the census on the detector surface
 * (scoreRunWithDetector). Returns ok:false (nothing to send) when the result
 * would not pass the server's schema.
 */
export function buildPilotReport<S extends SignalScore | null | undefined = undefined>(
  score: LearnScore,
  detector: SenderCensus,
  appVersion: string,
  signals?: S,
): BuildPilotReportResultFor<S> {
  return buildPilotReportWithSignals(score, detector, appVersion, signals ?? null) as BuildPilotReportResultFor<S>;
}

/**
 * Without a signals argument the result is exactly the BACKLOG-4219 one. One
 * signature, not overloads: the write-atomicity guard keys units `file::name`.
 */
export type BuildPilotReportResultFor<S> = [S] extends [undefined] ? BuildSchema1Result : BuildPilotReportResult;

function buildPilotReportWithSignals(
  score: LearnScore,
  detector: SenderCensus,
  appVersion: string,
  signals: SignalScore | null,
): BuildPilotReportResult {
  const v1 = buildSchema1(score, detector, appVersion);
  if (!v1.ok || signals === null) return v1;
  const block = buildPilotSignals(signals);
  if (!block.ok) return { ...v1, signalsLeftOut: block.reason };
  const parsed = PilotReportV2Schema.safeParse({ ...v1.report, schema: PILOT_REPORT_SCHEMA_V2, signals: block.signals });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ...v1, signalsLeftOut: first ? first.path.map(String).join(".") || first.code : "invalid" };
  }
  // The server caps schema 2 at 65,536 and the report without `signals` at 32,768 (jsonb text).
  if (jsonbTextLength(parsed.data) > PILOT_MAX_BYTES_V2 || jsonbTextLength(v1.report) > PILOT_MAX_BYTES) {
    return { ...v1, signalsLeftOut: "too large" };
  }
  return { ok: true, report: parsed.data, schema1: v1.report };
}

/** The schema-1 report (BACKLOG-4219), unchanged. */
function buildSchema1(score: LearnScore, detector: SenderCensus, appVersion: string): BuildSchema1Result {
  const candidate = {
    schema: PILOT_REPORT_SCHEMA_VERSION,
    app_version: pilotAppVersion(appVersion),
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
