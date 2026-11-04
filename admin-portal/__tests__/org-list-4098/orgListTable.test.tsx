// @vitest-environment jsdom

/**
 * BACKLOG-4098 PR2: the Organizations table (toolbar, count, sort headers, URL state, empty states,
 * flags-missing notice). Fixtures invented; tier, member count and the personal flag disagree on
 * purpose (see orgList.test.ts).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/organizations',
  useSearchParams: () => new URLSearchParams(),
}));

import { OrganizationsTable, type OrganizationRow } from '@/app/dashboard/organizations/components/OrganizationsTable';
import { DEFAULT_ORG_LIST_STATE, type OrgListState } from '@/lib/organizations/org-list';

const row = (o: Partial<OrganizationRow> & Pick<OrganizationRow, 'id' | 'name'>): OrganizationRow => ({
  slug: o.name.toLowerCase().replace(/\s+/g, '-'),
  plan_name: 'Team',
  plan_tier: 'team',
  created_at: '2026-01-01T00:00:00Z',
  member_count: 3,
  is_personal: false,
  is_test: false,
  ...o,
});

const ROWS: OrganizationRow[] = [
  row({ id: 'b1', name: 'alpha brokerage', member_count: 1 }),
  row({ id: 'p2', name: 'Bravo personal', member_count: 2, is_personal: true }),
  row({ id: 'ind', name: 'Charlie group', plan_name: 'Individual', plan_tier: 'individual', member_count: 0 }),
  row({ id: 'tb', name: 'Delta test brokerage', plan_name: 'Enterprise', plan_tier: 'enterprise', member_count: 9, is_test: true }),
  row({ id: 'tp', name: 'Echo sandbox', plan_name: 'Individual', plan_tier: 'individual', member_count: 1, is_personal: true, is_test: true }),
  row({ id: 'np', name: 'Foxtrot homes', plan_name: null, plan_tier: null, member_count: 5 }),
];

const NO_FLAGS: OrganizationRow[] = ROWS.map(({ is_personal: _p, is_test: _t, ...r }) => r);

function renderTable(organizations: OrganizationRow[] = ROWS, initialState?: Partial<OrgListState>) {
  return render(
    <OrganizationsTable
      canEdit
      billingLive={false}
      organizations={organizations}
      initialState={initialState ? { ...DEFAULT_ORG_LIST_STATE, ...initialState } : undefined}
    />
  );
}

const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((tr) => within(tr).queryAllByRole('cell')[0]?.textContent?.trim() ?? '')
    .filter(Boolean);
const count = () => screen.getByTestId('org-list-count').textContent;
const showTest = () => screen.getByRole('checkbox', { name: 'Show test organizations' });
const typePill = () => screen.getAllByRole('button', { name: /^Type/ })[0];
const planPill = () => screen.getAllByRole('button', { name: /^Plan/ })[0];
const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard/organizations?foo=1');
});
afterEach(cleanup);

describe('T1 default view and the "shown of total" count', () => {
  it('shows non-test brokerages only, including the 1-member one, and says how many of all', () => {
    renderTable();
    expect(names()).toEqual(['alpha brokerage', 'Charlie group', 'Foxtrot homes']);
    expect(count()).toBe('3 of 6 organizations');
    expect(typePill()).toHaveProperty('textContent', expect.stringContaining('Brokerages'));
    expect(showTest().getAttribute('aria-checked')).toBe('false');
  });

  it('the count changes with the filters', () => {
    renderTable();
    fireEvent.click(showTest());
    expect(count()).toBe('4 of 6 organizations');
    expect(names()).toContain('Delta test brokerage');
  });
});

describe('T2 Type dropdown', () => {
  it('Personal shows the 2-member personal org, not the 1-member brokerage', () => {
    renderTable();
    fireEvent.click(typePill());
    fireEvent.click(screen.getByRole('option', { name: 'Personal' }));
    expect(names()).toEqual(['Bravo personal']);
    expect(count()).toBe('1 of 6 organizations');
  });
});

describe('T3 Plan dropdown', () => {
  it('options come from all rows, even ones the current filters hide', () => {
    renderTable(ROWS, { type: 'personal' });
    fireEvent.click(planPill());
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual(['Enterprise', 'Individual', 'Team']);
  });

  it('picking plans filters; clearing shows every row again', () => {
    renderTable(ROWS, { type: 'all', showTest: true });
    fireEvent.click(planPill());
    fireEvent.click(screen.getByRole('option', { name: 'Individual' }));
    expect(names()).toEqual(['Charlie group', 'Echo sandbox']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Plan filter' }));
    expect(count()).toBe('6 of 6 organizations');
  });
});

describe('T4 sortable headers', () => {
  it('Members opens descending, a second click flips it', () => {
    renderTable(ROWS, { type: 'all', showTest: true });
    fireEvent.click(within(header('Members')).getByRole('button'));
    expect(header('Members').getAttribute('aria-sort')).toBe('descending');
    expect(header('Name').getAttribute('aria-sort')).toBe('none');
    expect(names()).toEqual(['Delta test brokerage', 'Foxtrot homes', 'Bravo personal', 'alpha brokerage', 'Echo sandbox', 'Charlie group']);
    fireEvent.click(within(header('Members')).getByRole('button'));
    expect(header('Members').getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['Charlie group', 'alpha brokerage', 'Echo sandbox', 'Bravo personal', 'Foxtrot homes', 'Delta test brokerage']);
  });

  it('sortable headers carry the design-system Th look; Slug and Actions stay plain', () => {
    renderTable();
    for (const name of ['Name', 'Plan', 'Members', 'Created']) {
      const cls = header(name).className.split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(['px-6', 'py-3', 'text-xs', 'uppercase', 'tracking-wider']));
      expect(cls).not.toContain('px-3');
      expect(cls).not.toContain('py-2');
    }
    expect(header('Slug').className).toContain('uppercase');
  });
});

describe('T6 URL state', () => {
  it('first render comes from initialState', () => {
    renderTable(ROWS, { type: 'all', q: 'echo', showTest: true });
    expect(names()).toEqual(['Echo sandbox']);
    expect((screen.getByPlaceholderText('Filter by name or slug...') as HTMLInputElement).value).toBe('echo');
  });

  it('defaults write nothing; changes write their params and keep unrelated ones', async () => {
    renderTable();
    await act(async () => {});
    expect(window.location.search).toBe('?foo=1');

    fireEvent.click(showTest());
    await act(async () => {});
    let p = new URLSearchParams(window.location.search);
    expect(p.get('foo')).toBe('1');
    expect(p.get('test')).toBe('1');

    fireEvent.click(within(header('Members')).getByRole('button'));
    await act(async () => {});
    p = new URLSearchParams(window.location.search);
    expect(p.get('sort')).toBe('members');
    expect(p.get('foo')).toBe('1');
    expect(p.get('test')).toBe('1');

    fireEvent.change(screen.getByPlaceholderText('Filter by name or slug...'), { target: { value: 'delta' } });
    await act(async () => {});
    p = new URLSearchParams(window.location.search);
    expect(p.get('q')).toBe('delta');
    expect(p.get('foo')).toBe('1');
  });
});

describe('T7 flags missing', () => {
  it('every row is shown, Type and test controls are disabled, a notice explains why', () => {
    renderTable(NO_FLAGS);
    expect(count()).toBe('6 of 6 organizations');
    expect(screen.getByRole('note').textContent).toMatch(/Type and test filters are unavailable/);
    expect((typePill() as HTMLButtonElement).disabled).toBe(true);
    expect((showTest() as HTMLButtonElement).disabled).toBe(true);
  });

  it('one row missing a flag is enough', () => {
    renderTable(ROWS.map((r, i) => (i === 0 ? { ...r, is_test: null } : r)));
    expect(count()).toBe('6 of 6 organizations');
    expect(screen.getByRole('note')).toBeTruthy();
  });

  it('with flags, no notice and the controls are enabled', () => {
    renderTable();
    expect(screen.queryByRole('note')).toBeNull();
    expect((typePill() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('T8 empty states', () => {
  it('no organizations at all', () => {
    renderTable([]);
    expect(screen.getByText('No organizations found.')).toBeTruthy();
  });

  it('a search with no match names the search', () => {
    renderTable(ROWS, { q: 'zzz' });
    expect(screen.getByText("No organizations match 'zzz'")).toBeTruthy();
  });

  it('filters with no match (no search) say filters, not search', () => {
    renderTable(ROWS, { type: 'personal', plan: ['enterprise'] });
    expect(screen.getByText('No organizations match these filters.')).toBeTruthy();
    expect(screen.queryByText(/match ''/)).toBeNull();
  });

  it('Show all organizations clears type, test, plan and search together', () => {
    renderTable(ROWS, { type: 'personal', plan: ['enterprise'], q: 'delta' });
    expect(count()).toBe('0 of 6 organizations');
    fireEvent.click(screen.getByRole('button', { name: 'Show all organizations' }));
    expect(count()).toBe('6 of 6 organizations');
    expect(names()).toHaveLength(6);
    expect((screen.getByPlaceholderText('Filter by name or slug...') as HTMLInputElement).value).toBe('');
    expect(showTest().getAttribute('aria-checked')).toBe('true');
  });
});

describe('phone layout: the toolbar row still wraps', () => {
  it('Create Organization sits in the wrapping row', () => {
    renderTable();
    const cls = screen.getByRole('button', { name: /Create Organization/ }).parentElement!.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-3', 'max-md:flex-wrap']));
  });
});
