/**
 * CONTACTS CATEGORY-FILTER oracle + scenarios (BACKLOG-1977, P2-C1).
 *
 * The single source of truth for the EXPECTED per-filter visible SET: it applies the REAL production
 * predicate (src/utils/contactFilterModel.matchesContactFilters — the EXACT function the renderer's
 * ContactSearchList runs) over the observed DB rows, so the expected set and the UI can never drift on
 * the predicate itself. The spec asserts the RENDERED contact-id SET equals expectedVisibleIds() — an
 * IDENTITY-level gate, not a count (a count-only assertion can pass on the WRONG rows). expectedVisibleCount
 * is derived from the id set for the unit-test per-leaf pins and diagnostics.
 *
 * WHY HERE (e2e/driver, not scripts/qa/harness): this module imports from src/, and the harness tsconfig
 * (rootDir=scripts/qa/harness) rejects a cross-tree src import. e2e/tsconfig has no such restriction, so
 * the src-dependent oracle lives here (type-checked by qa:e2e:typecheck) while contacts-filter-core.ts
 * stays pure. This module is PLAYWRIGHT-FREE (only src + local types), so the pure-Node unit test
 * (scripts/qa/harness/__tests__/contacts-filter-core.test.ts) imports it under jest too.
 */
import {
  matchesContactFilters,
  defaultSourceSelection,
  defaultRoleSelection,
  ALL_SOURCE_LEAF_IDS,
  ALL_ROLE_LEAF_IDS,
  SOURCE_LEAF,
  ROLE_LEAF,
} from '../../src/utils/contactFilterModel';
import type { ObservedContactRow } from '../../scripts/qa/harness/contacts-filter-core';

/** Shared predicate application: does this observed row match the given source+role leaf selection? */
function rowMatches(row: ObservedContactRow, sources: Set<string>, roles: Set<string>): boolean {
  return matchesContactFilters(
    {
      source: (row.source ?? undefined) as never,
      is_message_derived: row.is_message_derived ?? 0,
      // matchesRoleLeaf treats null/undefined/'' identically (Unassigned); normalize null→undefined
      // to satisfy Contact.default_role's `string | undefined` type without changing the predicate.
      default_role: row.default_role ?? undefined,
    },
    { sources, roles },
  );
}

/**
 * The ORACLE (IDENTITY-level, BACKLOG-1977). Apply the REAL production predicate over the observed rows
 * for the given source+role leaf selections, returning the SORTED contact ids that WOULD be visible.
 *
 * This is the id-returning sibling of expectedVisibleCount and the STRONGER assertion: the spec compares
 * the RENDERED data-contact-id set against this exact set, so a divergence names WHICH contacts differ,
 * not merely how many. `source: null` is normalized to `undefined` (matchesContactFilters treats an
 * absent source as matching no leaf), and the imported read path aliases is_message_derived to 0.
 */
export function expectedVisibleIds(
  rows: readonly ObservedContactRow[],
  sources: Set<string>,
  roles: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (rowMatches(row, sources, roles)) ids.push(row.id);
  }
  return ids.sort();
}

/**
 * The count oracle — DERIVED from expectedVisibleIds so the count and the id set can never disagree
 * (a count-only assertion is a false-confidence trap: the same count can be the WRONG rows and still
 * pass). Retained for the unit test's per-leaf count pins and for diagnostics.
 */
export function expectedVisibleCount(
  rows: readonly ObservedContactRow[],
  sources: Set<string>,
  roles: Set<string>,
): number {
  return expectedVisibleIds(rows, sources, roles).length;
}

/** A single deterministic filter scenario the cell drives and asserts. */
export interface FilterScenario {
  /** Stable name for logging + the spec's test title. */
  name: string;
  /** Source leaf selection to drive. */
  sources: Set<string>;
  /** Role leaf selection to drive. */
  roles: Set<string>;
}

/** All source leaves selected (every provider) — used to isolate the ROLE dimension. */
function allSources(): Set<string> {
  return new Set<string>(ALL_SOURCE_LEAF_IDS as readonly string[]);
}
/** All role leaves selected (every role incl. Unassigned) — used to isolate the SOURCE dimension. */
function allRoles(): Set<string> {
  return new Set<string>(ALL_ROLE_LEAF_IDS as readonly string[]);
}

/**
 * The fixed scenarios. Each isolates one dimension (all of the other selected) so the driven count maps
 * cleanly to a seeded per-leaf count, plus the app DEFAULT selection. Expected counts are NOT hard-coded
 * here — the cell derives them from expectedVisibleCount() over the observed DB rows (single source of
 * truth); the unit test pins the per-leaf numbers against the seeded corpus.
 */
export const FILTER_SCENARIOS: readonly FilterScenario[] = [
  // App defaults: all sources except Inferred; Clients-only role (buyers+sellers); Unassigned OFF.
  { name: 'default (Clients role, all non-inferred sources)', sources: defaultSourceSelection(), roles: defaultRoleSelection() },
  // Source isolation (all roles ON): each provider's seeded count.
  { name: 'source=Manual only (all roles)', sources: new Set([SOURCE_LEAF.MANUAL]), roles: allRoles() },
  { name: 'source=Outlook only (all roles)', sources: new Set([SOURCE_LEAF.EMAIL_OUTLOOK]), roles: allRoles() },
  { name: 'source=iPhone only (all roles)', sources: new Set([SOURCE_LEAF.PHONE_IPHONE]), roles: allRoles() },
  // Role isolation (all sources ON): each role's seeded count.
  { name: 'role=Buyers only (all sources)', sources: allSources(), roles: new Set([ROLE_LEAF.BUYERS]) },
  { name: 'role=Sellers only (all sources)', sources: allSources(), roles: new Set([ROLE_LEAF.SELLERS]) },
  { name: 'role=Agents only (all sources)', sources: allSources(), roles: new Set([ROLE_LEAF.AGENTS]) },
  { name: 'role=Unassigned only (all sources)', sources: allSources(), roles: new Set([ROLE_LEAF.UNASSIGNED]) },
] as const;
