/**
 * Client-side rule-set validator (BACKLOG-4186). The server stays the authority.
 *
 * A line-for-line mirror of the SQL validator in
 * supabase/migrations/20261107235503_backlog_4175_sender_rule_sets.sql:
 *   _sender_rule_set_keys_exact   -> keysExact
 *   _sender_rule_set_str_ok       -> isHost / isAddress / isLocalPart / isPrecedence / isBulkKey
 *   _sender_rule_set_int_ok       -> intOk
 *   _sender_rule_set_list_invalid -> listInvalid
 *   _sender_rule_set_invalid      -> invalidReason (same checks, same order, same reason text)
 *
 * It mirrors the SQL, not the desktop Zod schema: the SQL is stricter on non-ASCII text
 * ('^[!-~]+$' on addresses, local parts and precedence values), and the SQL is what refuses a
 * publish. Because that ASCII check runs first, JavaScript's \s, toLowerCase() and .length cannot
 * disagree with Postgres's \s, lower() and char_length() on any string that reaches them.
 *
 * Parity: __tests__/sender-rules-4186/validate.test.ts runs the 282-case corpus
 * (supabase/tests/backlog-4175/corpus.json) and compares with the SQL's recorded answers.
 *
 * The list editor imports the same predicates, so an item it accepts is one the server accepts.
 * Pure: no Supabase, no React.
 */

import { BULK_KEYS, SIGNALS, SURFACES, MEASURE_ONLY_SIGNALS, type SenderRuleSet, type ThresholdKey } from './types';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991, as the SQL

const PRINTABLE_ASCII = /^[!-~]+$/;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_RE = /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LOCAL_PART_RE = /^[^@\s]+$/;

const isLower = (s: string) => s === s.toLowerCase();

/** A domain: lowercase labels of a-z, 0-9 and '-', at least two, at most 253 characters. */
export function isHost(s: string): boolean {
  return s.length <= 253 && HOST_RE.test(s);
}

/** A lowercase printable-ASCII address with a host after the '@', at most 254 characters. */
export function isAddress(s: string): boolean {
  return s.length <= 254 && PRINTABLE_ASCII.test(s) && ADDRESS_RE.test(s) && isLower(s);
}

/** A lowercase printable-ASCII local part (no '@'), 1-64 characters. */
export function isLocalPart(s: string): boolean {
  return s.length >= 1 && s.length <= 64 && PRINTABLE_ASCII.test(s) && LOCAL_PART_RE.test(s) && isLower(s);
}

/** A lowercase printable-ASCII Precedence header value, 1-32 characters. */
export function isPrecedence(s: string): boolean {
  return s.length >= 1 && s.length <= 32 && PRINTABLE_ASCII.test(s) && isLower(s);
}

export function isBulkKey(s: string): boolean {
  return (BULK_KEYS as readonly string[]).includes(s);
}

export type ItemKind = 'host' | 'address' | 'localpart' | 'precedence' | 'bulkkey';

const PREDICATES: Record<ItemKind, (s: string) => boolean> = {
  host: isHost,
  address: isAddress,
  localpart: isLocalPart,
  precedence: isPrecedence,
  bulkkey: isBulkKey,
};

