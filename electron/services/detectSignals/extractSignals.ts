/**
 * Per-email deal signal extraction — BACKLOG-4257 (M3), PR1.
 *
 * extractEmailSignals(input, ctx) reads one message and returns
 * `EmailSignals` (counts, booleans, closed enums) plus the address keys it
 * found, held apart from the record. Shadow measurement only: nothing here
 * changes what the detector keeps or drops.
 *
 * Pure: no database, no logging, no I/O. Imports only pure modules.
 */
import { addressCandidates } from "../transactionExtractorService";
import { addressKey } from "../learn/dealMatcher";
import { matchForms } from "../formRecognition/formMatcher";
import { parseEmailAddressList } from "../../utils/emailAddress";
import { fromAddress } from "../../utils/senderFilter/senderFilter";
import { hostMatchesAny, hostOf } from "../../utils/senderFilter/hostMatch";
import { canonicalizeEmail, type CanonicalEmail } from "./canonicalText";
import {
  BODY_TOP_FRACTION,
  BODY_TOP_MIN_LINES,
  FILENAME_CLASSES,
  FOOTER_CUES,
  FOOTER_CUE_WINDOW,
  FOOTER_FRACTION,
  FOOTER_MIN_BODY_LINES,
  FOOTER_MIN_LINES,
  SIGNATURE_SEPARATOR_LINES,
  SIGN_OFF_LINES,
  STAGE_TERMS,
  type StageName,
} from "./signalTerms";
import { hasAnyWholeWord } from "./wholeWord";
import {
  EMAIL_SIGNALS_VERSION,
  type AnchorPlacement,
  type AnchorSignals,
  type EmailSignalInput,
  type ExtractedSignals,
  type FilenameClass,
  type FormSignalMatch,
  type FormSignals,
  type SenderSignals,
  type SenderTier,
  type SignalContext,
  type StageSignals,
} from "./types";

/** Characters of attachment text passed to the form matcher, per attachment. */
export const MAX_ATTACHMENT_TEXT_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Anchor (address) placement
// ---------------------------------------------------------------------------

type BodyRegion = Exclude<AnchorPlacement, "subject" | "none">;

const PLACEMENT_RANK: Readonly<Record<AnchorPlacement, number>> = {
  subject: 5,
  bodyTop: 4,
  bodyMid: 3,
  afterSignature: 2,
  footer: 1,
  none: 0,
};

const SIGN_OFF_RE = /^(.*?)[,!.]?$/;

/** Index of the first line of the signature block, or -1. */
function signatureStart(lines: readonly string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (SIGNATURE_SEPARATOR_LINES.includes(lines[i])) return i;
  }
  for (let i = lines.length - 1; i >= 1; i--) {
    const m = SIGN_OFF_RE.exec(lines[i]);
    if (m && SIGN_OFF_LINES.includes(m[1].trim())) return i;
  }
  return -1;
}

/** The body region each own-text line belongs to, by its position. */
function regionsOf(lines: readonly string[]): BodyRegion[] {
  const n = lines.length;
  const sig = signatureStart(lines);
  const topEnd = Math.max(BODY_TOP_MIN_LINES, Math.ceil(n * BODY_TOP_FRACTION));
  const footerStart =
    n >= FOOTER_MIN_BODY_LINES ? n - Math.max(FOOTER_MIN_LINES, Math.ceil(n * FOOTER_FRACTION)) : n;
  return lines.map((_, i) => {
    if (sig >= 0 && i > sig) return "afterSignature";
    if (i >= footerStart && i >= topEnd) return "footer";
    if (i < topEnd) return "bodyTop";
    return "bodyMid";
  });
}

/** Accepted address candidates in `text`: the shown string and its key. */
function acceptedAddresses(text: string): Array<{ shown: string; key: string }> {
  const out: Array<{ shown: string; key: string }> = [];
  for (const c of addressCandidates(text)) {
    if (c.reason !== null) continue;
    out.push({ shown: c.shown, key: addressKey(c.shown) ?? c.shown });
  }
  return out;
}

