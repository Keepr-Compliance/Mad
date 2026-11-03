// @vitest-environment jsdom
/**
 * User Activity report: the Organization filter is the kit Dropdown in multi mode (BACKLOG-4085).
 *
 * O1 kit contract, O2 search narrows and a pick narrows the rows, O3 clearing the
 * Organization filter leaves the other filters applied, O6 the bar's Clear filters
 * and the parent's filters drive the pill (no local copy), W7 clearing the
 * Organization filter goes through updateFilters (the shown-row count resets).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildUserActivityReport, INITIAL_VISIBLE_USERS } from '@/lib/reports/user-activity';
import type { ActivityMembershipRow, ActivityUserRow } from '@/lib/reports/user-activity';
import {
  ALICE,
  BOB,
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  ORG_A,
  ORGS,
  STAFF_IDS,
  USERS,
} from '@/lib/reports/__tests__/user-activity.fixture';
import { UserActivityReport } from '../UserActivityReport';

afterEach(cleanup);

function mount(users: ActivityUserRow[] = USERS, memberships: ActivityMembershipRow[] = MEMBERSHIPS) {
  const report = buildUserActivityReport({
    users,
    devices: DEVICES,
    events: EVENTS,
    memberships,
    orgs: ORGS,
    staffIds: STAFF_IDS,
  });
  return render(<UserActivityReport report={report} period={LAST_WEEK} rowCap={20000} />);
}

const rowIds = () =>
  [...document.querySelectorAll('[data-user-row]')].map((el) => el.getAttribute('data-user-row'));
const orgTrigger = () => screen.getAllByRole('button', { name: /^Organization/ })[0];
const orgListbox = () => screen.getByRole('listbox', { name: 'Organization' });
const orgOption = (name: string) => within(orgListbox()).getByRole('option', { name });

function openOrg() {
  if (!screen.queryByRole('listbox', { name: 'Organization' })) fireEvent.click(orgTrigger());
}

function pickOrg(name: string) {
  openOrg();
  fireEvent.click(orgOption(name));
}

describe('O1 the Organization filter is the kit multi Dropdown', () => {
  it('opens a multiselectable listbox with a search box, filter variant', () => {
    mount();
    fireEvent.click(orgTrigger());
    expect(orgListbox().getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Search Organization' })).toBeTruthy();
    expect(orgTrigger().closest('[data-slot="dropdown"]')?.getAttribute('data-variant')).toBe('filter');
  });
});

describe('O2 search narrows the list; a pick narrows the rows', () => {
  it('Beta Homes via search leaves only Bob', () => {
    mount();
    expect(rowIds()).toHaveLength(3);
    openOrg();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Organization' }), { target: { value: 'beta' } });
    expect(within(orgListbox()).getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Beta Homes']);
    fireEvent.click(orgOption('Beta Homes'));
    expect(orgOption('Beta Homes').getAttribute('aria-selected')).toBe('true');
    expect(orgTrigger().textContent).toContain('Organization (1)');
    expect(rowIds()).toEqual([BOB]);
  });
});

describe('O3 clearing Organization keeps the other filters', () => {
  it('the search for alice stays applied after the Organization clear X', () => {
    mount();
    pickOrg('Beta Homes');
    fireEvent.change(screen.getByLabelText('Search by name or email'), { target: { value: 'alice' } });
    expect(rowIds()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear Organization filter' }));
    expect(orgTrigger().textContent).toBe('Organization');
    expect((screen.getByLabelText('Search by name or email') as HTMLInputElement).value).toBe('alice');
    expect(rowIds()).toEqual([ALICE]);
  });
});

describe('O7 picking Organization keeps a filter set before it', () => {
  it('search alice first, then Acme Realty: both apply (Acme alone is Alice and Bob)', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Search by name or email'), { target: { value: 'alice' } });
    expect(rowIds()).toEqual([ALICE]);

    pickOrg('Acme Realty');
    expect(orgTrigger().textContent).toContain('Organization (1)');
    expect((screen.getByLabelText('Search by name or email') as HTMLInputElement).value).toBe('alice');
    expect(rowIds()).toEqual([ALICE]);
  });
});

describe('O6 the pill follows the report filters, not a local copy', () => {
  it('the bar-level Clear filters empties the Organization pill and its rows', () => {
    mount();
    pickOrg('Beta Homes');
    expect(orgTrigger().textContent).toContain('Organization (1)');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(orgTrigger().textContent).toBe('Organization');
    openOrg();
    expect(orgOption('Beta Homes').getAttribute('aria-selected')).toBe('false');
    expect(rowIds()).toHaveLength(3);
  });
});

describe('W7 the Organization clear resets the shown-row count', () => {
  // 30 extra users in Acme Realty, generic names, all-zero-prefix ids.
  const extraUsers: ActivityUserRow[] = Array.from({ length: 30 }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(5000 + i).padStart(12, '0')}`,
    email: `member${i}@example.test`,
    display_name: `Member ${i}`,
    first_name: null,
    last_name: null,
    last_login_at: null,
  }));
  const extraMemberships: ActivityMembershipRow[] = extraUsers.map((u, i) => ({
    id: `00000000-0000-0000-0000-${String(6000 + i).padStart(12, '0')}`,
    user_id: u.id,
    organization_id: ORG_A,
  }));

  it('after Show more, clearing Organization shows the first page again', () => {
    mount([...USERS, ...extraUsers], [...MEMBERSHIPS, ...extraMemberships]);
    pickOrg('Acme Realty');
    expect(rowIds()).toHaveLength(INITIAL_VISIBLE_USERS);
    fireEvent.click(screen.getByRole('button', { name: /^Show \d+ more$/ }));
    // Alice, Bob and the 30 members.
    expect(rowIds()).toHaveLength(32);

    fireEvent.click(screen.getByRole('button', { name: 'Clear Organization filter' }));
    expect(rowIds()).toHaveLength(INITIAL_VISIBLE_USERS);
  });
});
