/**
 * Pure, deterministic sort for the PM Projects list page.
 *
 * Extracted from the page component so it is unit-testable (BACKLOG-1902).
 *
 * Determinism requirements (SR-required change #4):
 * - Every sort key uses an EXPLICIT rank map or a well-defined comparator --
 *   never relies on the incoming array order.
 * - Every sort is STABLE via a secondary tiebreaker on `name` (case-insensitive)
 *   then `id`, so toggling direction never reshuffles equal-rank rows.
 * - The input array is never mutated (a shallow copy is sorted).
 */

import type { PmProject } from '@/lib/pm-types';
import { PRIORITY_RANK } from '@/lib/pm-types';

export type ProjectSortKey = 'name' | 'days_open' | 'status' | 'priority';
export type SortDirection = 'asc' | 'desc';

/**
 * Lifecycle rank for project status. Lower = earlier in lifecycle.
 * Mainly meaningful on the "All" tab (a single-status tab is already uniform),
 * but harmless everywhere.
 */
const STATUS_RANK: Record<PmProject['status'], number> = {
  planned: 0,
  active: 1,
  on_hold: 2,
  completed: 3,
  archived: 4,
};

/** Case-insensitive name comparison used both as a primary and tiebreaker key. */
function compareName(a: PmProject, b: PmProject): number {
  return (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase());
}

/**
 * Elapsed milliseconds since `created_at`. A larger value means the project
 * has been open longer (older created_at). Guards against a missing/NaN
 * created_at by treating it as "0 days open" (0 elapsed ms), so such rows fall
 * to the fewest-days-open end in ascending order and never poison the
 * comparator with NaN.
 */
function daysOpenMs(p: PmProject): number {
  const created = Date.parse(p.created_at);
  if (Number.isNaN(created)) return 0;
  return Date.now() - created;
}

/**
 * Stable tiebreaker: name (case-insensitive) then id. Applied on top of every
 * primary comparator so equal-rank rows keep a fixed, direction-independent
 * order. The tiebreaker is NOT flipped by `dir` -- only the primary key is.
 */
function stableTiebreak(a: PmProject, b: PmProject): number {
  const byName = compareName(a, b);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/**
 * Sort a list of projects by the given key/direction.
 *
 * Direction semantics:
 * - name:      asc = A→Z.
 * - days_open: asc = fewest days open first (newest created_at first).
 * - status:    asc = earliest lifecycle first (planned → archived).
 * - priority:  asc = lowest priority first; desc = critical first.
 *
 * `desc` inverts ONLY the primary comparison; the name/id tiebreaker stays
 * ascending so equal rows never reshuffle when the direction is toggled.
 */
export function sortProjects(
  projects: PmProject[],
  key: ProjectSortKey,
  dir: SortDirection
): PmProject[] {
  const mult = dir === 'asc' ? 1 : -1;

  const primary = (a: PmProject, b: PmProject): number => {
    switch (key) {
      case 'name':
        return compareName(a, b);
      case 'days_open':
        // Fewer days open first when ascending => smaller elapsed ms first.
        return daysOpenMs(a) - daysOpenMs(b);
      case 'status':
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      case 'priority':
        // Ascending = lowest rank first. The direction toggle (desc) surfaces
        // critical first.
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      default:
        return 0;
    }
  };

  return [...projects].sort((a, b) => {
    const p = primary(a, b) * mult;
    if (p !== 0) return p;
    return stableTiebreak(a, b);
  });
}
