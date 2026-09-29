/**
 * Commission on the submission review page — BACKLOG-3521 (read-only display).
 *
 * The page test runs the real server page with the real loaders against the
 * BACKLOG-3364 PostgREST emulator (plumbing copied from
 * __tests__/submission-review-3607/page.test.tsx); the Commission card and the
 * header cells render for real, every other section is stubbed.
 *
 * FIXTURE PROVENANCE. The figure shapes are transcribed from production on
 * 2026-09-29 (`select commission_offered_rate::text, commission_actual_rate::text,
 * commission_gross_amount::text, length(commission_adjustment_reason) from
 * transaction_submissions where commission_offered_rate is not null`, MCP):
 *   row A: '3.000', '2.500', '12500.00', reason of 26 characters
 *   row B: '3.000', '3.000', '36000.00', reason NULL
 * The other 11 production rows have all four columns NULL (pre-2026-09-29).
 * PostgREST sends numeric as a JSON number, so the page fixtures carry
 * 3 / 2.5 / 12500; the text form is covered in the formatter tests. The
 * reason TEXT is invented (26 characters, like row A's); ids, names and
 * addresses are invented.
 */

import type React from 'react';

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const CHECKLISTS_ON = withFeature(withFeature(ORG_WITHOUT_PLAN_FEATURES, 'broker_portal_access', true), 'transaction_checklists', true);
const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name === 'broker_get_org_features') return { data: CHECKLISTS_ON, error: null };
  if (name === 'can_review_submission') {
    const ok = (mockEmulator.state.rows.organization_members ?? []).some(
      (m) => m.organization_id === args?.p_org_id && m.user_id === FIXTURE_USER_ID && ['broker', 'admin'].includes(m.role as string)
    );
    return { data: ok, error: null };
  }
  return { data: null, error: null };
});

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
    rpc: mockRpc,
  })),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({ from: (t: string) => mockEmulator.from(t), rpc: mockRpc })),
}));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: jest.fn(),
  addChecklistAtReview: jest.fn(),
  removeChecklistAtReview: jest.fn(),
  restoreChecklistAtReview: jest.fn(),
}));
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));
jest.mock('next/link', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/submission/MessageList', () => ({
  ...jest.requireActual('@/components/submission/MessageList'),
  MessageList: function MessageList() {
    return null;
  },
}));
jest.mock('@/components/submission/AttachmentList', () => ({ AttachmentList: function AttachmentList() { return null; } }));
jest.mock('@/components/submission/ReviewActions', () => ({ ReviewActions: function ReviewActions() { return null; } }));
jest.mock('@/components/submission/StatusHistory', () => ({ StatusHistory: function StatusHistory() { return null; } }));
jest.mock('@/components/submission/ChecklistReview', () => ({ ChecklistReview: function ChecklistReview() { return null; } }));
jest.mock('@/components/submission/SubmissionVersions', () => ({ SubmissionVersions: function SubmissionVersions() { return null; } }));

import { render, screen, within } from '@testing-library/react';
import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';
import { CommissionSummary } from '@/components/submission/CommissionSummary';
import {
  finalCell,
  formatGross,
  formatRate,
  offeredCell,
  readCommission,
  reductionRate,
  type CommissionColumns,
} from '@/lib/submissions/commission';

const SUB = '00000000-0000-4000-8000-000000352101'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000352102'; // pii-allow-uuid: invented fixture id

const REASON = 'Seller asked for reduction'; // invented, 26 chars like production row A
const ROW_A: CommissionColumns = {
  commission_offered_rate: 3,
  commission_actual_rate: 2.5,
  commission_gross_amount: 12500,
  commission_adjustment_reason: REASON,
};
const ROW_B: CommissionColumns = {
  commission_offered_rate: 3,
  commission_actual_rate: 3,
  commission_gross_amount: 36000,
  commission_adjustment_reason: null,
};
const NO_FIGURES: CommissionColumns = {
  commission_offered_rate: null,
  commission_actual_rate: null,
  commission_gross_amount: null,
  commission_adjustment_reason: null,
};

function subRow(figures: CommissionColumns): Row {
  return {
    id: SUB,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    submitted_by: AGENT_ID,
    local_transaction_id: 'deal-1',
    version: 1,
    status: 'submitted',
    property_address: 'Fixture Street',
    property_city: 'Fixture City',
    property_state: 'CA',
    property_zip: '00000',
    transaction_type: 'purchase',
    listing_price: null,
    sale_price: null,
    started_at: null,
    closed_at: null,
    message_count: 3,
    attachment_count: 1,
    parent_submission_id: null,
    created_at: '2026-09-29T09:00:00+00:00',
    status_history: [],
    ...figures,
  };
}

function given(figures: CommissionColumns): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: [subRow(figures)],
      users: [{ id: FIXTURE_USER_ID, display_name: 'viewer', first_name: null, last_name: null, email: 'viewer@fixture.example.test' }],
      profiles: [{ id: FIXTURE_USER_ID, display_name: 'Viewer Fixture' }],
      submission_checklists: [],
      submission_checklist_items: [],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
      submission_attachments: [],
      submission_messages: [],
      checklist_templates: [],
    },
  });
}

