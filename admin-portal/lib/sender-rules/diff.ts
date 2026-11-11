/**
 * Sender rules — what changes between two rule sets (BACKLOG-4186).
 *
 * Every stored content carries its own `version` (4175: the publish RPC overwrites it, and a
 * CHECK ties it to the row). Two versions with the same rules therefore differ in `version`
 * alone, so both sides are compared with `version` removed: re-publishing v3's rules over a
 * released v5 with the same rules is "No changes".
 *
 * Lists are compared element by element, never by length (as the release guard does), so a list
 * that swaps one item for another shows both the add and the remove.
 *
 * Anything outside the known fields still shows up, as a `field` line, so a change is never
 * silently invisible.
 *
 * Pure: no Supabase, no React.
 */

import { labelOf, LIST_LABELS, MODE_LABELS, SIGNAL_LABELS, SURFACE_LABELS, THRESHOLD_LABELS } from './labels';
import { LIST_PATHS, THRESHOLD_KEYS, type ListPath, type ThresholdKey } from './types';

export type DiffLine =
  | { kind: 'mode'; signal: string; surface: string; from: unknown; to: unknown }
  | { kind: 'add' | 'remove'; list: ListPath; item: unknown }
  | { kind: 'flag'; list: 'suppress.bulkHeaders.autoSubmittedCounts'; from: unknown; to: unknown }
  | { kind: 'threshold'; key: ThresholdKey; from: unknown; to: unknown }
  | { kind: 'field'; path: string; from: unknown; to: unknown };

/** JSON with object keys sorted, so equal values give equal text whatever their key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'undefined';
}

/** A shallow copy without the `version` key. */
export function stripVersion(c: unknown): Record<string, unknown> {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return {};
  const { version: _version, ...rest } = c as Record<string, unknown>;
  void _version;
  return rest;
}

function at(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const KNOWN_TOP = new Set(['suppress', 'keep', 'freeMailDomains', 'thresholds', 'modes']);

/** The changes that turn `base` into `next`, both compared without `version`. */
export function diffRuleSets(baseIn: unknown, nextIn: unknown): DiffLine[] {
  const base = stripVersion(baseIn);
  const next = stripVersion(nextIn);
  const out: DiffLine[] = [];

  // modes: every signal x surface present on either side
  const bm = (base.modes ?? {}) as Record<string, Record<string, unknown>>;
  const nm = (next.modes ?? {}) as Record<string, Record<string, unknown>>;
  const signals = [...new Set([...Object.keys(bm), ...Object.keys(nm)])];
  for (const sig of signals) {
    const surfaces = [...new Set([...Object.keys(bm[sig] ?? {}), ...Object.keys(nm[sig] ?? {})])];
    for (const surf of surfaces) {
      const from = bm[sig]?.[surf];
      const to = nm[sig]?.[surf];
      if (canonical(from) !== canonical(to)) out.push({ kind: 'mode', signal: sig, surface: surf, from, to });
    }
  }

  // lists, element-wise
  for (const list of LIST_PATHS) {
    const b = asList(at(base, list));
    const n = asList(at(next, list));
    const bs = new Set(b.map(canonical));
    const ns = new Set(n.map(canonical));
    for (const item of n) if (!bs.has(canonical(item))) out.push({ kind: 'add', list, item });
    for (const item of b) if (!ns.has(canonical(item))) out.push({ kind: 'remove', list, item });
  }

  const fb = at(base, 'suppress.bulkHeaders.autoSubmittedCounts');
  const fn = at(next, 'suppress.bulkHeaders.autoSubmittedCounts');
  if (canonical(fb) !== canonical(fn)) {
    out.push({ kind: 'flag', list: 'suppress.bulkHeaders.autoSubmittedCounts', from: fb, to: fn });
  }

  for (const key of THRESHOLD_KEYS) {
    const from = at(base, 'thresholds.' + key);
    const to = at(next, 'thresholds.' + key);
    if (canonical(from) !== canonical(to)) out.push({ kind: 'threshold', key, from, to });
  }

  // anything else at the top level (schema, or a key a later schema adds)
  const rest = [...new Set([...Object.keys(base), ...Object.keys(next)])].filter((k) => !KNOWN_TOP.has(k)).sort();
  for (const k of rest) {
    if (canonical(base[k]) !== canonical(next[k])) out.push({ kind: 'field', path: k, from: base[k], to: next[k] });
  }
  return out;
}

/** True when the two rule sets hold the same rules (their `version` is ignored). */
export function sameContent(a: unknown, b: unknown): boolean {
  return diffRuleSets(a, b).length === 0;
}

/** One list item as text: a string as is, a sender-name rule as "value (starts with)". */
export function formatItem(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    if (typeof o.value === 'string' && (o.match === 'exact' || o.match === 'prefix')) {
      return o.value + (o.match === 'prefix' ? ' (starts with)' : ' (exact)');
    }
  }
  return canonical(item);
}

const modeText = (m: unknown) => labelOf(MODE_LABELS, m);

/** One diff line in words. */
export function diffLineText(line: DiffLine): string {
  switch (line.kind) {
    case 'mode':
      return (
        labelOf(SIGNAL_LABELS, line.signal) + ' in ' + labelOf(SURFACE_LABELS, line.surface) + ': ' +
        modeText(line.from) + ' to ' + modeText(line.to)
      );
    case 'add':
      return 'Adds ' + formatItem(line.item) + ' to ' + labelOf(LIST_LABELS, line.list);
    case 'remove':
      return 'Removes ' + formatItem(line.item) + ' from ' + labelOf(LIST_LABELS, line.list);
    case 'flag':
      return line.to === true ? 'Counts auto-submitted mail as bulk' : 'Stops counting auto-submitted mail as bulk';
    case 'threshold':
      return labelOf(THRESHOLD_LABELS, line.key) + ': ' + canonical(line.from) + ' to ' + canonical(line.to);
    case 'field':
      return line.path + ': ' + canonical(line.from) + ' to ' + canonical(line.to);
  }
}
