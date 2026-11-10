/**
 * Sender filter — BACKLOG-4175.
 *
 * Pure and worker-safe: the only import is the address-list parser. Decides
 * from the FROM address of a message only — never Reply-To, never another
 * participant, never the recipients, never the body.
 *
 * Precedence (`decide`). The census reports the first match below; the
 * OUTCOME (drop / hide) is the first match whose mode on the surface is
 * "live", so a measured signal never shields a later live one:
 *   S0  exact address (`suppress.exactAddresses`) — before every keep rule
 *   K1  the sender is a contact on one of the user's non-rejected deals
 *   K2  deal-platform host or address (`keep.platformHosts/platformAddresses`)
 *   K3  the sender's host is a non-free-mail domain of a K1 contact
 *   S1  approved host (`suppress.hosts`): the host or a true subdomain
 *   S2  local part (`suppress.localParts`), exact or prefix, literal strings
 *   S3  bulk headers (`suppress.bulkHeaders`)
 *   S4-S6  Gmail Promotions / Social / Updates labels, Gmail rows only
 * A signal whose mode is "off" on the surface is not evaluated. A keep rule
 * only counts when a later signal would have suppressed the message.
 *
 * Every value compared against lives in the rule set (bundledRules.ts or a
 * set validated by ruleSetSchema.ts). Nothing from rule data is compiled into
 * a RegExp. The Gmail label names below DEFINE signals S4-S6; they are not
 * tunable values.
 */
import { parseEmailAddressList } from "../emailAddress";
import type { SenderRuleModes, SenderRuleSet, SenderRuleSignal } from "./bundledRules";
import { hostMatchesAny, hostOf, localPartOf } from "./hostMatch";

export type SenderFilterSurface = keyof SenderRuleModes;

/**
 * The first parsed address of a stored `emails.sender` value, lowercased and
 * trimmed by the parser; null when nothing parses. Covers the raw Gmail
 * `From` header (`"Name" <addr>`) and the Outlook `Name <addr>` / bare form.
 */
export function fromAddress(sender: string | null | undefined): string | null {
  const first = parseEmailAddressList(sender).addresses[0];
  return first ? first.email_address : null;
}

/** True when the From address is exactly one of `suppress.exactAddresses`. */
export function matchesExactAddress(sender: string | null | undefined, rules: SenderRuleSet): boolean {
  const from = fromAddress(sender);
  return from !== null && rules.suppress.exactAddresses.includes(from);
}

/** Is a signal live (changes behaviour) on a surface? */
export function isSignalLive(rules: SenderRuleSet, signal: SenderRuleSignal, surface: SenderFilterSurface): boolean {
  return rules.modes[signal][surface] === "live";
}

// ---------------------------------------------------------------------------
// Full precedence (S0-S6, K1-K3)
// ---------------------------------------------------------------------------

export type SuppressRuleId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
export type KeepRuleId = "K1" | "K2" | "K3";

export const SIGNAL_OF_RULE: Readonly<Record<SuppressRuleId, SenderRuleSignal>> = {
  S0: "seedAddress",
  S1: "approvedHost",
  S2: "localPart",
  S3: "bulkHeaders",
  S4: "gmailPromotions",
  S5: "gmailSocial",
  S6: "gmailUpdates",
};

/** Gmail system labels that define signals S4-S6 (Gmail rows only). */
const GMAIL_CATEGORY_RULES: ReadonlyArray<[SuppressRuleId, string]> = [
  ["S4", "CATEGORY_PROMOTIONS"],
  ["S5", "CATEGORY_SOCIAL"],
  ["S6", "CATEGORY_UPDATES"],
];

/** Per-user keep sets: K1 contact addresses and K3 contact domains (free mail excluded). */
export interface KeepSets {
  contactAddresses: ReadonlySet<string>;
  contactDomains: ReadonlySet<string>;
}

export const NO_KEEP: KeepSets = { contactAddresses: new Set(), contactDomains: new Set() };

/**
 * K1 / K3 from the email addresses of contacts on the user's non-rejected
 * deals. Addresses are parsed and lowercased; a domain in `freeMailDomains`
 * (or a subdomain of one) never becomes a K3 domain.
 */
export function buildKeepSets(contactEmails: Iterable<string | null | undefined>, rules: SenderRuleSet): KeepSets {
  const contactAddresses = new Set<string>();
  const contactDomains = new Set<string>();
  for (const raw of contactEmails) {
    const a = fromAddress(raw);
    if (!a) continue;
    contactAddresses.add(a);
    const host = hostOf(a);
    if (host && !hostMatchesAny(host, rules.freeMailDomains)) contactDomains.add(host);
  }
  return { contactAddresses, contactDomains };
}

/** One message as the filter sees it. `labels` / `bulkMailHeaders` may be the stored JSON text. */
export interface FilterRow {
  sender: string | null | undefined;
  source?: string | null;
  labels?: string | readonly string[] | null;
  bulkMailHeaders?: string | Readonly<Record<string, unknown>> | null;
}

/** A stored `emails` row (snake_case columns) as the filter reads it. */
export function storedFilterRow(row: {
  sender: string | null;
  source: string | null;
  labels: string | null;
  bulk_mail_headers: string | null;
}): FilterRow {
  return { sender: row.sender, source: row.source, labels: row.labels, bulkMailHeaders: row.bulk_mail_headers };
}

