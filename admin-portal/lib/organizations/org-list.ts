/**
 * BACKLOG-4098: Organizations tab list state. Pure functions, no React.
 *
 * - Type: brokerages (default) / personal / all, from `is_personal`.
 * - Test organizations hidden unless `showTest`, from `is_test`.
 * - Plan: multi-select on `plan_tier`; an empty selection filters nothing. A row
 *   with no plan is excluded while any plan is picked.
 * - Search: name and slug, case-insensitive. The plan name is not searched.
 * - Sort: name / plan / members / created. Never sorts its input in place.
 *
 * The flags come from admin_list_organizations. When ANY row lacks a boolean
 * flag, the whole list is treated as "flags missing": the type and test
 * filters are skipped (every row shown) and the UI disables those controls.
 * A missing flag is never read as false.
 */
import {
  nextSort,
  readFirst,
  readList,
  readSort,
  writeParam,
  writeSort,
  type ParamRecord,
  type SortDirection,
  type SortParamOptions,
  type SortState,
  type UrlStateCodec,
} from '@keepr/ui';

export type OrgTypeFilter = 'brokerages' | 'personal' | 'all';
export type OrgSortKey = 'name' | 'plan' | 'members' | 'created';

export const ORG_TYPE_FILTERS: readonly OrgTypeFilter[] = ['brokerages', 'personal', 'all'];
export const ORG_SORT_KEYS: readonly OrgSortKey[] = ['name', 'plan', 'members', 'created'];

/** The fields of an organization row this module reads. */
export interface OrgListRow {
  id: string;
  name: string;
  slug: string;
  plan_name: string | null;
  plan_tier: string | null;
  created_at: string | null;
  member_count: number;
  is_personal?: boolean | null;
  is_test?: boolean | null;
}

export interface OrgListState {
  type: OrgTypeFilter;
  showTest: boolean;
  /** Picked plan tiers. Empty = no plan filter. */
  plan: string[];
  q: string;
  sort: SortState<OrgSortKey>;
}

/** Text columns open ascending, numbers and dates descending. */
export function orgSortDefaultDirection(key: OrgSortKey): SortDirection {
  return key === 'members' || key === 'created' ? 'desc' : 'asc';
}

export const ORG_SORT_OPTIONS: SortParamOptions<OrgSortKey> = {
  keys: ORG_SORT_KEYS,
  defaultKey: 'name',
  defaultDirectionFor: orgSortDefaultDirection,
};

export const DEFAULT_ORG_LIST_STATE: OrgListState = {
  type: 'brokerages',
  showTest: false,
  plan: [],
  q: '',
  sort: { key: 'name', direction: 'asc' },
};

/** The state "Show all organizations" sets: every filter off, search cleared, sort kept. */
export function showAllState(state: OrgListState): OrgListState {
  return { ...state, type: 'all', showTest: true, plan: [], q: '' };
}

/** The sort after a column header is clicked. */
export function sortAfterClick(state: OrgListState, key: OrgSortKey): OrgListState {
  return { ...state, sort: nextSort(state.sort, key, orgSortDefaultDirection) };
}

/** True only when EVERY row carries both flags as booleans. Vacuously true for no rows. */
export function flagsAvailable(rows: readonly OrgListRow[]): boolean {
  return rows.every((r) => typeof r.is_personal === 'boolean' && typeof r.is_test === 'boolean');
}

/** Plan filter options, built from ALL rows (not the filtered ones), one per tier. */
export function planOptions(rows: readonly OrgListRow[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!r.plan_tier || seen.has(r.plan_tier)) continue;
    seen.set(r.plan_tier, r.plan_name || r.plan_tier);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

export function filterOrgs<R extends OrgListRow>(rows: readonly R[], state: OrgListState, haveFlags: boolean): R[] {
  const q = state.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (haveFlags) {
      if (state.type === 'brokerages' && r.is_personal !== false) return false;
      if (state.type === 'personal' && r.is_personal !== true) return false;
      if (!state.showTest && r.is_test !== false) return false;
    }
    if (state.plan.length > 0 && (!r.plan_tier || !state.plan.includes(r.plan_tier))) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    return true;
  });
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function sortValue(r: OrgListRow, key: OrgSortKey): string | number | null {
  switch (key) {
    case 'name':
      return r.name;
    case 'plan':
      return r.plan_name || null;
    case 'members':
      return r.member_count;
    case 'created': {
      if (!r.created_at) return null;
      const t = Date.parse(r.created_at);
      return Number.isNaN(t) ? null : t;
    }
  }
}

/** A sorted COPY. Missing values sort last in both directions; ties fall back to name. */
export function sortOrgs<R extends OrgListRow>(rows: readonly R[], sort: SortState<OrgSortKey>): R[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) {
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : compareText(String(va), String(vb));
      if (c !== 0) return c * sign;
    }
    return compareText(a.name, b.name);
  });
}

/**
 * URL params: `type` (personal | all; brokerages omitted), `test=1` when shown,
 * `plan` (comma-separated tiers), `q`, `sort` / `dir` (defaults omitted).
 */
export function parseOrgListState(params: ParamRecord): OrgListState {
  const type = readFirst(params.type);
  return {
    type: (ORG_TYPE_FILTERS as readonly string[]).includes(type) ? (type as OrgTypeFilter) : 'brokerages',
    showTest: readFirst(params.test) === '1',
    plan: readList(params.plan),
    q: readFirst(params.q),
    sort: readSort(params, ORG_SORT_OPTIONS),
  };
}

/** Writes the state onto `params` (the current ones) and returns it. Params it does not own are kept. */
export function writeOrgListState(params: URLSearchParams, state: OrgListState): URLSearchParams {
  writeParam(params, 'type', state.type === 'brokerages' ? '' : state.type);
  writeParam(params, 'test', state.showTest ? '1' : '');
  writeParam(params, 'plan', state.plan.join(','));
  writeParam(params, 'q', state.q);
  writeSort(params, state.sort, ORG_SORT_OPTIONS);
  return params;
}

/** Module-level so its `write` keeps one identity (useReportUrlState's effect depends on it). */
export const ORG_LIST_CODEC: UrlStateCodec<OrgListState> = {
  parse: (params) => parseOrgListState(Object.fromEntries(params.entries())),
  write: writeOrgListState,
};
