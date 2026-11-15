/**
 * Per-email deal signals, measured in Learn — BACKLOG-4257 (M3) PR2.
 *
 * SHADOW ONLY. Nothing here changes what the detector keeps or drops, what
 * Learn asks, or what the pilot report sends. `scoreSignals` runs in its own
 * channel (learn:signals), never inside learn:score, and returns its own
 * record (`SignalScore`), never part of the score (SR R8). The pilot report
 * never sees it (D3).
 *
 * For every signal value (SIGNAL_VALUES), on the email sets below:
 *   newsletter   fires on answered newsletter/spam sample mail (k/n, Wilson)
 *   baseline     the old rules (analyzeEmail) flag the SAME newsletter mail
 *   positives    fires on deal mail:
 *                  content families (anchor, stage, filename, forms) — answered
 *                  real-estate sample mail + mail linked to non-rejected deals;
 *                  sender family — mail of TRUE detections only. Deal-linked
 *                  mail is linked by contact, so its sender tier is circular
 *                  (plan C6).
 *   gate         a detection is kept when any of its emails fires: true
 *                kept/lost, known-wrong dropped, cleanup No dropped, cleanup
 *                Yes lost (cleanup per deal key).
 * Form signals count only emails with attachment text, and file-name signals
 * only emails with attachments; text coverage is reported per group (SR R6).
 *
 * Keep bar (KEEP_BAR; SR should-fix): enough data on both sides (minimum n),
 * the newsletter rate's Wilson upper bound below the baseline's point estimate
 * on the same emails, a minimum fire rate on deal mail, and at most one true
 * detection lost in twenty. Otherwise "not enough data" or "fails".
 *
 * Cost (SR R4): one pass per learn:signals call (after the score is shown), in
 * memory, pages of at most 200 with a yield between pages, capped emails, and
 * a time limit. An email cap makes the pass a SAMPLE: verdicts are computed
 * over the sampled mail and the cap is reported. Only the time stop makes the
 * pass incomplete (every verdict "not enough data").
 *
 * Privacy: the record holds counts, rates and closed ids only. Address keys
 * the extractor returns are dropped here. The caller's context carries the
 * rule set, the deal-contact keep sets and the vendor-role domains, nothing
 * else.
 *
 * Pure apart from `analyzeEmail` and the injected loaders.
 */
import transactionExtractorService from "../transactionExtractorService";
import type { DealAnswerRow, AnswerKeyRow } from "../db/learnModeDbService";
import type { BulkSignalRow, SignalAttachmentRow, SignalEmailRow } from "../db/learnSignalsDb";
import { extractEmailSignals } from "../detectSignals/extractSignals";
import { SIGNAL_TERMS_VERSION } from "../detectSignals/signalTerms";
import {
  EMAIL_SIGNALS_VERSION,
  type EmailSignals,
  type FilenameClass,
  type SenderTier,
  type SignalContext,
  type AnchorPlacement,
} from "../detectSignals/types";
import type { FormKind } from "../formRecognition/formRegistryTypes";
import type { LearnRunResult } from "./baselineRunner";
import { classifyDetections, type Rate } from "./scoring";
import { wilsonInterval } from "./wilson";
import type { SenderRuleSet } from "../../utils/senderFilter/bundledRules";
import { fromAddress } from "../../utils/senderFilter/senderFilter";
import { hostMatchesAny, hostOf } from "../../utils/senderFilter/hostMatch";

/** The longest one signal pass may run before it stops and reports a partial result. */
export const SIGNAL_SCORE_TIME_LIMIT_MS = 20_000;
/** At most this many deal-linked messages are read per pass. */
export const MAX_DEAL_LINKED_SIGNAL_EMAILS = 5_000;
/** At most this many detection messages (true, known wrong, cleanup-answered) are read per pass. */
export const MAX_DETECTION_SIGNAL_EMAILS = 5_000;
/** Page / chunk size (SR R4: <= 200). */
export const SIGNAL_PASS_PAGE = 200;

export const KEEP_BAR = {
  /** Minimum measurable emails on each side (newsletter, positives). */
  minN: 30,
  /** Minimum measurable true detections for the gate. */
  minTrueDetections: 20,
  /** Minimum fire rate on deal mail (positives), as a fraction. */
  minPositiveFireRate: 0.2,
  /** At most `lostPer` true detections lost per `perTrue`. */
  lostPer: 1,
  perTrue: 20,
} as const;

