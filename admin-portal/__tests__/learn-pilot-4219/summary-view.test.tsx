// @vitest-environment jsdom

/**
 * BACKLOG-4219: the Learn pilot summary table, rendered in jsdom from the transcribed capture
 * (fixtures.ts) through the page's buildViewModel. Headers, cells, search, sorting, the details
 * dialog (opened by row KEY, never by array index: SR A3), and the same user in two orgs (A9).
 * Rows-fix (founder ruling pm_comments e78e0311): the whole row opens the dialog by mouse, Enter or
 * Space; focus returns to the row on close; "View user" is the only link in the dialog.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  __esModule: true,
  // forwardRef: @keepr/ui Button asChild (Radix Slot) passes a ref to the link (SR A5).
  default: React.forwardRef<HTMLAnchorElement, { children: React.ReactNode; href: string }>(({ children, href, ...rest }, ref) => (
    <a ref={ref} href={href} {...rest}>
      {children}
    </a>
  )),
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
const rowIds = () => summaryRows().map((tr) => tr.dataset.userId);
const rowOf = (id: string) => summaryRows().find((tr) => tr.dataset.userId === id)!;
const dialogUserId = () => within(screen.getByRole('dialog')).getByTestId('pilot-dialog-title').getAttribute('data-user-id');
const escape = () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const search = (q: string) => fireEvent.change(screen.getByLabelText(SEARCH_LABEL), { target: { value: q } });
const sortBy = (label: string) => fireEvent.click(within(screen.getByRole('columnheader', { name: new RegExp(`^${label}`) })).getByRole('button'));
const openRow = (tr: HTMLElement) => {
  fireEvent.click(tr.querySelector('[data-cell="org"]')!);
  return screen.getByRole('dialog');
};

describe('the table', () => {
  it('column headers, with "Known wrong" (never "Wrong finds")', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'Name',
      'Org',
      'Rules version',
      'Deals found',
      'Deals found incl. Yes',
      'Shown deals that are real',
      'Known wrong',
      'Last report',
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
    const tr = rowOf(USER_10);
    expect(cell(tr, 'name')).toBe('Pat Ten');
    expect(cell(tr, 'org')).toBe('P4219 X');
    expect(cell(tr, 'version')).toBe('v1Released, bundled');
    expect(cell(tr, 'recall')).toBe('66.7% · 2/3');
    expect(cell(tr, 'known-wrong')).toBe('3');
    expect(cell(tr, 'last-report')).toBe('Nov 11, 2026');
  });

  it('a user with no name: "Unnamed user" plus the short id, never blank', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const tr = rowOf(USER_13);
    expect(cell(tr, 'name')).toBe(`Unnamed user · ${USER_13.slice(0, 8)}`);
    expect(tr.getAttribute('aria-label')).toBe(`Open report for Unnamed user ${USER_13.slice(0, 8)}`);
  });

  it('no Keepr user id column and no Details column (founder ruling)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    expect(document.querySelector('[data-cell="user-id"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Details/ })).toBeNull();
  });

  it('every row is focusable and holds no interactive element (A4)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    expect(summaryRows()).toHaveLength(3);
    for (const tr of summaryRows()) {
      expect(tr.tabIndex).toBe(0);
      expect(tr.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0);
    }
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

  it('Clear search is not the ghost variant: it sets its own text colour (A4)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    search('nobody here');
    const b = within(screen.getByTestId('pilot-summary-no-match')).getByRole('button', { name: 'Clear search' });
    expect(b.className.split(/\s+/)).toContain('text-foreground');
  });
});

describe('table semantics and filter bar', () => {
  it('the table has an accessible name (sr-only caption)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    expect(screen.getByRole('table', { name: 'Pilot users, one row each' })).toBeTruthy();
  });

  it('each name cell is a row header', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const headers = screen.getAllByRole('rowheader');
    expect(headers).toHaveLength(3);
    for (const tr of summaryRows()) {
      expect(within(tr).getByRole('rowheader').textContent).toBe(cell(tr, 'name'));
    }
  });

  it('a whitespace-only search is not a filter: no Clear search button, every row shown', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    search('   ');
    expect(screen.queryAllByRole('button', { name: 'Clear search' })).toHaveLength(0);
    expect(summaryRows()).toHaveLength(3);
    search('p4219 z');
    expect(screen.getAllByRole('button', { name: 'Clear search' })).toHaveLength(1);
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
    const u13 = summaryRows().filter((tr) => tr.dataset.userId === USER_13);
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
    const dialog = openRow(rowOf(USER_6));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"View user" is the only link, to /dashboard/users/<id>, for every user (A3)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    for (const id of [USER_6, USER_10, USER_13]) {
      openRow(rowOf(id));
      const links = within(screen.getByRole('dialog')).getAllByRole('link');
      expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([['View user', `/dashboard/users/${id}`]]);
      escape();
    }
  });
});

describe('keyboard', () => {
  it('Enter on a focused row opens that row', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    for (const id of [USER_6, USER_10, USER_13]) {
      fireEvent.keyDown(rowOf(id), { key: 'Enter' });
      expect(dialogUserId()).toBe(id);
      escape();
    }
  });

  it('Space on a focused row opens that row and prevents page scroll (A2)', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    for (const id of [USER_6, USER_10, USER_13]) {
      expect(fireEvent.keyDown(rowOf(id), { key: ' ' })).toBe(false);
      expect(dialogUserId()).toBe(id);
      escape();
    }
  });

  it('other keys do nothing', () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    fireEvent.keyDown(rowOf(USER_6), { key: 'a' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focus returns to the row when the dialog closes (A1)', async () => {
    render(<LearnPilotView model={fromRows(baseRows())} />);
    const tr = rowOf(USER_10);
    tr.focus();
    fireEvent.keyDown(tr, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    escape();
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(rowOf(USER_10));
  });
});
