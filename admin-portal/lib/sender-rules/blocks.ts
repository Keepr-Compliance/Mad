/**
 * Sender rules — the release guard's refusal in words (BACKLOG-4186).
 *
 * sender_rule_set_publish(content, NULL) refuses a release that would reach every org untested
 * with SQLSTATE 22023 and DETAIL = a JSON list (4175 `_sender_rule_set_release_blocks`):
 *   {"kind":"mode","signal":s,"surface":f}       a cell turned live
 *   {"kind":"add"|"remove","list":path,"item":x}  a list change under a live signal
 *   {"kind":"flag","list":path}                  autoSubmittedCounts false -> true
 * PostgREST hands DETAIL to the client as `error.details`, a string.
 *
 * Every item becomes one line. An item of an unknown kind, or a DETAIL that is not a JSON list,
 * is shown as its raw text: never dropped.
 *
 * Pure: no Supabase, no React.
 */

import { canonical, formatItem } from './diff';
import { labelOf, LIST_LABELS, SIGNAL_LABELS, SURFACE_LABELS } from './labels';

export type ReleaseBlock = Record<string, unknown>;

/** The DETAIL list, or null when it is not a JSON list. */
export function parseBlocks(details: unknown): ReleaseBlock[] | null {
  if (typeof details !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(details);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  return v.map((b) => (b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as ReleaseBlock) : { raw: b }));
}

/** One block in words. */
export function blockLine(b: ReleaseBlock): string {
  switch (b.kind) {
    case 'mode':
      return labelOf(SIGNAL_LABELS, b.signal) + ' turns Live in ' + labelOf(SURFACE_LABELS, b.surface);
    case 'add':
      return 'Adds ' + formatItem(b.item) + ' to ' + labelOf(LIST_LABELS, b.list);
    case 'remove':
      return 'Removes ' + formatItem(b.item) + ' from ' + labelOf(LIST_LABELS, b.list);
    case 'flag':
      return 'Counts auto-submitted mail as bulk';
    default:
      return 'raw' in b && Object.keys(b).length === 1 ? canonical(b.raw) : canonical(b);
  }
}

/** DETAIL -> lines. A DETAIL that is not a JSON list comes back as one line of its raw text. */
export function blockLines(details: unknown): string[] {
  const blocks = parseBlocks(details);
  if (blocks === null) return typeof details === 'string' && details !== '' ? [details] : [];
  return blocks.map(blockLine);
}