export type SignalFamily = "anchor" | "stage" | "sender" | "filename" | "forms";

const PLACEMENTS: readonly AnchorPlacement[] = ["subject", "bodyTop", "bodyMid", "afterSignature", "footer", "none"];
const STAGES = ["offer", "counter", "underContract", "inspection", "appraisal", "closing"] as const;
const TIERS: readonly SenderTier[] = ["dealContact", "vendorRoleDomain", "dealContactDomain", "platform", "freeMail", "other"];
const FILENAME_CLASSES: readonly Exclude<FilenameClass, "none">[] = [
  "purchaseAgreement",
  "counteroffer",
  "addendum",
  "inspection",
  "appraisal",
  "closing",
  "disclosure",
  "listing",
  "other",
];
const FORM_KINDS: readonly FormKind[] = [
  "purchase_agreement",
  "buyer_agreement",
  "listing_agreement",
  "counteroffer",
  "representation_termination",
  "other",
];

interface SignalValueDef {
  id: string;
  family: SignalFamily;
  fires: (s: EmailSignals) => boolean;
}

/** Every measured signal value, in report order. Ids are closed and carry no mail content. */
export const SIGNAL_VALUES: readonly SignalValueDef[] = [
  ...PLACEMENTS.map((p) => ({ id: `anchor.${p}`, family: "anchor" as const, fires: (s: EmailSignals) => s.anchor.placement === p })),
  { id: "anchor.nearFooterCue", family: "anchor", fires: (s) => s.anchor.nearFooterCue },
  { id: "anchor.inQuoteOnly", family: "anchor", fires: (s) => s.anchor.inQuoteOnly },
  ...STAGES.map((k) => ({ id: `stage.${k}`, family: "stage" as const, fires: (s: EmailSignals) => s.stage[k] })),
  { id: "stage.any", family: "stage", fires: (s) => STAGES.some((k) => s.stage[k]) },
  { id: "stage.inSubject", family: "stage", fires: (s) => s.stage.inSubject },
  ...TIERS.map((t) => ({ id: `sender.${t}`, family: "sender" as const, fires: (s: EmailSignals) => s.sender.tier === t })),
  { id: "sender.recipientIsDealContact", family: "sender", fires: (s) => s.sender.recipientIsDealContact },
  { id: "sender.bulk", family: "sender", fires: (s) => s.sender.bulk },
  ...FILENAME_CLASSES.map((c) => ({
    id: `filename.${c}`,
    family: "filename" as const,
    fires: (s: EmailSignals) => s.forms.filenameClass === c,
  })),
  { id: "forms.anyMatch", family: "forms", fires: (s) => s.forms.matches.length > 0 },
  ...FORM_KINDS.map((k) => ({
    id: `forms.${k}`,
    family: "forms" as const,
    fires: (s: EmailSignals) => s.forms.matches.some((m) => m.kind === k),
  })),
];

/** An email can be measured for this family (SR R6: forms only with text). */
function measurable(family: SignalFamily, s: EmailSignals): boolean {
  if (family === "forms") return s.forms.attachmentsWithText > 0;
  if (family === "filename") return s.forms.attachments > 0;
  return true;
}

export type KeepVerdict = "passes" | "fails" | "not_enough_data";
export type KeepReason =
  | "incomplete"
  | "newsletter_n"
  | "positive_n"
  | "true_detections_n"
  | "positive_fire_rate"
  | "newsletter_rate"
  | "true_lost";

export interface SignalGate {
  trueKept: number;
  trueLost: number;
  knownWrongDropped: number;
  knownWrongTotal: number;
  /** Per deal key. */
  cleanupNoDropped: number;
  cleanupNoTotal: number;
  cleanupYesLost: number;
  cleanupYesTotal: number;
  /** Detections with no loaded email measurable for this family (left out above). */
  unmeasured: number;
}

export interface SignalValueScore {
  id: string;
  family: SignalFamily;
  newsletter: Rate;
  /** The old rules on the same newsletter emails as `newsletter`. */
  newsletterBaseline: Rate;
  positives: Rate;
  gate: SignalGate;
  verdict: KeepVerdict;
  reasons: KeepReason[];
}