export interface SenderDecision {
  outcome: "suppress" | "keep" | "pass";
  /** The suppress rule that matched (outcome suppress), or the keep rule that won (outcome keep). */
  rule: SuppressRuleId | KeepRuleId | null;
  /** The suppress signal: the first that matched, or the one a keep rule overrode. */
  signal: SenderRuleSignal | null;
  /** Outcome suppress AND some matching signal is live on this surface (`liveRule` is set). */
  live: boolean;
  /** The first matching suppress rule whose signal is live on this surface: the rule that drops the message. */
  liveRule: SuppressRuleId | null;
  /** S0 suppressed a sender that this keep rule would otherwise have kept. */
  keepConflict: KeepRuleId | null;
}

export interface DecideOptions {
  /** Leave out the contact-derived keep rules K1 and K3 (the census's "minus-K1"). */
  withoutContactKeeps?: boolean;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function labelsOf(row: FilterRow): string[] {
  const v = parseJson(row.labels ?? null);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function headersOf(row: FilterRow): Record<string, unknown> | null {
  const v = parseJson(row.bulkMailHeaders ?? null);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function headerText(h: Record<string, unknown>, key: string): string | null {
  const v = h[key];
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

function isBulk(row: FilterRow, rules: SenderRuleSet): boolean {
  const h = headersOf(row);
  if (!h) return false;
  const cfg = rules.suppress.bulkHeaders;
  for (const key of cfg.anyKeyPresent) if (headerText(h, key) !== null) return true;
  const precedence = headerText(h, "precedence");
  if (precedence !== null && cfg.precedenceValues.includes(precedence)) return true;
  const auto = headerText(h, "auto_submitted");
  return cfg.autoSubmittedCounts && auto !== null && auto !== "no";
}

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

function keepRuleOf(from: string | null, rules: SenderRuleSet, keep: KeepSets, opts: DecideOptions): KeepRuleId | null {
  if (!from) return null;
  const host = hostOf(from);
  if (!opts.withoutContactKeeps && keep.contactAddresses.has(from)) return "K1";
  if (rules.keep.platformAddresses.includes(from) || hostMatchesAny(host, rules.keep.platformHosts)) return "K2";
  if (!opts.withoutContactKeeps && hostInSet(host, keep.contactDomains)) return "K3";
  return null;
}

function firstSuppressAfterKeep(
  from: string | null,
  row: FilterRow,
  rules: SenderRuleSet,
  on: (signal: SenderRuleSignal) => boolean,
): SuppressRuleId | null {
  const host = hostOf(from);
  if (on("approvedHost") && hostMatchesAny(host, rules.suppress.hosts)) return "S1";
  if (on("localPart")) {
    const lp = localPartOf(from);
    if (
      lp !== null &&
      rules.suppress.localParts.some((p) => (p.match === "exact" ? lp === p.value : lp.startsWith(p.value)))
    ) {
      return "S2";
    }
  }
  if (on("bulkHeaders") && isBulk(row, rules)) return "S3";
  if (row.source === "gmail") {
    const labels = labelsOf(row);
    for (const [rule, label] of GMAIL_CATEGORY_RULES) {
      if (on(SIGNAL_OF_RULE[rule]) && labels.includes(label)) return rule;
    }
  }
  return null;
}

/** The decision for one message on one surface, by the precedence above. */
export function decide(
  row: FilterRow,
  rules: SenderRuleSet,
  surface: SenderFilterSurface,
  keep: KeepSets = NO_KEEP,
  opts: DecideOptions = {},
): SenderDecision {
  const on = (signal: SenderRuleSignal) => rules.modes[signal][surface] !== "off";
  const liveOn = (signal: SenderRuleSignal) => rules.modes[signal][surface] === "live";
  const from = fromAddress(row.sender);
  const keepRule = keepRuleOf(from, rules, keep, opts);

  // A keep rule beats S1-S6, so with one there is no live S1-S6 drop.
  const liveAfterKeep = (): SuppressRuleId | null =>
    keepRule === null ? firstSuppressAfterKeep(from, row, rules, liveOn) : null;

  if (on("seedAddress") && from !== null && rules.suppress.exactAddresses.includes(from)) {
    const liveRule = liveOn("seedAddress") ? "S0" : liveAfterKeep();
    return {
      outcome: "suppress",
      rule: "S0",
      signal: "seedAddress",
      live: liveRule !== null,
      liveRule,
      keepConflict: keepRule,
    };
  }
  const rule = firstSuppressAfterKeep(from, row, rules, on);
  if (rule === null) return { outcome: "pass", rule: null, signal: null, live: false, liveRule: null, keepConflict: null };
  const signal = SIGNAL_OF_RULE[rule];
  if (keepRule !== null) {
    return { outcome: "keep", rule: keepRule, signal, live: false, liveRule: null, keepConflict: null };
  }
  const liveRule = liveOn(signal) ? rule : liveAfterKeep();
  return { outcome: "suppress", rule, signal, live: liveRule !== null, liveRule, keepConflict: null };
}
