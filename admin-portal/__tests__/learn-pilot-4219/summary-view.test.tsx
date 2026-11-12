// @vitest-environment jsdom

/**
 * BACKLOG-4219: the Learn pilot summary table, rendered in jsdom from the transcribed capture
 * (fixtures.ts) through the page's buildViewModel. Headers, cells, search, sorting, the details
 * dialog (opened by row KEY, never by array index: SR A3), and the same user in two orgs (A9).
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LearnPilotView, NO_MATCH_TEXT, SEARCH_LABEL } from '@/app/dashboard/ai/learn-pilot/LearnPilotView';
import { buildViewModel } from '@/lib/learn-pilot/group';
import { parseAdminList } from '@/lib/learn-pilot/parse';
import { ADMIN_LIST, ORG_X, USER_10, USER_13, USER_6, clone } from './fixtures';

afterEach(cleanup);

type Row = (typeof ADMIN_LIST)['rows'][number] & Record<string, unknown>;
const fromRows = (rows: Row[]) => buildViewModel(parseAdminList({ rows, truncated: false }, null));
const baseRows = (): Row[] => clone(ADMIN_LIST).rows as Row[];
const summaryRows = () => screen.getAllByTestId('pilot-summary-row');
const cell = (tr: HTMLElement, name: string) => tr.querySelector(`[data-cell="${name}"]`)!.textContent;
const rowIds = () => summaryRows().map((tr) => cell(tr, 'user-id'));
const search = (q: string) => fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: q } });
const sortBy = (label: string) => fireEvent.click(within(screen.getByRole('columnheader', { name: new RegExp(`^${label}`) })).getByRole('button'));
const openRow = (tr: HTMLElement) => {
  fireEvent.click(within(tr).getByRole('button', { name: /^Details for / }));
  return screen.getByRole('dialog');
};

describe('the table', () => {
  it('column headers, with "Known wrong" (never "Wrong finds")', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'Name',
      'Keepr user id',
      'Org',
      'Rules version',
      'Deals found',
      'Deals found incl. Yes',
      'Shown deals that are real',
      'Known wrong',
      'Last report',
      'Details',
    ]);
    expect(screen.queryByText(/Wrong finds/)).toBeNull();
  });

  it('default order: newest report first, tie by name with no name last; count line', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    expect(rowIds()).toEqual([USER_6, USER_13, USER_10]);
    expect(screen.getByRole('status').textContent).toBe('Showing 3 of 3');
    expect(screen.getByRole('columnheader', { name: /^Last report/ }).getAttribute('aria-sort')).toBe('descending');
  });

  it('USER_10 row: v1 (newest submitted), its mark and date, the v1 scores', () => {
    const rows = baseRows();
    const v1 = rows.find((r) => r.user_id === USER_10 && r.submitted_at.includes('18:43'))!;
    const v2 = rows.find((r) => r.user_id === USER_10 && r.submitted_at.includes('18:33'))!;
    v1.report = { ...v1.report, recall: { k: 2, n: 3 }, known_wrong: 3 };
    v2.report = { ...v2.report, recall: { k: 1, n: 4 }, known_wrong: 8 };
    render(<LearnPilotView model={fromRows(rows)} />);
    const tr = summaryRows().find((r) => cell(r, 'user-id') === USER_10)!;
    expect(cell(tr, 'name')).toBe('Pat Ten');
    expect(cell(tr, 'org')).toBe('P4219 X');
    expect(cell(tr, 'version')).toBe('v1Released, bundled');
    expect(cell(tr, 'recall')).toBe('66.7% · 2/3');
    expect(cell(tr, 'known-wrong')).toBe('3');
    expect(cell(tr, 'last-report')).toBe('Nov 11, 2026');
    expect(tr.querySelector('[data-cell="user-id"] a')!.getAttribute('href')).toBe(`/dashboard/users/${USER_10}`);
  });

  it('a user with no name: blank name cell, id still shown', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const tr = summaryRows().find((r) => cell(r, 'user-id') === USER_13)!;
    expect(cell(tr, 'name')).toBe('');
    expect(within(tr).getByRole('button', { name: `Details for ${USER_13}` })).toBeTruthy();
  });
});

describe('search', () => {
  it('trimmed, case-insensitive org match; count line follows', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    search('  p4219 Z  ');
    expect(rowIds()).toEqual([USER_13]);
    expect(screen.getByRole('status').textContent).toBe('Showing 1 of 3');
  });

  it('no match: the empty state under the kept header; Clear search brings every row back', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    search('nobody here');
    expect(screen.queryAllByTestId('pilot-summary-row')).toHaveLength(0);
    expect(screen.getByTestId('pilot-summary-no-match').textContent).toContain(NO_MATCH_TEXT);
    expect(screen.getByRole('columnheader', { name: /^Name/ })).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('pilot-summary-no-match')).getByRole('button', { name: 'Clear search' }));
    expect(summaryRows()).toHaveLength(3);
  });
});

describe('the details dialog', () => {
  it('opens the row it was clicked on after sorting and filtering, by key not position (A3)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    search('p4219 x');
    sortBy('Name');
    sortBy('Name');
    expect(rowIds()).toEqual([USER_10, USER_6]);
    const dialog = openRow(summaryRows()[0]);
    expect(within(dialog).getByTestId('pilot-dialog-title').getAttribute('data-user-id')).toBe(USER_10);
    expect(within(dialog).getByTestId('pilot-dialog-title').textContent).toBe(`Pat Ten · ${USER_10}`);
    expect(within(dialog).getByTestId('pilot-user-id').textContent).toBe(USER_10);
  });

  it('the same user in two orgs: each row opens its own org (A9)', () => {
    const rows = baseRows();
    const copy = clone(rows.find((r) => r.user_id === USER_13)!);
    copy.org_id = ORG_X;
    copy.org_name = 'P4219 X';
    copy.org_current_pin_version = 5;
    copy.org_current_pin_at = '2026-11-11T18:50:02.172359+00:00';
    render(<LearnPilotView model={fromRows([...rows, copy])} />);
    const u13 = summaryRows().filter((tr) => cell(tr, 'user-id') === USER_13);
    expect(u13).toHaveLength(2);
    for (const org of ['P4219 Z', 'P4219 X']) {
      const tr = u13.find((r) => cell(r, 'org') === org)!;
      const dialog = openRow(tr);
      expect(within(dialog).getByTestId('pilot-org-pin').textContent).toBe(org === 'P4219 Z' ? 'On the released rules.' : 'Testing v5 since Nov 11, 2026.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  });

  it('Escape closes it', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const dialog = openRow(summaryRows().find((r) => cell(r, 'user-id') === USER_6)!);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
