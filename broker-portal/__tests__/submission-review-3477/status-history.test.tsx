/**
 * Status History typed entries — BACKLOG-3477 (ruling 3767e481).
 *
 * Status entries: production shape {notes, status, changed_at, changed_by}.
 * Typed entries: the keys §7 / §8 of
 * 20260925073000_backlog_3477_submission_checklist_review.sql build, with
 * changed_by already resolved to a name (the page does that).
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { StatusHistory } from '@/components/submission/StatusHistory';
import type { StatusHistoryEntry } from '@/lib/submissions/history';

const SUBMITTED_AT = '2026-09-20T15:00:00.000000+00:00';

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

describe('typed entries in Status History', () => {
  it('render as non-status lines: the change, who, when', () => {
    render(<StatusHistory history={history} currentStatus="under_review" submittedAt={SUBMITTED_AT} />);
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
    render(
      <StatusHistory
        history={[{ ...history[2], from: true, to: false }]}
        currentStatus="under_review"
        submittedAt={SUBMITTED_AT}
      />
    );
    expect(screen.getByTestId('typed-history-entry')).toHaveTextContent('Title commitment — checked → unchecked');
  });

  it('never takes the Current badge: it stays on the status entry even when a typed entry is last', () => {
    render(<StatusHistory history={history} currentStatus="under_review" submittedAt={SUBMITTED_AT} />);
    const current = screen.getAllByText('Current');
    expect(current).toHaveLength(1);
    const li = current[0].closest('li')!;
    expect(within(li).getByText(/Review Started/)).toBeInTheDocument();
  });
});
