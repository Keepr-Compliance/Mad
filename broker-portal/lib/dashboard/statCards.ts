/**
 * The broker dashboard's four stat cards — BACKLOG-3904.
 *
 * Each card counts DEALS (the head of every resubmission chain, see
 * lib/submissions/dealList.ts), the same unit the Submissions list shows, in
 * the same scope. A card links to the list with the status filter whose result
 * is exactly the card's set. A card whose set no single filter selects has
 * `filter: undefined` and is not linked.
 */

import { NEW_FILTER } from '@/lib/submissions/dealList';
import { buildListUrl } from '@/lib/submissions/listUrl';

export type StatCardKey = 'new' | 'resubmitted' | 'under_review' | 'needs_changes';

export interface StatCardDef {
  key: StatCardKey;
  label: string;
  /** Head statuses this card counts; null counts every deal. */
  statuses: readonly string[] | null;
  /**
   * The list's `status` value that selects exactly this card's deals; 'all' for
   * every deal; undefined when no filter does (the card is not linked).
   *
   * New counts `submitted` heads only, which the list's `submitted` value
   * (submitted + resubmitted) does not select, so New has its own value, `new`.
   */
  filter: string | undefined;
}

export const STAT_CARDS: readonly StatCardDef[] = [
  { key: 'new', label: 'New', statuses: ['submitted'], filter: NEW_FILTER },
  { key: 'resubmitted', label: 'Resubmitted', statuses: ['resubmitted'], filter: 'resubmitted' },
  { key: 'under_review', label: 'Under Review', statuses: ['under_review'], filter: 'under_review' },
  { key: 'needs_changes', label: 'Needs Changes', statuses: ['needs_changes'], filter: 'needs_changes' },
];

/** The ids of the deals a card counts, from the deal heads. */
export function cardDealIds(heads: ReadonlyArray<{ id: string; status: string | null }>, def: StatCardDef): string[] {
  return heads
    .filter((h) => def.statuses === null || (h.status !== null && def.statuses.includes(h.status)))
    .map((h) => h.id);
}

/** The card's link target, or null when the card is not linked. */
export function statCardHref(def: StatCardDef): string | null {
  if (def.filter === undefined) return null;
  return buildListUrl({ status: def.filter, agent: null, search: '' });
}

export interface StatCardData {
  key: StatCardKey;
  label: string;
  value: number;
  href: string | null;
}

export function buildStatCards(heads: ReadonlyArray<{ id: string; status: string | null }>): StatCardData[] {
  return STAT_CARDS.map((def) => ({
    key: def.key,
    label: def.label,
    value: cardDealIds(heads, def).length,
    href: statCardHref(def),
  }));
}