export interface TextCoverage {
  emails: number;
  withAttachments: number;
  withAttachmentText: number;
}

export interface SignalScore {
  signalsVersion: number;
  termsVersion: number;
  /** False only when the pass stopped at the time limit. */
  complete: boolean;
  stoppedBy: "time" | null;
  timeLimitMs: number;
  /** An email cap was reached and more mail exists: the counts are a sample. */
  sampled: { dealLinkedCapped: boolean; detectionCapped: boolean; dealLinkedCap: number; detectionCap: number };
  emails: {
    newsletter: number;
    realEstateSample: number;
    dealLinked: number;
    /** Distinct content positives (real-estate sample + deal-linked). */
    contentPositives: number;
    trueDetection: number;
    gate: number;
    /** Emails whose body was cut before extraction. */
    bodyTruncated: number;
  };
  /** SR R6: attachment text coverage per group. */
  textCoverage: { newsletter: TextCoverage; contentPositives: TextCoverage; trueDetection: TextCoverage };
  values: SignalValueScore[];
}

/** Reads the pass needs; the handler passes the learnSignalsDb functions bound to the user. */
export interface SignalLoaders {
  bulkRows: () => BulkSignalRow[];
  dealLinkedPage: (afterId: string, limit: number) => SignalEmailRow[];
  emailsByIds: (ids: readonly string[]) => SignalEmailRow[];
  attachmentsByEmailIds: (ids: readonly string[]) => Map<string, SignalAttachmentRow[]>;
}

export interface ScoreSignalsInput {
  run: LearnRunResult;
  keyRows: AnswerKeyRow[];
  dealAnswers: DealAnswerRow[];
  ctx: SignalContext;
  loaders: SignalLoaders;
  nowMs?: () => number;
  yieldFn?: () => Promise<void>;
  timeLimitMs?: number;
}

/** Lowercased non-free-mail hosts of vendor-role contact emails (founder D1: per user). */
export function vendorRoleDomains(emails: Iterable<string | null | undefined>, rules: SenderRuleSet): Set<string> {
  const out = new Set<string>();
  for (const raw of emails) {
    const a = fromAddress(raw);
    const host = a ? hostOf(a) : null;
    if (host && !hostMatchesAny(host, rules.freeMailDomains)) out.add(host);
  }
  return out;
}

