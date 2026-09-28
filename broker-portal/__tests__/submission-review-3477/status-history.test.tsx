/**
 * Status History — BACKLOG-3477 (rulings 3767e481, founder decision 795ff7c5).
 *
 * Status entries: production shape {notes, status, changed_at, changed_by}.
 * Typed entries: the keys §7 / §8 of
 * 20260925073000_backlog_3477_submission_checklist_review.sql build, with
 * changed_by already resolved to a name (the page does that).
 *
 * LIVE is transcribed from the QA submission's stored status_history (read
 * 2026-09-27): same entry kinds, same key sets, same order and relative
 * timing; ids replaced with invented uuids, names with fixture names.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { StatusHistory } from '@/components/submission/StatusHistory';
import { groupHistory, type StatusHistoryEntry } from '@/lib/submissions/history';

const SUBMITTED_AT = '2026-09-20T15:00:00.000000+00:00';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const history: StatusHistoryEntry[] = [
  { notes: null, status: 'submitted', changed_at: SUBMITTED_AT, changed_by: undefined },
  { notes: null, status: 'under_review', changed_at: '2026-09-20T15:05:00.000000+00:00', changed_by: undefined },
  {
    type: 'checklist_review',
    changed_at: '2026-09-20T15:10:00.000000+00:00',
    changed_by: 'Colleague Fixture',
    field: 'reviewer_checked',
    from: false,
    to: true,
    item_id: 'item-a',
    item_title: 'Title commitment',
    checklist_name: 'Contract',
  },
  {
    type: 'checklist_added',
    changed_at: '2026-09-20T15:12:00.000000+00:00',
    changed_by: 'a former member',
    checklist_id: 'hdr-b',
    checklist_name: 'Lead-Based Paint',
    template_id: 'tpl-b',
  },
];

// --- LIVE: transcribed shape (see header) ------------------------------------
const REVIEWER = 'Reviewer Fixture';
const tick = (at: string, itemId: string, title: string, from: boolean, to: boolean): StatusHistoryEntry => ({
  to,
  from,
  type: 'checklist_review',
  field: 'reviewer_checked',
  item_id: itemId,
  changed_at: at,
  changed_by: REVIEWER,
  item_title: title,
  checklist_name: 'QA sample checklist',
});
const LIVE: StatusHistoryEntry[] = [
  { notes: null, status: 'submitted', changed_at: '2026-09-27T20:33:20.697829+00:00', changed_by: undefined },
  { notes: null, status: 'under_review', changed_at: '2026-09-27T23:00:20.548307+00:00', changed_by: undefined },
  {
    type: 'checklist_added',
    changed_at: '2026-09-27T23:04:54.012711+00:00',
    changed_by: REVIEWER,
    template_id: '11111111-2222-4333-8444-555555555555', // pii-allow-uuid: invented fixture id
    checklist_id: '66666666-7777-4888-8999-aaaaaaaaaaaa', // pii-allow-uuid: invented fixture id
    checklist_name: 'Fixture template',
  },
  tick('2026-09-27T23:12:00.114329+00:00', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'Sample document A', false, true), // pii-allow-uuid: invented fixture id
  tick('2026-09-27T23:16:17.161818+00:00', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'Sample document A', true, false), // pii-allow-uuid: invented fixture id
  {
    notes: 'Fixture note: another checklist is needed.',
    status: 'needs_changes',
    changed_at: '2026-09-27T23:53:09.295268+00:00',
    changed_by: REVIEWER,
  },
  tick('2026-09-27T23:54:25.593966+00:00', '12345678-90ab-4cde-8f01-234567890abc', 'Sample document C', false, true), // pii-allow-uuid: invented fixture id
];

/** The top-level timeline lines of the current round, in rendered order. */
function topLevel(container: HTMLElement): HTMLElement[] {
  const lists = container.querySelectorAll('.flow-root > ul');
  const current = lists[lists.length - 1] as HTMLElement;
  return Array.from(current.children) as HTMLElement[];
}
function groupButton(scope: HTMLElement): HTMLElement {
  return within(within(scope).getByTestId('checklist-changes-group')).getAllByRole('button')[0];
}
function expandAllGroups(container: HTMLElement): void {
  for (const g of Array.from(container.querySelectorAll('[data-testid="checklist-changes-group"] > button[aria-expanded="false"]'))) {
    fireEvent.click(g);
  }
}

