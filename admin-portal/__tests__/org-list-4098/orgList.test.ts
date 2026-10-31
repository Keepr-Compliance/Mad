/**
 * BACKLOG-4098 PR2: pure list rules (lib/organizations/org-list.ts).
 *
 * Fixtures are invented. Tier and personal deliberately DISAGREE (in prod they line up), and the
 * member count does not predict the flag either: a 1-member brokerage, a 2-member personal org,
 * and an "individual"-tier org that is not personal. So a flag derived from member_count or from
 * plan_tier picks the wrong rows.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORG_LIST_STATE,
  ORG_LIST_CODEC,
  filterOrgs,
  flagsAvailable,
  parseOrgListState,
  planOptions,
  showAllState,
  sortAfterClick,
  sortOrgs,
  writeOrgListState,
  type OrgListRow,
  type OrgListState,
} from '@/lib/organizations/org-list';

const row = (o: Partial<OrgListRow> & Pick<OrgListRow, 'id' | 'name'>): OrgListRow => ({
  slug: o.name.toLowerCase().replace(/\s+/g, '-'),
  plan_name: 'Team',
  plan_tier: 'team',
  created_at: '2026-01-01T00:00:00Z',
  member_count: 3,
  is_personal: false,
  is_test: false,
  ...o,
});

const ROWS: OrgListRow[] = [
  // non-test brokerage with ONE member, team tier
  row({ id: 'b1', name: 'alpha brokerage', member_count: 1, created_at: '2026-03-01T00:00:00Z' }),
  // personal org with TWO members, team tier
  row({ id: 'p2', name: 'Bravo personal', slug: 'bravo-home', member_count: 2, is_personal: true, created_at: '2026-02-01T00:00:00Z' }),
  // non-personal org on the individual tier, 0 members
  row({ id: 'ind', name: 'Charlie group', plan_name: 'Individual', plan_tier: 'individual', member_count: 0, created_at: '2026-01-15T00:00:00Z' }),
  // test brokerage, enterprise
  row({ id: 'tb', name: 'Delta test brokerage', plan_name: 'Enterprise', plan_tier: 'enterprise', member_count: 9, is_test: true }),
  // personal test org on the individual tier, 1 member
  row({ id: 'tp', name: 'Echo sandbox', plan_name: 'Individual', plan_tier: 'individual', member_count: 1, is_personal: true, is_test: true, created_at: null }),
  // non-test brokerage with no plan, mixed-case name
  row({ id: 'np', name: 'Foxtrot homes', slug: 'fox', plan_name: null, plan_tier: null, member_count: 5, created_at: '2025-06-01T00:00:00Z' }),
];

const ids = (rows: OrgListRow[]) => rows.map((r) => r.id);
const S = (o: Partial<OrgListState> = {}): OrgListState => ({ ...DEFAULT_ORG_LIST_STATE, ...o });
const filtered = (o: Partial<OrgListState> = {}, rows = ROWS) => ids(filterOrgs(rows, S(o), flagsAvailable(rows)));

describe('T1 default view: brokerages that are not test orgs', () => {
  it('defaults are brokerages, test hidden, no plan, no search, name asc', () => {
    expect(DEFAULT_ORG_LIST_STATE).toEqual({
      type: 'brokerages', showTest: false, plan: [], q: '', sort: { key: 'name', direction: 'asc' },
    });
  });

  it('shows the 1-member brokerage and the individual-tier brokerage; hides personal and test orgs', () => {
    expect(filtered()).toEqual(['b1', 'ind', 'np']);
  });

  it('Show test organizations adds the test brokerage only', () => {
    expect(filtered({ showTest: true })).toEqual(['b1', 'ind', 'tb', 'np']);
  });
});

describe('T2 type filter reads is_personal, not tier or member count', () => {
  it('personal = the 2-member personal org (test one hidden)', () => {
    expect(filtered({ type: 'personal' })).toEqual(['p2']);
    expect(filtered({ type: 'personal', showTest: true })).toEqual(['p2', 'tp']);
  });

  it('all = every non-test org; with test on, every org', () => {
    expect(filtered({ type: 'all' })).toEqual(['b1', 'p2', 'ind', 'np']);
    expect(filtered({ type: 'all', showTest: true })).toEqual(ids(ROWS));
  });
});

describe('T3 plan filter', () => {
  it('an empty selection filters nothing', () => {
    expect(filtered({ type: 'all', showTest: true, plan: [] })).toHaveLength(ROWS.length);
  });

  it('several tiers are OR-ed; a row with no plan is excluded while any plan is picked', () => {
    expect(filtered({ type: 'all', showTest: true, plan: ['individual', 'enterprise'] })).toEqual(['ind', 'tb', 'tp']);
    expect(filtered({ type: 'all', showTest: true, plan: ['team'] })).toEqual(['b1', 'p2']);
  });

  it('options come from ALL rows, one per tier, labelled by plan name', () => {
    expect(planOptions(ROWS)).toEqual([
      { value: 'enterprise', label: 'Enterprise' },
      { value: 'individual', label: 'Individual' },
      { value: 'team', label: 'Team' },
    ]);
  });
});

describe('T4 sort', () => {
  const frozen = Object.freeze([...ROWS]) as readonly OrgListRow[];

  it('returns a sorted copy and never sorts its input in place', () => {
    const out = sortOrgs(frozen, { key: 'members', direction: 'desc' });
    expect(out).not.toBe(frozen);
    expect(ids(frozen as OrgListRow[])).toEqual(['b1', 'p2', 'ind', 'tb', 'tp', 'np']);
  });

  it('name compares case-insensitively', () => {
    expect(ids(sortOrgs(frozen, { key: 'name', direction: 'asc' }))).toEqual(['b1', 'p2', 'ind', 'tb', 'tp', 'np']);
    expect(ids(sortOrgs(frozen, { key: 'name', direction: 'desc' }))).toEqual(['np', 'tp', 'tb', 'ind', 'p2', 'b1']);
  });

  it('members desc then asc; ties fall back to name', () => {
    expect(ids(sortOrgs(frozen, { key: 'members', direction: 'desc' }))).toEqual(['tb', 'np', 'p2', 'b1', 'tp', 'ind']);
    expect(ids(sortOrgs(frozen, { key: 'members', direction: 'asc' }))).toEqual(['ind', 'b1', 'tp', 'p2', 'np', 'tb']);
  });

  it('missing plan and missing created date sort last in both directions', () => {
    expect(ids(sortOrgs(frozen, { key: 'plan', direction: 'asc' })).at(-1)).toBe('np');
    expect(ids(sortOrgs(frozen, { key: 'plan', direction: 'desc' })).at(-1)).toBe('np');
    expect(ids(sortOrgs(frozen, { key: 'created', direction: 'desc' }))).toEqual(['b1', 'p2', 'ind', 'tb', 'np', 'tp']);
    expect(ids(sortOrgs(frozen, { key: 'created', direction: 'asc' }))).toEqual(['np', 'tb', 'ind', 'p2', 'b1', 'tp']);
  });

  it('clicking the active column flips it; another column opens in its own default direction', () => {
    let s = S();
    s = sortAfterClick(s, 'name');
    expect(s.sort).toEqual({ key: 'name', direction: 'desc' });
    s = sortAfterClick(s, 'members');
    expect(s.sort).toEqual({ key: 'members', direction: 'desc' });
    s = sortAfterClick(s, 'plan');
    expect(s.sort).toEqual({ key: 'plan', direction: 'asc' });
  });
});

describe('T5 search', () => {
  it('matches name or slug, case-insensitive, trimmed', () => {
    expect(filtered({ type: 'all', showTest: true, q: '  ALPHA ' })).toEqual(['b1']);
    expect(filtered({ type: 'all', showTest: true, q: 'bravo-home' })).toEqual(['p2']);
    expect(filtered({ type: 'all', showTest: true, q: 'fox' })).toEqual(['np']);
  });

  it('does not match the plan name', () => {
    expect(filtered({ type: 'all', showTest: true, q: 'enterprise' })).toEqual([]);
  });

  it('applies on top of the default filters', () => {
    expect(filtered({ q: 'bravo' })).toEqual([]);
  });
});

describe('T6 URL codec', () => {
  it('the default state writes nothing and keeps params it does not own', () => {
    const p = writeOrgListState(new URLSearchParams('foo=1&type=all&test=1&plan=team&q=x&sort=members&dir=asc'), S());
    expect(p.toString()).toBe('foo=1');
  });

  it('writes every field and round-trips', () => {
    const state = S({ type: 'personal', showTest: true, plan: ['team', 'individual'], q: 'a b', sort: { key: 'members', direction: 'asc' } });
    const p = ORG_LIST_CODEC.write(new URLSearchParams('foo=1'), state);
    expect(p.get('foo')).toBe('1');
    expect(p.get('type')).toBe('personal');
    expect(p.get('test')).toBe('1');
    expect(p.get('plan')).toBe('team,individual');
    expect(p.get('q')).toBe('a b');
    expect(p.get('sort')).toBe('members');
    expect(p.get('dir')).toBe('asc');
    expect(ORG_LIST_CODEC.parse(p)).toEqual(state);
  });

  it('a default-direction sort on a non-default key writes only sort', () => {
    const p = writeOrgListState(new URLSearchParams(), S({ sort: { key: 'created', direction: 'desc' } }));
    expect(p.toString()).toBe('sort=created');
  });

  it('server parse: empty record is the default; unknown values fall back', () => {
    expect(parseOrgListState({})).toEqual(DEFAULT_ORG_LIST_STATE);
    expect(parseOrgListState({ type: 'bogus', test: 'yes', sort: 'nope', dir: 'sideways' })).toEqual(DEFAULT_ORG_LIST_STATE);
    expect(parseOrgListState({ type: ['all', 'personal'], test: '1', plan: 'team,,team', q: 'x', sort: 'created' })).toEqual(
      S({ type: 'all', showTest: true, plan: ['team'], q: 'x', sort: { key: 'created', direction: 'desc' } })
    );
  });
});

describe('T7 flags missing', () => {
  const missing = ROWS.map((r, i) => (i === 2 ? { ...r, is_personal: undefined } : r));

  it('any row without a boolean flag makes the whole list flags-missing', () => {
    expect(flagsAvailable(ROWS)).toBe(true);
    expect(flagsAvailable(missing)).toBe(false);
    expect(flagsAvailable(ROWS.map((r) => ({ ...r, is_test: null })))).toBe(false);
    expect(flagsAvailable([])).toBe(true);
  });

  it('flags missing: type and test filters are skipped, every row shown; plan and search still apply', () => {
    expect(filtered({}, missing)).toEqual(ids(missing));
    expect(filtered({ plan: ['enterprise'] }, missing)).toEqual(['tb']);
    expect(filtered({ q: 'echo' }, missing)).toEqual(['tp']);
  });
});

describe('T8 Show all organizations', () => {
  it('turns every filter off and clears search together, keeping the sort', () => {
    const before = S({ type: 'personal', showTest: false, plan: ['team'], q: 'zzz', sort: { key: 'members', direction: 'asc' } });
    expect(showAllState(before)).toEqual(S({ type: 'all', showTest: true, plan: [], q: '', sort: { key: 'members', direction: 'asc' } }));
    expect(filtered(showAllState(before))).toEqual(ids(ROWS));
  });
});