function rate(k: number, n: number): Rate {
  return { k, n, interval: wilsonInterval(k, n) };
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Measured {
  signals: EmailSignals;
  truncated: boolean;
}

function coverage(list: readonly Measured[]): TextCoverage {
  return {
    emails: list.length,
    withAttachments: list.filter((m) => m.signals.forms.attachments > 0).length,
    withAttachmentText: list.filter((m) => m.signals.forms.attachmentsWithText > 0).length,
  };
}

/** One signal pass over the user's Learn data. See the file header. */
export async function scoreSignals(input: ScoreSignalsInput): Promise<SignalScore> {
  const nowMs = input.nowMs ?? Date.now;
  const yieldFn = input.yieldFn ?? defaultYield;
  const timeLimitMs = input.timeLimitMs ?? SIGNAL_SCORE_TIME_LIMIT_MS;
  const started = nowMs();
  let stoppedBy: "time" | null = null;
  let dealLinkedCapped = false;
  let detectionCapped = false;
  const outOfTime = () => {
    if (stoppedBy === null && nowMs() - started > timeLimitMs) stoppedBy = "time";
    return stoppedBy !== null;
  };

  const { ctx, loaders } = input;
  const byId = new Map<string, Measured>();
  const measure = (rows: readonly SignalEmailRow[]): void => {
    const fresh = rows.filter((r) => !byId.has(r.id));
    if (fresh.length === 0) return;
    const atts = loaders.attachmentsByEmailIds(fresh.map((r) => r.id));
    for (const r of fresh) {
      const x = extractEmailSignals(
        {
          subject: r.subject,
          bodyHtml: r.body_html,
          bodyPlain: r.body_plain,
          sender: r.sender,
          recipients: r.recipients,
          bulkMailHeaders: r.bulk_mail_headers,
          attachments: (atts.get(r.id) ?? []).map((a) => ({ filename: a.filename, textContent: a.text_content })),
        },
        ctx,
      );
      byId.set(r.id, { signals: x.signals, truncated: x.bodyTruncated });
    }
  };

  // 1. The answered sample (about 200 rows): newsletter/spam and real estate.
  const bulk = loaders.bulkRows().filter((b): b is BulkSignalRow & { id: string } => b.id !== null);
  const newsletterIds: string[] = [];
  const newsletterFlagged = new Set<string>();
  const realEstateIds = new Set<string>();
  for (let i = 0; i < bulk.length; i += SIGNAL_PASS_PAGE) {
    if (outOfTime()) break;
    const page = bulk.slice(i, i + SIGNAL_PASS_PAGE);
    measure(page);
    for (const b of page) {
      if (b.answer === "newsletter_spam") {
        if (newsletterIds.includes(b.id)) continue;
        newsletterIds.push(b.id);
        const flagged = transactionExtractorService.analyzeEmail({
          subject: b.subject ?? undefined,
          body: b.body_html ?? undefined,
          bodyPlain: b.body_plain ?? undefined,
          date: "",
        }).isRealEstateRelated;
        if (flagged) newsletterFlagged.add(b.id);
      } else {
        realEstateIds.add(b.id);
      }
    }
    await yieldFn();
  }

  // 2. Detection mail: true detections first (sender positives), then the gate's other classes.
  const classified = classifyDetections(input.run, input.keyRows, input.dealAnswers);
  const gateDetections = classified.filter(
    (c) => c.cls === "true" || c.cls === "knownWrong" || (c.cls === "unmatched" && c.answer !== null),
  );
  const ordered = [...gateDetections.filter((c) => c.cls === "true"), ...gateDetections.filter((c) => c.cls !== "true")];
  const detectionIds: string[] = [];
  const seenDet = new Set<string>();
  for (const c of ordered) {
    for (const id of c.detection.emailIds) {
      if (seenDet.has(id)) continue;
      seenDet.add(id);
      detectionIds.push(id);
    }
  }
  let detectionBudget = detectionIds;
  if (detectionIds.length > MAX_DETECTION_SIGNAL_EMAILS) {
    detectionBudget = detectionIds.slice(0, MAX_DETECTION_SIGNAL_EMAILS);
    detectionCapped = true;
  }
  for (let i = 0; i < detectionBudget.length; i += SIGNAL_PASS_PAGE) {
    if (outOfTime()) break;
    measure(loaders.emailsByIds(detectionBudget.slice(i, i + SIGNAL_PASS_PAGE)));
    await yieldFn();
  }

  // 3. Deal-linked mail, keyset pages (SR R4/R5: the loader keeps non-rejected deals only).
  const dealLinkedIds = new Set<string>();
  let cursor = "";
  while (!outOfTime()) {
    const room = MAX_DEAL_LINKED_SIGNAL_EMAILS - dealLinkedIds.size;
    if (room <= 0) {
      // Capped only if a row exists past the cap (exactly the cap = all of it).
      dealLinkedCapped = loaders.dealLinkedPage(cursor, 1).length > 0;
      break;
    }
    const limit = Math.min(SIGNAL_PASS_PAGE, room);
    const page = loaders.dealLinkedPage(cursor, limit);
    if (page.length === 0) break;
    measure(page);
    for (const r of page) dealLinkedIds.add(r.id);
    cursor = page[page.length - 1].id;
    await yieldFn();
    if (page.length < limit) break;
  }

  const get = (id: string): Measured | undefined => byId.get(id);
  const list = (ids: Iterable<string>): Measured[] => {
    const out: Measured[] = [];
    for (const id of ids) {
      const m = get(id);
      if (m) out.push(m);
    }
    return out;
  };

  const newsletter = list(newsletterIds);
  const contentPositiveIds = new Set<string>([...realEstateIds, ...dealLinkedIds]);
  const contentPositives = list(contentPositiveIds);
  const trueDetectionIds = new Set<string>();
  for (const c of classified) if (c.cls === "true") for (const id of c.detection.emailIds) trueDetectionIds.add(id);
  // C6: sender positives come from TRUE detections only, never from deal-linked mail.
  const senderPositives = list(trueDetectionIds);

  const complete = stoppedBy === null;
  const values = SIGNAL_VALUES.map((def) =>
    scoreValue(def, {
      newsletter: newsletterIds.filter((id) => get(id)).map((id) => ({ m: get(id) as Measured, flagged: newsletterFlagged.has(id) })),
      positives: def.family === "sender" ? senderPositives : contentPositives,
      gateDetections,
      get,
      complete,
    }),
  );

  return {
    signalsVersion: EMAIL_SIGNALS_VERSION,
    termsVersion: SIGNAL_TERMS_VERSION,
    complete,
    stoppedBy,
    timeLimitMs,
    sampled: {
      dealLinkedCapped,
      detectionCapped,
      dealLinkedCap: MAX_DEAL_LINKED_SIGNAL_EMAILS,
      detectionCap: MAX_DETECTION_SIGNAL_EMAILS,
    },
    emails: {
      newsletter: newsletter.length,
      realEstateSample: list(realEstateIds).length,
      dealLinked: list(dealLinkedIds).length,
      contentPositives: contentPositives.length,
      trueDetection: senderPositives.length,
      gate: list(seenDet).length,
      bodyTruncated: [...byId.values()].filter((m) => m.truncated).length,
    },
    textCoverage: {
      newsletter: coverage(newsletter),
      contentPositives: coverage(contentPositives),
      trueDetection: coverage(senderPositives),
    },
    values,
  };
}

interface ValueInputs {
  newsletter: Array<{ m: Measured; flagged: boolean }>;
  positives: Measured[];
  gateDetections: ReturnType<typeof classifyDetections>;
  get: (id: string) => Measured | undefined;
  complete: boolean;
}

function scoreValue(def: SignalValueDef, inp: ValueInputs): SignalValueScore {
  const nl = inp.newsletter.filter((x) => measurable(def.family, x.m.signals));
  const nlFires = nl.filter((x) => def.fires(x.m.signals)).length;
  const nlFlagged = nl.filter((x) => x.flagged).length;
  const pos = inp.positives.filter((m) => measurable(def.family, m.signals));
  const posFires = pos.filter((m) => def.fires(m.signals)).length;

  const gate: SignalGate = {
    trueKept: 0,
    trueLost: 0,
    knownWrongDropped: 0,
    knownWrongTotal: 0,
    cleanupNoDropped: 0,
    cleanupNoTotal: 0,
    cleanupYesLost: 0,
    cleanupYesTotal: 0,
    unmeasured: 0,
  };
  // Cleanup answers are per deal key: a key is kept when any of its detections is kept.
  const keyKept = new Map<string, { answer: "yes" | "no"; kept: boolean }>();
  for (const c of inp.gateDetections) {
    const mail = c.detection.emailIds.map(inp.get).filter((m): m is Measured => m !== undefined);
    const usable = mail.filter((m) => measurable(def.family, m.signals));
    if (usable.length === 0) {
      gate.unmeasured += 1;
      continue;
    }
    const kept = usable.some((m) => def.fires(m.signals));
    if (c.cls === "true") {
      if (kept) gate.trueKept += 1;
      else gate.trueLost += 1;
    } else if (c.cls === "knownWrong") {
      gate.knownWrongTotal += 1;
      if (!kept) gate.knownWrongDropped += 1;
    } else if (c.answer !== null && c.detection.addressKey) {
      const prev = keyKept.get(c.detection.addressKey);
      keyKept.set(c.detection.addressKey, { answer: c.answer, kept: (prev?.kept ?? false) || kept });
    }
  }
  for (const { answer, kept } of keyKept.values()) {
    if (answer === "yes") {
      gate.cleanupYesTotal += 1;
      if (!kept) gate.cleanupYesLost += 1;
    } else {
      gate.cleanupNoTotal += 1;
      if (!kept) gate.cleanupNoDropped += 1;
    }
  }

  const newsletter = rate(nlFires, nl.length);
  const newsletterBaseline = rate(nlFlagged, nl.length);
  const positives = rate(posFires, pos.length);
  const { verdict, reasons } = keepBar(newsletter, newsletterBaseline, positives, gate, inp.complete);
  return { id: def.id, family: def.family, newsletter, newsletterBaseline, positives, gate, verdict, reasons };
}

/** The keep bar (see KEEP_BAR and the file header). */
export function keepBar(
  newsletter: Rate,
  baseline: Rate,
  positives: Rate,
  gate: SignalGate,
  complete: boolean,
): { verdict: KeepVerdict; reasons: KeepReason[] } {
  const trueMeasured = gate.trueKept + gate.trueLost;
  const missing: KeepReason[] = [];
  if (!complete) missing.push("incomplete");
  if (newsletter.n < KEEP_BAR.minN) missing.push("newsletter_n");
  if (positives.n < KEEP_BAR.minN) missing.push("positive_n");
  if (trueMeasured < KEEP_BAR.minTrueDetections) missing.push("true_detections_n");
  if (missing.length > 0) return { verdict: "not_enough_data", reasons: missing };

  const failed: KeepReason[] = [];
  if (positives.k < KEEP_BAR.minPositiveFireRate * positives.n) failed.push("positive_fire_rate");
  if (!newsletter.interval || !baseline.interval || !(newsletter.interval.high < baseline.interval.rate)) {
    failed.push("newsletter_rate");
  }
  if (gate.trueLost * KEEP_BAR.perTrue > KEEP_BAR.lostPer * trueMeasured) failed.push("true_lost");
  return failed.length > 0 ? { verdict: "fails", reasons: failed } : { verdict: "passes", reasons: [] };
}

function fmtRate(r: Rate): string {
  return r.interval ? `${r.k}/${r.n} (${r.interval.rate}%, CI ${r.interval.low}-${r.interval.high}%)` : `${r.k}/${r.n}`;
}

function fmtCoverage(c: TextCoverage): string {
  return `${c.withAttachmentText}/${c.emails} with attachment text (${c.withAttachments} with attachments)`;
}

const VERDICT_TEXT: Readonly<Record<KeepVerdict, string>> = {
  passes: "passes",
  fails: "fails",
  not_enough_data: "not enough data",
};

/** Copy-block lines: counts and closed ids only (no addresses, subjects, senders or file names). */
export function formatSignalLines(s: SignalScore | null): string[] {
  if (!s) return ["Signals (measured only): not available"];
  const stop = s.complete ? "complete" : `stopped early (time limit ${s.timeLimitMs} ms)`;
  const caps = [
    s.sampled.dealLinkedCapped ? `deal-linked mail capped at ${s.sampled.dealLinkedCap}` : null,
    s.sampled.detectionCapped ? `detection mail capped at ${s.sampled.detectionCap}` : null,
  ].filter((x): x is string => x !== null);
  const sample = caps.length ? `; sample: ${caps.join(", ")}` : "";
  return [
    `Signals (measured only; signals v${s.signalsVersion}, terms v${s.termsVersion}; ${stop}${sample})`,
    `Signal emails: newsletter/spam ${s.emails.newsletter}; deal mail ${s.emails.contentPositives} (real estate sample ${s.emails.realEstateSample}, deal-linked ${s.emails.dealLinked}); true-detection mail ${s.emails.trueDetection}; gate mail ${s.emails.gate}; bodies cut ${s.emails.bodyTruncated}`,
    `Signal text coverage: newsletter/spam ${fmtCoverage(s.textCoverage.newsletter)}; deal mail ${fmtCoverage(s.textCoverage.contentPositives)}; true-detection mail ${fmtCoverage(s.textCoverage.trueDetection)}`,
    ...s.values.map((v) => {
      const g = v.gate;
      const why = v.reasons.length ? ` (${v.reasons.join(", ")})` : "";
      return `Signal ${v.id}: newsletter ${fmtRate(v.newsletter)} vs old rules ${fmtRate(v.newsletterBaseline)}; ${v.family === "sender" ? "true-detection mail" : "deal mail"} ${fmtRate(v.positives)}; gate true kept ${g.trueKept} lost ${g.trueLost}, known wrong dropped ${g.knownWrongDropped}/${g.knownWrongTotal}, cleanup No dropped ${g.cleanupNoDropped}/${g.cleanupNoTotal}, cleanup Yes lost ${g.cleanupYesLost}/${g.cleanupYesTotal}, unmeasured ${g.unmeasured}; keep bar ${VERDICT_TEXT[v.verdict]}${why}`;
    }),
  ];
}
