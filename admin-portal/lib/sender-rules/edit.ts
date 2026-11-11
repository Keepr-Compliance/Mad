/**
 * Sender rules — editing a draft rule set without mutating it (BACKLOG-4186).
 *
 * The list editor's add uses the same predicates as invalidReason (validate.ts), so an item it
 * accepts is one the server accepts. Items are trimmed and lowercased (every list kind is
 * lowercase on the server); a pasted comma- or newline-separated list adds every item; an
 * invalid item is refused with its reason; duplicates are ignored; the cap is enforced.
 *
 * Pure: no Supabase, no React.
 */

import { CAPS, isAddress, isHost, isLocalPart, isPrecedence } from './validate';
import type { BulkHeaderKey, LocalPartRule, SenderRuleMode, SenderRuleSet, SenderRuleSignal, SenderRuleSurface } from './types';

/** The plain string lists (sender names are LocalPartRule objects, handled apart). */
export type StringListPath =
  | 'suppress.exactAddresses'
  | 'suppress.hosts'
  | 'suppress.bulkHeaders.precedenceValues'
  | 'keep.platformHosts'
  | 'keep.platformAddresses'
  | 'freeMailDomains';

export type StringItemKind = 'host' | 'address' | 'precedence';

export const STRING_LIST_KIND: Record<StringListPath, StringItemKind> = {
  'suppress.exactAddresses': 'address',
  'suppress.hosts': 'host',
  'suppress.bulkHeaders.precedenceValues': 'precedence',
  'keep.platformHosts': 'host',
  'keep.platformAddresses': 'address',
  freeMailDomains: 'host',
};

const KIND_PREDICATE: Record<StringItemKind | 'localpart', (s: string) => boolean> = {
  host: isHost,
  address: isAddress,
  precedence: isPrecedence,
  localpart: isLocalPart,
};

const KIND_NAME: Record<StringItemKind | 'localpart', string> = {
  host: 'domain',
  address: 'email address',
  precedence: 'Precedence value',
  localpart: 'sender name',
};

export function getStringList(c: SenderRuleSet, path: StringListPath): string[] {
  switch (path) {
    case 'suppress.exactAddresses':
      return c.suppress.exactAddresses;
    case 'suppress.hosts':
      return c.suppress.hosts;
    case 'suppress.bulkHeaders.precedenceValues':
      return c.suppress.bulkHeaders.precedenceValues;
    case 'keep.platformHosts':
      return c.keep.platformHosts;
    case 'keep.platformAddresses':
      return c.keep.platformAddresses;
    case 'freeMailDomains':
      return c.freeMailDomains;
  }
}

export function setStringList(c: SenderRuleSet, path: StringListPath, items: string[]): SenderRuleSet {
  switch (path) {
    case 'suppress.exactAddresses':
      return { ...c, suppress: { ...c.suppress, exactAddresses: items } };
    case 'suppress.hosts':
      return { ...c, suppress: { ...c.suppress, hosts: items } };
    case 'suppress.bulkHeaders.precedenceValues':
      return { ...c, suppress: { ...c.suppress, bulkHeaders: { ...c.suppress.bulkHeaders, precedenceValues: items } } };
    case 'keep.platformHosts':
      return { ...c, keep: { ...c.keep, platformHosts: items } };
    case 'keep.platformAddresses':
      return { ...c, keep: { ...c.keep, platformAddresses: items } };
    case 'freeMailDomains':
      return { ...c, freeMailDomains: items };
  }
}

/** Split typed or pasted text into items: commas, newlines and spaces separate; trimmed, lowercased. */
export function splitItems(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

export type AddResult = { items: string[]; error: string | null };

/** Add typed text to a string list: every valid new item is added, the first refusal is reported. */
export function addStringItems(existing: string[], input: string, kind: StringItemKind, cap: number): AddResult {
  const items = [...existing];
  let error: string | null = null;
  for (const item of splitItems(input)) {
    if (!KIND_PREDICATE[kind](item)) {
      error ??= item + ' is not a valid ' + KIND_NAME[kind] + '.';
      continue;
    }
    if (items.includes(item)) continue;
    if (items.length >= cap) {
      error ??= 'Up to ' + cap + ' items.';
      break;
    }
    items.push(item);
  }
  return { items, error };
}

/** Add one sender-name rule. */
export function addLocalPart(
  existing: LocalPartRule[],
  input: string,
  match: LocalPartRule['match'],
): { items: LocalPartRule[]; error: string | null } {
  const value = input.trim().toLowerCase();
  if (value === '') return { items: existing, error: null };
  if (!isLocalPart(value)) return { items: existing, error: value + ' is not a valid ' + KIND_NAME.localpart + '.' };
  if (existing.some((r) => r.value === value && r.match === match)) return { items: existing, error: null };
  const cap = CAPS['suppress.localParts'];
  if (existing.length >= cap) return { items: existing, error: 'Up to ' + cap + ' items.' };
  return { items: [...existing, { value, match }], error: null };
}

export function setLocalParts(c: SenderRuleSet, items: LocalPartRule[]): SenderRuleSet {
  return { ...c, suppress: { ...c.suppress, localParts: items } };
}

export function setMode(c: SenderRuleSet, signal: SenderRuleSignal, surface: SenderRuleSurface, mode: SenderRuleMode): SenderRuleSet {
  return { ...c, modes: { ...c.modes, [signal]: { ...c.modes[signal], [surface]: mode } } };
}

export function toggleBulkKey(c: SenderRuleSet, key: BulkHeaderKey, on: boolean): SenderRuleSet {
  const cur = c.suppress.bulkHeaders.anyKeyPresent;
  const next = on ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((k) => k !== key);
  return { ...c, suppress: { ...c.suppress, bulkHeaders: { ...c.suppress.bulkHeaders, anyKeyPresent: next } } };
}

export function setAutoSubmittedCounts(c: SenderRuleSet, on: boolean): SenderRuleSet {
  return { ...c, suppress: { ...c.suppress, bulkHeaders: { ...c.suppress.bulkHeaders, autoSubmittedCounts: on } } };
}