/** _sender_rule_set_str_ok: a JSON string of the kind. */
export function strOk(v: unknown, kind: ItemKind): boolean {
  return typeof v === 'string' && PREDICATES[kind](v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** _sender_rule_set_keys_exact: an object with exactly these keys. */
export function keysExact(o: unknown, keys: readonly string[]): o is Record<string, unknown> {
  if (!isPlainObject(o)) return false;
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

/** _sender_rule_set_int_ok: a safe integer in [lo, hi]. A numeric string is NOT a number. */
export function intOk(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
}

/** _sender_rule_set_list_invalid: null when valid, else the reason suffix. */
export function listInvalid(a: unknown, maxLen: number, kind: ItemKind): string | null {
  if (!Array.isArray(a)) return ': not a list';
  if (a.length > maxLen) return ': more than ' + maxLen + ' items';
  const bad = a.findIndex((v) => !strOk(v, kind));
  if (bad >= 0) return '[' + bad + ']: not a valid ' + kind;
  return null;
}

/** Caps, as the SQL (and the desktop schema). */
export const CAPS = {
  'suppress.exactAddresses': 500,
  'suppress.hosts': 2000,
  'suppress.localParts': 50,
  'suppress.bulkHeaders.anyKeyPresent': 4,
  'suppress.bulkHeaders.precedenceValues': 10,
  'keep.platformHosts': 200,
  'keep.platformAddresses': 200,
  freeMailDomains: 500,
} as const;

/** Threshold ranges, as the SQL. */
export const THRESHOLD_RANGES = {
  minCensusLinkedEmails: { min: 0, max: MAX_SAFE },
  reportSendIntervalHours: { min: 1, max: MAX_SAFE },
  reportMaxRows: { min: 1, max: 500 },
} as const;

/**
 * _sender_rule_set_invalid: null when `p` is a valid rule set, else the first reason, worded as
 * the server words it ("suppress.hosts[3]: not a valid host").
 */
export function invalidReason(p: unknown): string | null {
  if (!keysExact(p, ['schema', 'version', 'suppress', 'keep', 'freeMailDomains', 'thresholds', 'modes'])) {
    return 'root: keys';
  }
  if (!intOk(p.schema, 1, 1)) return 'schema: must be 1';
  if (!intOk(p.version, 1, MAX_SAFE)) return 'version: not a positive integer';

  // suppress
  const suppress = p.suppress;
  if (!keysExact(suppress, ['exactAddresses', 'hosts', 'localParts', 'bulkHeaders'])) return 'suppress: keys';
  let r = listInvalid(suppress.exactAddresses, CAPS['suppress.exactAddresses'], 'address');
  if (r !== null) return 'suppress.exactAddresses' + r;
  r = listInvalid(suppress.hosts, CAPS['suppress.hosts'], 'host');
  if (r !== null) return 'suppress.hosts' + r;
  const lps = suppress.localParts;
  if (!Array.isArray(lps)) return 'suppress.localParts: not a list';
  if (lps.length > CAPS['suppress.localParts']) return 'suppress.localParts: more than 50 items';
  const badLp = lps.findIndex(
    (e) => !(keysExact(e, ['value', 'match']) && strOk(e.value, 'localpart') && (e.match === 'exact' || e.match === 'prefix')),
  );
  if (badLp >= 0) return 'suppress.localParts[' + badLp + ']: not a valid item';
  const bulk = suppress.bulkHeaders;
  if (!keysExact(bulk, ['anyKeyPresent', 'precedenceValues', 'autoSubmittedCounts'])) return 'suppress.bulkHeaders: keys';
  r = listInvalid(bulk.anyKeyPresent, CAPS['suppress.bulkHeaders.anyKeyPresent'], 'bulkkey');
  if (r !== null) return 'suppress.bulkHeaders.anyKeyPresent' + r;
  r = listInvalid(bulk.precedenceValues, CAPS['suppress.bulkHeaders.precedenceValues'], 'precedence');
  if (r !== null) return 'suppress.bulkHeaders.precedenceValues' + r;
  if (typeof bulk.autoSubmittedCounts !== 'boolean') return 'suppress.bulkHeaders.autoSubmittedCounts: not a boolean';

  // keep
  const keep = p.keep;
  if (!keysExact(keep, ['platformHosts', 'platformAddresses'])) return 'keep: keys';
  r = listInvalid(keep.platformHosts, CAPS['keep.platformHosts'], 'host');
  if (r !== null) return 'keep.platformHosts' + r;
  r = listInvalid(keep.platformAddresses, CAPS['keep.platformAddresses'], 'address');
  if (r !== null) return 'keep.platformAddresses' + r;

  // freeMailDomains
  r = listInvalid(p.freeMailDomains, CAPS.freeMailDomains, 'host');
  if (r !== null) return 'freeMailDomains' + r;

  // thresholds
  const t = p.thresholds;
  if (!keysExact(t, ['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows'])) return 'thresholds: keys';
  if (!intOk(t.minCensusLinkedEmails, 0, MAX_SAFE)) return 'thresholds.minCensusLinkedEmails: not an integer >= 0';
  if (!intOk(t.reportSendIntervalHours, 1, MAX_SAFE)) return 'thresholds.reportSendIntervalHours: not a positive integer';
  if (!intOk(t.reportMaxRows, 1, 500)) return 'thresholds.reportMaxRows: not an integer 1-500';

  // modes: 7 signals x 3 surfaces; gmailUpdates is measure-only
  const modes = p.modes;
  if (!keysExact(modes, SIGNALS)) return 'modes: keys';
  for (const sig of SIGNALS) {
    const cell = modes[sig];
    if (!keysExact(cell, SURFACES)) return 'modes.' + sig + ': keys';
    const allowed = MEASURE_ONLY_SIGNALS.includes(sig) ? ['off', 'measure'] : ['off', 'measure', 'live'];
    for (const surf of SURFACES) {
      const m = cell[surf];
      if (!(typeof m === 'string' && allowed.includes(m))) return 'modes.' + sig + '.' + surf + ': not an allowed mode';
    }
  }
  return null;
}

/** The content as a SenderRuleSet when valid, else null. Never throws. */
export function parseRuleSet(v: unknown): SenderRuleSet | null {
  return invalidReason(v) === null ? (v as SenderRuleSet) : null;
}

export type ThresholdInput = { ok: true; value: number } | { ok: false; reason: string };

/**
 * A threshold typed into a text input -> a NUMBER for the rule set, or why not. The server
 * refuses the string "20" (4175 `_sender_rule_set_int_ok` checks jsonb_typeof = 'number').
 */
export function parseThresholdInput(key: ThresholdKey, input: string): ThresholdInput {
  const s = input.trim();
  if (!/^[0-9]+$/.test(s)) return { ok: false, reason: 'Enter a whole number.' };
  const n = Number(s);
  const { min, max } = THRESHOLD_RANGES[key];
  if (!Number.isSafeInteger(n)) return { ok: false, reason: 'Number is too large.' };
  if (n < min) return { ok: false, reason: 'Must be at least ' + min + '.' };
  if (n > max) return { ok: false, reason: 'Must be at most ' + max + '.' };
  return { ok: true, value: n };
}

/**
 * A copy of `content` with one threshold set from a text input, or why the input is refused.
 * The value stored is the parsed NUMBER, never the input string.
 */
export function setThreshold(
  content: SenderRuleSet,
  key: ThresholdKey,
  input: string,
): { ok: true; content: SenderRuleSet } | { ok: false; reason: string } {
  const r = parseThresholdInput(key, input);
  if (!r.ok) return r;
  return { ok: true, content: { ...content, thresholds: { ...content.thresholds, [key]: r.value } } };
}
