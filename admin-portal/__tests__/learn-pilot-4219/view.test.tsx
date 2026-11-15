// @vitest-environment jsdom

/**
 * BACKLOG-4219 PR3: the Learn pilot view, rendered from the model the page builds out of the
 * transcribed capture. Each user shows name and Keepr user id (the id links to the user's admin
 * page); a user with no name shows the id alone; no email anywhere (founder ruling 2026-11-11).
 * Since the summary table, each user's full table sits in a dialog opened from its summary row,
 * so these tests open that dialog first.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

import { LearnPilotView, cellText, changeText, EMPTY_TEXT, TRUNCATED_TEXT } from '@/app/dashboard/ai/learn-pilot/LearnPilotView';
import { buildViewModel } from '@/lib/learn-pilot/group';
import { parseAdminList, READ_FAILED_MESSAGE } from '@/lib/learn-pilot/parse';
import { ADMIN_LIST, LIST_MISSING, USER_10, USER_13, USER_6, clone } from './fixtures';

afterEach(cleanup);

const fromList = (list: unknown, error: unknown = null) => buildViewModel(parseAdminList(list, error));
const IDS = [USER_6, USER_10, USER_13];
/** Opens the user's details dialog from the summary table and returns their full table. */
const userById = (id: string) => {
  fireEvent.click(document.querySelector(`[data-testid="pilot-summary-row"][data-user-id="${id}"]`)!);
  return within(screen.getByRole('dialog')).getByTestId('pilot-user');
};
const closeDialog = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));

describe('pilot users: name and Keepr user id, never an email', () => {
  it('each user heading shows the id as plain text; "View user" is the dialog\'s one link, to the admin user page', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    expect(screen.getAllByTestId('pilot-summary-row')).toHaveLength(3);
    for (const id of IDS) {
      const idText = within(userById(id)).getByTestId('pilot-user-id');
      expect(idText.tagName).toBe('SPAN');
      expect(idText.textContent).toBe(id);
      const links = within(screen.getByRole('dialog')).getAllByRole('link');
      expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([['View user', `/dashboard/users/${id}`]]);
      closeDialog();
    }
    expect(within(userById(USER_6)).getByTestId('pilot-user-name').textContent).toBe('P4219 user 6');
    closeDialog();
    expect(within(userById(USER_10)).getByTestId('pilot-user-name').textContent).toBe('Pat Ten');
  });

  it('a user with no name shows the id alone, no placeholder', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    const u13 = userById(USER_13);
    expect(within(u13).queryByTestId('pilot-user-name')).toBeNull();
    expect(u13.querySelector('h3')!.textContent).toBe(USER_13);
  });

  it('no "@" anywhere on the page, with every user\'s dialog opened in turn', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    expect(document.body.textContent).not.toContain('@');
    for (const id of IDS) {
      userById(id);
      expect(document.body.textContent).toContain(id);
      expect(document.body.textContent).not.toContain('@');
      closeDialog();
    }
  });
});

describe('columns, marks and changes', () => {
  it('marks, in version order, for each user', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    const marks = (id: string) => {
      const m = within(userById(id)).getAllByTestId('version-mark').map((x) => x.textContent);
      closeDialog();
      return m;
    };
    expect(marks(USER_6)).toEqual(['Released', 'Test for this org', 'Unknown to the server']);
    expect(marks(USER_10)).toEqual(['Released, bundled', 'Test for another org']);
    expect(marks(USER_13)).toEqual(['Test for another org']);
    expect(within(userById(USER_6)).getAllByTestId('version-column').map((c) => c.firstElementChild?.textContent)).toEqual(['v4', 'v5', 'v999999']);
  });

  it('the org pin line, and the released line for an org with no pin', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    const pins: string[] = [];
    for (const id of [USER_6, USER_13]) {
      userById(id);
      pins.push(screen.getByTestId('pilot-org-pin').textContent ?? '');
      closeDialog();
    }
    expect(pins.sort()).toEqual(['On the released rules.', 'Testing v5 since Nov 11, 2026.']);
  });

  it('the detections change for user 10 shows as -6 under the second column only', () => {
    render(<LearnPilotView model={fromList(clone(ADMIN_LIST))} />);
    const tr = within(userById(USER_10)).getByTestId('metric-detections');
    const cells = within(tr).getAllByTestId('metric-cell');
    expect(cells.map((c) => c.firstElementChild?.textContent)).toEqual(['7', '1']);
    expect(within(cells[0]).queryByTestId('metric-change')).toBeNull();
    expect(within(cells[1]).getByTestId('metric-change').textContent).toBe('−6');
  });

  it('cell and change text', () => {
    expect(cellText({ kind: 'kn', k: 2, n: 3 })).toBe('2/3 · 66.7% (20.8–93.9)');
    expect(cellText({ kind: 'kn', k: 0, n: 0 })).toBe('0/0, no data');
    expect(cellText(null)).toBe('—');
    expect(changeText({ kind: 'kn', dk: 1, dn: 0 })).toBe('+1 / 0');
    expect(changeText(null)).toBeNull();
  });
});

describe('page states', () => {
  it('a failed read: the message, no summary table or rows, not the empty text', () => {
    render(<LearnPilotView model={fromList(null, LIST_MISSING)} />);
    expect(screen.getByTestId('learn-pilot-unreadable').textContent).toContain(READ_FAILED_MESSAGE);
    expect(screen.queryByTestId('pilot-summary-table')).toBeNull();
    expect(screen.queryAllByTestId('pilot-summary-row')).toHaveLength(0);
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it('a readable empty list: the empty text', () => {
    render(<LearnPilotView model={fromList({ rows: [], truncated: false })} />);
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByTestId('pilot-summary-table')).toBeNull();
  });

  it('truncated: the newest-200 note', () => {
    render(<LearnPilotView model={fromList({ ...clone(ADMIN_LIST), truncated: true })} />);
    expect(screen.getByTestId('learn-pilot-truncated').textContent).toBe(TRUNCATED_TEXT);
  });
});
