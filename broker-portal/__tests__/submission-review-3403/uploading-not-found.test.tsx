/**
 * Submission review page — BACKLOG-3403: a submission still 'uploading' opens
 * as not found, and is never marked under review.
 *
 * Runs the real server page with the real loaders against the BACKLOG-3364
 * PostgREST emulator (same plumbing as __tests__/submission-review-3607/page.test.tsx).
 *
 * FIXTURE PROVENANCE (every id and name invented): the transaction_submissions
 * columns the page reads (information_schema, production, 2026-10-04); status
 * values from transaction_submissions_status_check.
 */

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
const mockMarkAsUnderReview = jest.fn(async (..._args: unknown[]) => 'skipped');
const FEATURES_ON = withFeature(withFeature(ORG_WITHOUT_PLAN_FEATURES, 'broker_portal_access', true), 'transaction_checklists', true);
const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name === 'broker_get_org_features') return { data: FEATURES_ON, error: null };
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
jest.mock('@/lib/submissions/markUnderReview', () => ({
  markAsUnderReview: (...args: unknown[]) => mockMarkAsUnderReview(...args),
}));
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

import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';

const SUB = '00000000-0000-4000-8000-000000340301'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000340302'; // pii-allow-uuid: invented fixture id

function subRow(status: string): Row {
  return {
    id: SUB,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    submitted_by: AGENT_ID,
    local_transaction_id: 'deal-3403',
    version: 1,
    status,
    property_address: 'Fixture Street',
    property_city: 'Fixture City',
    property_state: 'CA',
    property_zip: '00000',
    transaction_type: 'purchase',
    listing_price: null,
    sale_price: null,
    started_at: null,
    closed_at: null,
    message_count: 0,
    attachment_count: 0,
    parent_submission_id: null,
    submission_metadata: null,
    created_at: '2026-10-04T09:00:00+00:00',
    status_history: [],
  };
}

function given(status: string): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: [subRow(status)],
      users: [{ id: FIXTURE_USER_ID, display_name: 'viewer', first_name: null, last_name: null, email: 'viewer@fixture.example.test' }],
      profiles: [{ id: FIXTURE_USER_ID, display_name: 'Viewer Fixture' }],
      submission_messages: [],
      submission_attachments: [],
      submission_checklists: [],
      submission_checklist_items: [],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
      checklist_templates: [],
    },
  });
}

const renderPage = () => SubmissionDetailPage({ params: Promise.resolve({ id: SUB }) });

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('review page and uploading submissions (BACKLOG-3403)', () => {
  it('an uploading submission opens as not found and is not marked under review', async () => {
    given('uploading');
    await expect(renderPage()).rejects.toThrow('notFound');
    expect(mockMarkAsUnderReview).not.toHaveBeenCalled();
  });

  it.each(['submitted', 'resubmitted', 'under_review', 'needs_changes'])('a %s submission still opens', async (status) => {
    given(status);
    await expect(renderPage()).resolves.toBeTruthy();
    expect(mockMarkAsUnderReview).toHaveBeenCalledTimes(1);
    expect(mockMarkAsUnderReview.mock.calls[0][0]).toMatchObject({ id: SUB, status });
  });
});