describe('typed entries in Status History', () => {
  it('render as non-status lines: the change, who, when (once their group is expanded)', () => {
    const { container } = render(<StatusHistory history={history} currentStatus="under_review" submittedAt={SUBMITTED_AT} />);
    expect(screen.queryAllByTestId('typed-history-entry')).toHaveLength(0);
    expandAllGroups(container);
    const typed = screen.getAllByTestId('typed-history-entry');
    expect(typed).toHaveLength(2);
    expect(typed[0]).toHaveTextContent('Title commitment — unchecked → checked');
    expect(typed[0]).toHaveTextContent('by Colleague Fixture');
    expect(typed[1]).toHaveTextContent('Checklist added: Lead-Based Paint');
    expect(typed[1]).toHaveTextContent('by a former member');
    // Never rendered through the status label map (its fallback prints the raw key).
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    expect(screen.queryByText('checklist_review')).not.toBeInTheDocument();
  });

  it('an untick reads checked → unchecked', () => {
    const { container } = render(
      <StatusHistory
        history={[{ ...history[2], from: true, to: false }]}
        currentStatus="under_review"
        submittedAt={SUBMITTED_AT}
      />
    );
    expandAllGroups(container);
    expect(screen.getByTestId('typed-history-entry')).toHaveTextContent('Title commitment — checked → unchecked');
  });

  it('never takes the Current badge: it stays on the status entry even when a typed entry is last', () => {
    const { container } = render(<StatusHistory history={history} currentStatus="under_review" submittedAt={SUBMITTED_AT} />);
    expandAllGroups(container);
    const current = screen.getAllByText('Current');
    expect(current).toHaveLength(1);
    const li = current[0].closest('li')!;
    expect(within(li).getByText(/Review Started/)).toBeInTheDocument();
  });
});

describe('grouped Status History (founder decision 795ff7c5)', () => {
  it('G1: ticks before a status change attach to THAT change, not the previous one', () => {
    const { container } = render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    const lines = topLevel(container);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent('Submitted');
    expect(within(lines[0]).queryByTestId('checklist-changes-group')).toBeNull();
    expect(lines[1]).toHaveTextContent('Review Started');
    expect(within(lines[1]).queryByTestId('checklist-changes-group')).toBeNull();
    expect(lines[2]).toHaveTextContent('Changes Requested');
    expect(groupButton(lines[2])).toHaveTextContent(/^3 checklist changes$/);
  });

  it('G2: expanding a group lists each entry in time order, with label and person', () => {
    const { container } = render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    const btn = groupButton(topLevel(container)[2]);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const rows = within(topLevel(container)[2]).getAllByTestId('typed-history-entry');
    expect(rows.map((r) => r.getAttribute('data-entry-type'))).toEqual(['checklist_added', 'checklist_review', 'checklist_review']);
    expect(rows[0]).toHaveTextContent('Checklist added: Fixture template');
    expect(rows[1]).toHaveTextContent('Sample document A — unchecked → checked');
    expect(rows[2]).toHaveTextContent('Sample document A — checked → unchecked');
    for (const r of rows) expect(r).toHaveTextContent(`by ${REVIEWER}`);
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(within(topLevel(container)[2]).queryAllByTestId('typed-history-entry')).toHaveLength(0);
  });

  it('G3: ticks after the latest status change form their own trailing group; Current stays on the status', () => {
    const { container } = render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    const lines = topLevel(container);
    const pending = lines[3];
    expect(pending).toHaveAttribute('data-testid', 'pending-history-group');
    expect(groupButton(pending)).toHaveTextContent(/^1 checklist change since the last review$/);
    expect(screen.getAllByText('Current')).toHaveLength(1);
    expect(within(lines[2]).getByText('Current')).toBeInTheDocument();
  });

  it('G4: disclosures are buttons with aria-expanded, collapsed by default, state per group', () => {
    const { container } = render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    const buttons = Array.from(container.querySelectorAll('[data-testid="checklist-changes-group"] > button'));
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b).toHaveAttribute('aria-expanded', 'false');
      expect(document.getElementById(b.getAttribute('aria-controls')!)).toBeNull();
    }
    fireEvent.click(buttons[1]);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(buttons[1].getAttribute('aria-controls')!)).not.toBeNull();
  });

  it('G5: no raw uuid anywhere, even with every group expanded', () => {
    const { container } = render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    expandAllGroups(container);
    expect(container.querySelectorAll('[data-testid="typed-history-entry"]')).toHaveLength(4);
    expect(container.innerHTML).not.toMatch(UUID);
  });
});

describe('most recent 4 top-level lines + Show full history', () => {
  const statuses = (...s: string[]): StatusHistoryEntry[] =>
    s.map((status, i) => ({ notes: null, status, changed_at: `2026-09-2${i}T10:00:00Z`, changed_by: undefined }));

  it('L1: more than 4 lines shows exactly the last 4 and the control; expanding shows all', () => {
    const h = statuses('submitted', 'under_review', 'needs_changes', 'under_review', 'approved');
    const { container } = render(<StatusHistory history={h} currentStatus="approved" />);
    let lines = topLevel(container);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent('Review Started');
    expect(lines[3]).toHaveTextContent('Approved');
    const control = screen.getByTestId('show-full-history');
    expect(control).toHaveTextContent('Show full history');
    expect(control).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-expanded', 'true');
    lines = topLevel(container);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toHaveTextContent('Submitted');
    expect(within(lines[4]).getByText('Current')).toBeInTheDocument();
  });

  it('L2: 4 or fewer lines shows no control — a group counts as ONE line', () => {
    // LIVE has 7 stored entries but 4 top-level lines.
    render(<StatusHistory history={LIVE} currentStatus="needs_changes" />);
    expect(screen.queryByTestId('show-full-history')).toBeNull();
    expect(screen.queryByText('Show full history')).toBeNull();
  });

  it('L3: exactly 4 status lines shows no control', () => {
    const { container } = render(
      <StatusHistory history={statuses('submitted', 'under_review', 'needs_changes', 'approved')} currentStatus="approved" />
    );
    expect(topLevel(container)).toHaveLength(4);
    expect(screen.queryByTestId('show-full-history')).toBeNull();
  });
});

