/**
 * CONTACTS CATEGORY-FILTER oracle + scenarios (BACKLOG-1977, P2-C1).
 *
 * The single source of truth for the EXPECTED per-filter visible count: it applies the REAL production
 * predicate (src/utils/contactFilterModel.matchesContactFilters — the EXACT function the renderer's
 * ContactSearchList runs) over the observed DB rows, so the expected count and the UI can never drift on
 * the predicate itself. The spec asserts the RENDERED contact-row count equals expectedVisibleCount().
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

/**
 * The ORACLE. Apply the REAL production predicate over the observed rows for the given source+role leaf
 * selections, returning the number of contacts that WOULD be visible. `source: null` is normalized to
 * `undefined` (matchesContactFilters treats an absent source as matching no leaf), and the imported read
 * path aliases is_message_derived to 0.
 */
export function expectedVisibleCount(
  rows: readonly ObservedContactRow[],
  sources: Set<string>,
  roles: Set<string>,
): number {
  let n = 0;
  for (const row of rows) {
    if (
      matchesContactFilters(
        {
          source: (row.source ?? undefined) as never,
          is_message_derived: row.is_message_derived ?? 0,
          // matchesRoleLeaf treats null/undefined/'' identically (Unassigned); normalize null→undefined
          // to satisfy Contact.default_role's `string | undefined` type without changing the predicate.
          default_role: row.default_role ?? undefined,
        },
        { sources, roles },
      )
    ) {
      n += 1;
    }
  }
  return n;
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
