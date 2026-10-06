/**
 * BACKLOG-3592 — after Request Changes, the review bar stops offering actions,
 * and the decision write refuses a version that is no longer open.
 *
 * The row under review is shaped like the live v2 that surfaced this
 * (read-only Supabase MCP, 2026-09-27): status needs_changes, version 2,
 * parent_submission_id set, reviewed_by / reviewed_at / review_notes set.
 * Shape from `submissionRow` (columns transcribed from production); every id
 * and value invented.
 *
 * The update stub below APPLIES the chained filters (`eq`, `in`) to the row
 * and returns the matched rows, the way PostgREST answers
 * `update ... where ... returning id`. A refused write is `data: []`,
 * `error: null` — the shape PR C already treats as failure.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { submissionRow } from '../helpers/submissionRows';
import type { Row } from '../helpers/postgrestEmulator';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const db: { rows: Row[]; updates: number } = { rows: [], updates: 0 };

function updateChain(values: Record<string, unknown>) {
  const filters: ((r: Row) => boolean)[] = [];
  const chain = {
    eq(column: string, value: unknown) {
      filters.push((r) => r[column] === value);
      return chain;
    },
    in(column: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[column]));
      return chain;
    },
    async select() {
      db.updates += 1;
      const matched = db.rows.filter((r) => filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, values);
      return { data: matched.map((r) => ({ id: r.id })), error: null };
    },
  };
  return chain;
}

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'reviewer-2' } }, error: null }) },
    from: () => ({
      update: (values: Record<string, unknown>) => updateChain(values),
      insert: async () => ({ error: null }),
    }),
  }),
}));

import { ReviewActions, REQUEST_CHANGES_HINT, WAITING_FOR_RESUBMIT } from '@/components/submission/ReviewActions';
import { REVIEW_MESSAGES } from '@/lib/submissions/reviewMessages';
import { requestChangesAvailable } from '@/lib/submissions/checklistModel';

const V2_ID = 'sub-v2-3592';
const EARLIER_NOTE = 'Missing the signed disclosure, please add it.';

function sentBackV2(): Row {
  return {
    ...submissionRow({
      id: V2_ID,
      organizationId: 'org-3592',
      submittedBy: 'agent-3592',
      status: 'needs_changes',
      parentSubmissionId: 'sub-v1-3592',
    }),
    version: 2,
    reviewed_by: 'reviewer-1',
    reviewed_at: '2026-09-27T10:00:00Z',
    review_notes: EARLIER_NOTE,
  };
}

function props(status: string) {
  return { id: V2_ID, status, organization_id: 'org-3592' };
}

const OPEN = ['submitted', 'resubmitted', 'under_review'];
const ALL = [...OPEN, 'needs_changes', 'approved', 'rejected', 'uploading'];

beforeEach(() => {
  jest.clearAllMocks();
  db.rows = [];
  db.updates = 0;
});

function decisionButtons() {
  return {
    approve: screen.queryByRole('button', { name: /^Approve$/ }),
    changes: screen.queryByRole('button', { name: /^Request Changes$/ }),
    reject: screen.queryByRole('button', { name: /^Reject$/ }),
  };
}

describe('review bar on a sent-back version (needs_changes)', () => {
  it('offers no decision and no hint, and shows the waiting line', () => {
    render(<ReviewActions submission={props('needs_changes')} showChecklistHint />);
    const b = decisionButtons();
    expect(b.approve).not.toBeInTheDocument();
    expect(b.changes).not.toBeInTheDocument();
    expect(b.reject).not.toBeInTheDocument();
    expect(screen.queryByText(REQUEST_CHANGES_HINT)).not.toBeInTheDocument();
    expect(screen.getByTestId('waiting-for-resubmit')).toHaveTextContent(WAITING_FOR_RESUBMIT);
    expect(screen.queryByText(/Review Complete/)).not.toBeInTheDocument();
  });

  it.each(OPEN)('%s: all three decisions and the hint are offered as before', (status) => {
    render(<ReviewActions submission={props(status)} showChecklistHint />);
    const b = decisionButtons();
    expect(b.approve).toBeInTheDocument();
    expect(b.changes).toBeInTheDocument();
    expect(b.reject).toBeInTheDocument();
    expect(screen.getByTestId('request-changes-hint')).toHaveTextContent(REQUEST_CHANGES_HINT);
    expect(screen.queryByText(WAITING_FOR_RESUBMIT)).not.toBeInTheDocument();
  });

  it.each(['approved', 'rejected'])('%s: the Review Complete line is unchanged', (status) => {
    render(<ReviewActions submission={props(status)} disabled />);
    expect(screen.getByText(/Review Complete/)).toBeInTheDocument();
    expect(screen.queryByText(WAITING_FOR_RESUBMIT)).not.toBeInTheDocument();
    expect(decisionButtons().approve).not.toBeInTheDocument();
  });

  it('it_admin (canDecide=false) still gets nothing on needs_changes', () => {
    const { container } = render(<ReviewActions submission={props('needs_changes')} canDecide={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(ALL)(
    '%s: the bar offers Request Changes exactly when requestChangesAvailable says so',
    (status) => {
      render(<ReviewActions submission={props(status)} disabled={status === 'approved' || status === 'rejected'} />);
      const shown = decisionButtons().changes !== null;
      expect(shown).toBe(requestChangesAvailable(status, true));
    }
  );
});

describe('decision write on a version that is no longer open', () => {
  const NOTE = 'Please attach the final settlement statement.';

  async function decide(kind: 'approve' | 'changes' | 'reject') {
    // A stale tab: the bar was rendered while the version was under_review,
    // and the database row has since been sent back.
    render(<ReviewActions submission={props('under_review')} />);
    const label = kind === 'approve' ? /^Approve$/ : kind === 'changes' ? /^Request Changes$/ : /^Reject$/;
    fireEvent.click(screen.getByRole('button', { name: label }));
    if (kind !== 'approve') {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: NOTE } });
    }
    const submit =
      kind === 'approve' ? /Approve Submission/ : kind === 'changes' ? /^Request Changes$/ : /Reject Submission/;
    fireEvent.click(screen.getByRole('button', { name: submit }));
    if (kind === 'reject') {
      fireEvent.click(screen.getByRole('button', { name: /Yes, Reject Submission/ }));
    }
  }

  it.each(['approve', 'changes', 'reject'] as const)(
    '%s is refused on needs_changes, reported as an error, and the earlier review survives',
    async (kind) => {
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      db.rows = [sentBackV2()];
      await decide(kind);
      expect(await screen.findByText(REVIEW_MESSAGES.no_rows)).toBeInTheDocument();
      expect(db.updates).toBe(1);
      expect(db.rows[0].status).toBe('needs_changes');
      expect(db.rows[0].review_notes).toBe(EARLIER_NOTE);
      expect(db.rows[0].reviewed_by).toBe('reviewer-1');
      expect(mockRefresh).not.toHaveBeenCalled();
      quiet.mockRestore();
    }
  );

  it('the same write on an open version succeeds', async () => {
    db.rows = [{ ...sentBackV2(), status: 'under_review' }];
    await decide('changes');
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(db.rows[0].status).toBe('needs_changes');
    expect(db.rows[0].review_notes).toBe(NOTE);
    expect(screen.queryByText(REVIEW_MESSAGES.no_rows)).not.toBeInTheDocument();
  });
});