async function renderPage(figures: CommissionColumns) {
  given(figures);
  const el = (await SubmissionDetailPage({ params: Promise.resolve({ id: SUB }) })) as React.ReactElement;
  return render(el);
}

/** The header cell's value, found by its label. */
function headerCell(label: string): string {
  const dt = screen.getByText(label, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? '';
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('header cells (BACKLOG-3521)', () => {
  it('(a) show Commission Offered and Final Commission in place of the counts', async () => {
    await renderPage(ROW_A);
    expect(headerCell('Commission Offered')).toBe('3%');
    expect(headerCell('Final Commission')).toBe('2.5% · $12,500');
    expect(screen.queryByText('Messages', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Attachments', { selector: 'dt' })).toBeNull();
  });

  it('(b) show "–" in both cells when the submission has no figures', async () => {
    await renderPage(NO_FIGURES);
    expect(headerCell('Commission Offered')).toBe('–');
    expect(headerCell('Final Commission')).toBe('–');
  });

  it('Final Commission shows either half alone', () => {
    expect(finalCell(readCommission({ ...NO_FIGURES, commission_actual_rate: 2.5 }))).toBe('2.5%');
    expect(finalCell(readCommission({ ...NO_FIGURES, commission_gross_amount: 12500 }))).toBe('$12,500');
    expect(offeredCell(readCommission(NO_FIGURES))).toBe('–');
  });
});

describe('Commission card (BACKLOG-3521)', () => {
  it('renders on the page with every figure (production row A shape)', async () => {
    await renderPage(ROW_A);
    const card = within(screen.getByTestId('commission-card'));
    expect(card.getByText('Commission offered', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3%');
    expect(card.getByText('Commission actual', { selector: 'dt' }).nextElementSibling?.textContent).toBe('2.5%');
    expect(card.getByText('Gross commission', { selector: 'dt' }).nextElementSibling?.textContent).toBe('$12,500');
    expect(card.getByTestId('commission-reduction').textContent).toBe('0.5%');
    expect(card.getByTestId('commission-reason').textContent).toBe(`“${REASON}”`);
  });

  it('(c) the reduction pill shows only when actual < offered', () => {
    const { unmount } = render(<CommissionSummary figures={readCommission(ROW_A)} />);
    expect(screen.getByTestId('commission-reduction').textContent).toBe('0.5%');
    unmount();

    // production row B: actual == offered
    const b = render(<CommissionSummary figures={readCommission(ROW_B)} />);
    expect(screen.queryByTestId('commission-reduction')).toBeNull();
    expect(screen.queryByText('Reduction')).toBeNull();
    expect(screen.queryByTestId('commission-reason')).toBeNull();
    b.unmount();

    // actual above offered: no reduction either
    render(<CommissionSummary figures={readCommission({ ...ROW_B, commission_actual_rate: 3.25 })} />);
    expect(screen.queryByTestId('commission-reduction')).toBeNull();
  });

  it('reduction boundary sweep in thousandths', () => {
    const r = (o: number | string, a: number | string) =>
      reductionRate(readCommission({ ...NO_FIGURES, commission_offered_rate: o, commission_actual_rate: a }));
    expect(r(3, 3.001)).toBeNull();
    expect(r(3, 3)).toBeNull();
    expect(r(3, 2.999)).toBe(0.001);
    expect(r('3.000', '2.500')).toBe(0.5);
    expect(r(2.9, 2.6)).toBe(0.3); // float drift would give 0.2999…
    expect(r(3, null as unknown as number)).toBeNull();
  });

  it('(d) shows the empty state when every figure is null', async () => {
    await renderPage(NO_FIGURES);
    const card = within(screen.getByTestId('commission-card'));
    expect(card.getByTestId('commission-empty').textContent).toBe('No commission figures were entered for this submission.');
    expect(card.queryByText('Commission offered')).toBeNull();
    expect(card.queryByTestId('commission-reduction')).toBeNull();
  });
});

describe('formatting (BACKLOG-3521)', () => {
  it('(e) rates trim trailing zeros', () => {
    const rate = (v: string) => formatRate(readCommission({ ...NO_FIGURES, commission_offered_rate: v }).offeredRate!);
    expect(rate('3.000')).toBe('3%');
    expect(rate('2.500')).toBe('2.5%');
    expect(rate('2.375')).toBe('2.375%');
    expect(formatRate(3)).toBe('3%');
    expect(formatRate(2.5)).toBe('2.5%');
  });

  it('(f) gross is whole dollars with no cents', () => {
    const gross = (v: string | number) => formatGross(readCommission({ ...NO_FIGURES, commission_gross_amount: v }).grossAmount!);
    expect(gross('12500.00')).toBe('$12,500');
    expect(gross('36000.00')).toBe('$36,000');
    expect(gross(12500)).toBe('$12,500');
  });

  it('a blank reason counts as none', () => {
    expect(readCommission({ ...ROW_B, commission_adjustment_reason: '   ' }).reason).toBeNull();
  });
});