/** "123 maple" from "123 maple ave, springfield ..." — locates the street line. */
function streetHead(shown: string): string {
  return shown.split(/[ ,]+/).slice(0, 2).join(" ");
}

function anchorSignals(c: CanonicalEmail): { anchor: AnchorSignals; keys: string[] } {
  const keys = new Set<string>();
  let placement: AnchorPlacement = "none";
  const hitLines: number[] = [];

  const consider = (p: AnchorPlacement) => {
    if (PLACEMENT_RANK[p] > PLACEMENT_RANK[placement]) placement = p;
  };

  for (const a of acceptedAddresses(c.subject)) {
    keys.add(a.key);
    consider("subject");
  }

  // Each region is a run of consecutive lines; candidates are found per run
  // so a street line and its city line on the next line still join.
  const regions = regionsOf(c.ownLines);
  let start = 0;
  while (start < c.ownLines.length) {
    let end = start;
    while (end + 1 < c.ownLines.length && regions[end + 1] === regions[start]) end++;
    const runLines = c.ownLines.slice(start, end + 1);
    for (const a of acceptedAddresses(runLines.join("\n"))) {
      keys.add(a.key);
      consider(regions[start]);
      const head = streetHead(a.shown);
      runLines.forEach((l, j) => {
        if (l.includes(head)) hitLines.push(start + j);
      });
    }
    start = end + 1;
  }

  let nearFooterCue = false;
  if (hitLines.length > 0) {
    const cueLines: number[] = [];
    c.ownLines.forEach((l, i) => {
      if (hasAnyWholeWord(l, FOOTER_CUES)) cueLines.push(i);
    });
    nearFooterCue = hitLines.some((h) => cueLines.some((q) => Math.abs(q - h) <= FOOTER_CUE_WINDOW));
  }

  const inQuoteOnly = keys.size === 0 && acceptedAddresses(c.fullLines.join("\n")).length > 0;

  return { anchor: { count: keys.size, placement, nearFooterCue, inQuoteOnly }, keys: [...keys] };
}

// ---------------------------------------------------------------------------
// Stage terms
// ---------------------------------------------------------------------------

const STAGES: readonly StageName[] = ["offer", "counter", "underContract", "inspection", "appraisal", "closing"];

function stagesIn(text: string): Set<StageName> {
  const out = new Set<StageName>();
  for (const s of STAGES) if (hasAnyWholeWord(text, STAGE_TERMS[s])) out.add(s);
  return out;
}