describe('legacy-only history renders as before', () => {
  it('L4: status entries only: one line each, no group, no control', () => {
    const legacy: StatusHistoryEntry[] = [
      { notes: null, status: 'submitted', changed_at: '2026-08-01T10:00:00Z', changed_by: null },
      { notes: null, status: 'under_review', changed_at: '2026-08-02T10:00:00Z', changed_by: REVIEWER },
      { notes: 'Fixture note', status: 'needs_changes', changed_at: '2026-08-03T10:00:00Z', changed_by: REVIEWER },
    ];
    const { container } = render(<StatusHistory history={legacy} currentStatus="needs_changes" />);
    const lines = topLevel(container);
    expect(lines.map((l) => l.querySelector('p')!.textContent)).toEqual(['Submitted', 'Review Started', 'Changes RequestedCurrent']);
    expect(container.querySelectorAll('[data-testid="checklist-changes-group"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="pending-history-group"]')).toHaveLength(0);
    expect(screen.queryByTestId('show-full-history')).toBeNull();
    expect(screen.getByText('Fixture note')).toBeInTheDocument(); // Current's note open, as before
  });
});

describe('resubmission chain (parents merged by page.tsx)', () => {
  // Parent round, then the resubmission's own entries. Deliberately passed out
  // of order: the component sorts before grouping.
  const PARENT: StatusHistoryEntry[] = [
    { notes: null, status: 'submitted', changed_at: '2026-09-01T10:00:00Z', changed_by: null },
    { notes: null, status: 'under_review', changed_at: '2026-09-01T11:00:00Z', changed_by: null },
    tick('2026-09-01T11:30:00Z', 'item-p', 'Parent item', false, true),
    { notes: 'Fixture note', status: 'needs_changes', changed_at: '2026-09-01T12:00:00Z', changed_by: REVIEWER },
    tick('2026-09-01T13:00:00Z', 'item-q', 'Between rounds', false, true),
  ];
  const CHILD: StatusHistoryEntry[] = [
    { notes: null, status: 'resubmitted', changed_at: '2026-09-02T10:00:00Z', changed_by: null, parentSubmissionId: 'parent-x' },
    { notes: null, status: 'under_review', changed_at: '2026-09-02T11:00:00Z', changed_by: null },
    tick('2026-09-02T12:00:00Z', 'item-c', 'Child item', false, true),
  ];

  it('R1: a tick between Changes requested and the resubmission attaches to Resubmitted', () => {
    const { container } = render(
      <StatusHistory history={[...CHILD, ...PARENT]} currentStatus="under_review" submittedAt="2026-09-01T10:00:00Z" />
    );
    expect(screen.getByText(/previous review \(3 steps\)/)).toBeInTheDocument();
    const lines = topLevel(container);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent('Resubmitted');
    fireEvent.click(groupButton(lines[0]));
    expect(within(lines[0]).getAllByTestId('typed-history-entry').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Between rounds'),
    ]);
    expect(lines[1]).toHaveTextContent('Review Started');
    expect(within(lines[1]).getByText('Current')).toBeInTheDocument();
    expect(groupButton(lines[2])).toHaveTextContent(/^1 checklist change since the last review$/);
  });

  it('R2: the previous round keeps its own group under its Changes requested', () => {
    const { container } = render(
      <StatusHistory history={[...CHILD, ...PARENT]} currentStatus="under_review" submittedAt="2026-09-01T10:00:00Z" />
    );
    fireEvent.click(screen.getByText(/Show previous review/));
    const prev = Array.from(container.querySelectorAll('.flow-root > div ul')[0].children) as HTMLElement[];
    expect(prev.map((l) => l.querySelector('p')!.textContent)).toEqual(['Submitted', 'Review Started', 'Changes Requested']);
    expect(groupButton(prev[2])).toHaveTextContent(/^1 checklist change$/);
  });
});

describe('groupHistory (pure fold)', () => {
  it('keeps every entry, in order, exactly once', () => {
    const items = groupHistory(LIVE);
    const flat = items.flatMap((i) => (i.kind === 'status' ? [...i.changes, i.entry] : i.changes));
    expect(flat).toEqual(LIVE);
  });
});
