// @vitest-environment jsdom
/**
 * Submissions report: the Organization filter is the kit Dropdown in multi mode (BACKLOG-4085).
 *
 * O1 kit contract, O2 search narrows and a pick narrows the rows, O3 clearing the
 * Organization filter leaves Outcome applied, O6 the bar's Clear filters drives the
 * pill (no local copy). No null-organization fixture: submission_attempts.organization_id
 * is NOT NULL (migration 20261004192647:71), so the producer cannot emit one.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  COMMITTED_POST,
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';

const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

function mount() {
  return render(
    <SubmissionsReport
      report={buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openAttempts={buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW)}
      openCap={200}
      period={THIS_WEEK}
      rowCap={500}
    />
  );
}

const rowIds = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-submission-row]')].map((el) => el.getAttribute('data-submission-row'));
const orgTrigger = () => screen.getAllByRole('button', { name: /^Organization/ })[0];
const orgListbox = () => screen.getByRole('listbox', { name: 'Organization' });
const orgOption = (name: string) => within(orgListbox()).getByRole('option', { name });

function openOrg() {
  if (!screen.queryByRole('listbox', { name: 'Organization' })) fireEvent.click(orgTrigger());
}

function closeOrg() {
  if (screen.queryByRole('listbox', { name: 'Organization' })) fireEvent.click(orgTrigger());
}

function pickOrg(name: string) {
  openOrg();
  fireEvent.click(orgOption(name));
  closeOrg();
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
  it('Office B via search leaves its one submission', () => {
    const { container } = mount();
    expect(rowIds(container)).toHaveLength(10);
    openOrg();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Organization' }), {
      target: { value: 'office b' },
    });
    expect(within(orgListbox()).getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Office B']);
    fireEvent.click(orgOption('Office B'));
    expect(orgOption('Office B').getAttribute('aria-selected')).toBe('true');
    expect(orgTrigger().textContent).toContain('Organization (1)');
    expect(rowIds(container)).toEqual([COMMITTED_POST.submission_id]);
  });
});

describe('O3 clearing Organization keeps the Outcome filter', () => {
  it('Failed stays applied after the Organization clear X', () => {
    const { container } = mount();
    pickOrg('Office B');
    fireEvent.click(screen.getAllByRole('button', { name: /^Outcome/ })[0]);
    fireEvent.click(screen.getByText('Failed', { selector: 'label span' }));
    expect(rowIds(container)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Clear Organization filter' }));
    expect(orgTrigger().textContent).toBe('Organization');
    // FAILED, REFUSED, UNKNOWN_CODES carry status "failed".
    expect(rowIds(container)).toHaveLength(3);
  });
});

describe('O6 the pill follows the report filters, not a local copy', () => {
  it('the bar-level Clear filters empties the Organization pill and its rows', () => {
    const { container } = mount();
    pickOrg('Office B');
    expect(orgTrigger().textContent).toContain('Organization (1)');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(orgTrigger().textContent).toBe('Organization');
    openOrg();
    expect(orgOption('Office B').getAttribute('aria-selected')).toBe('false');
    expect(rowIds(container)).toHaveLength(10);
  });
});