function stageSignals(c: CanonicalEmail): StageSignals {
  const inSubject = stagesIn(c.subject);
  const inOwn = stagesIn(c.ownLines.join("\n"));
  const inFull = stagesIn(c.fullLines.join("\n"));
  const fired = (s: StageName) => inSubject.has(s) || inOwn.has(s);
  return {
    offer: fired("offer"),
    counter: fired("counter"),
    underContract: fired("underContract"),
    inspection: fired("inspection"),
    appraisal: fired("appraisal"),
    closing: fired("closing"),
    inSubject: inSubject.size > 0,
    ownTextOnly: [...inFull].every(fired),
  };
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/** `host` or one of its parent domains is in `set`. */
function hostInSet(host: string | null, set: ReadonlySet<string>): boolean {
  if (!host || set.size === 0) return false;
  for (let h = host; ; ) {
    if (set.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

function parseHeaders(v: EmailSignalInput["bulkMailHeaders"]): Record<string, unknown> | null {
  let o: unknown = v ?? null;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
}

function headerText(h: Record<string, unknown>, key: string): string | null {
  const v = h[key];
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Bulk-mail headers, by the rule set's suppress.bulkHeaders config — the same
 * three checks as the sender filter's S3, computed here because that check is
 * not exported and decide() reports only the first-precedence rule.
 */
function isBulk(input: EmailSignalInput, ctx: SignalContext): boolean {
  const h = parseHeaders(input.bulkMailHeaders);
  if (!h) return false;
  const cfg = ctx.rules.suppress.bulkHeaders;
  for (const key of cfg.anyKeyPresent) if (headerText(h, key) !== null) return true;
  const precedence = headerText(h, "precedence");
  if (precedence !== null && cfg.precedenceValues.includes(precedence)) return true;
  const auto = headerText(h, "auto_submitted");
  return cfg.autoSubmittedCounts && auto !== null && auto !== "no";
}

function senderTier(from: string | null, ctx: SignalContext): SenderTier {
  if (!from) return "other";
  const host = hostOf(from);
  if (ctx.keep.contactAddresses.has(from)) return "dealContact";
  if (hostInSet(host, ctx.vendorRoleDomains)) return "vendorRoleDomain";
  if (hostInSet(host, ctx.keep.contactDomains)) return "dealContactDomain";
  if (ctx.rules.keep.platformAddresses.includes(from) || hostMatchesAny(host, ctx.rules.keep.platformHosts)) {
    return "platform";
  }
  if (hostMatchesAny(host, ctx.rules.freeMailDomains)) return "freeMail";
  return "other";
}

function senderSignals(input: EmailSignalInput, ctx: SignalContext): SenderSignals {
  const from = fromAddress(input.sender);
  const recipients = parseEmailAddressList(input.recipients ?? null).addresses;
  return {
    tier: senderTier(from, ctx),
    recipientIsDealContact: recipients.some((a) => ctx.keep.contactAddresses.has(a.email_address)),
    bulk: isBulk(input, ctx),
  };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function filenameClassOf(filenames: readonly string[]): FilenameClass {
  if (filenames.length === 0) return "none";
  const tokenized = filenames.map((f) => f.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  for (const [cls, terms] of FILENAME_CLASSES) {
    if (tokenized.some((t) => hasAnyWholeWord(t, terms))) return cls;
  }
  return "other";
}

function formSignals(input: EmailSignalInput, ctx: SignalContext): FormSignals {
  const attachments = input.attachments ?? [];
  const byId = new Map<string, FormSignalMatch>();
  let attachmentsWithText = 0;
  for (const a of attachments) {
    const text = typeof a.textContent === "string" ? a.textContent : "";
    if (!text.trim()) continue;
    attachmentsWithText++;
    const capped = text.length > MAX_ATTACHMENT_TEXT_CHARS ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : text;
    for (const m of ctx.registry ? matchForms(capped, ctx.registry) : matchForms(capped)) {
      if (m.formId === null) continue;
      const prev = byId.get(m.formId);
      if (prev) prev.occurrences += m.occurrences;
      else byId.set(m.formId, { formId: m.formId, kind: m.kind ?? "other", occurrences: m.occurrences });
    }
  }
  const filenames = attachments
    .map((a) => (typeof a.filename === "string" ? a.filename : ""))
    .filter((f) => f.trim().length > 0);
  return {
    attachments: attachments.length,
    attachmentsWithText,
    matches: [...byId.values()],
    filenameClass: attachments.length === 0 ? "none" : filenameClassOf(filenames),
  };
}

// ---------------------------------------------------------------------------

/** Signals for one message, plus its address keys (in memory only). */
export function extractEmailSignals(input: EmailSignalInput, ctx: SignalContext): ExtractedSignals {
  const canonical = canonicalizeEmail(input);
  const { anchor, keys } = anchorSignals(canonical);
  return {
    signals: {
      v: EMAIL_SIGNALS_VERSION,
      anchor,
      stage: stageSignals(canonical),
      sender: senderSignals(input, ctx),
      forms: formSignals(input, ctx),
    },
    addressKeys: keys,
    bodyTruncated: canonical.truncated,
  };
}
