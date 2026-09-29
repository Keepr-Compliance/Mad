/**
 * ReviewActions — BACKLOG-3477 (pm_comments dcc91c87, ruling 3; SR C7).
 *
 * A zero-row UPDATE is a failure. Under RLS a refused UPDATE ... RETURNING
 * returns `data: []` with `error: null` (PostgREST 200); that is the shape the
 * update stub resolves below.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

let mockUpdateResult: { data: unknown; error: unknown } = { data: [], error: null };
const mockUpdate = jest.fn();
const mockInsert = jest.fn(async () => ({ error: null }));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'reviewer-id' } }, error: null }) },
    from: (table: string) => ({
      update: (values: unknown) => {
        mockUpdate(table, values);
        return { eq: () => ({ in: () => ({ select: async () => mockUpdateResult }) }) };
      },
      insert: mockInsert,
    }),
  }),
}));

import { ReviewActions, REQUEST_CHANGES_HINT } from '@/components/submission/ReviewActions';
import { REVIEW_MESSAGES } from '@/lib/submissions/reviewMessages';

const SUBMISSION = { id: 'sub-1', status: 'under_review', organization_id: 'org-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateResult = { data: [], error: null };
});

async function approve() {
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
  fireEvent.click(screen.getByRole('button', { name: /Approve Submission/ }));
}

describe('ReviewActions', () => {
  it('a zero-row update is reported as a failure, not a success', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<ReviewActions submission={SUBMISSION} />);
    await approve();
    expect(await screen.findByText(REVIEW_MESSAGES.no_rows)).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('a one-row update succeeds', async () => {
    mockUpdateResult = { data: [{ id: 'sub-1' }], error: null };
    render(<ReviewActions submission={SUBMISSION} />);
    await approve();
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(screen.queryByText(REVIEW_MESSAGES.no_rows)).not.toBeInTheDocument();
  });

  it('renders nothing for a reviewer who may not decide (it_admin)', () => {
    const { container } = render(<ReviewActions submission={SUBMISSION} canDecide={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });

  it('shows the checklist hint beside Request Changes only when asked', () => {
    const { rerender } = render(<ReviewActions submission={SUBMISSION} />);
    expect(screen.queryByText(REQUEST_CHANGES_HINT)).not.toBeInTheDocument();
    rerender(<ReviewActions submission={SUBMISSION} showChecklistHint />);
    expect(screen.getByTestId('request-changes-hint')).toHaveTextContent(REQUEST_CHANGES_HINT);
  });
});
