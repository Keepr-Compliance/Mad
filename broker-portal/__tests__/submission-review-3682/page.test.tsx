/**
 * Submission review page — BACKLOG-3682: the Attachments list shows each file's
 * source message, and "These files were not included by the agent:" closes the
 * page. Runs the real server page, real loaders, real AttachmentList and
 * ExcludedFilesNotice against the BACKLOG-3364 PostgREST emulator (harness
 * copied from __tests__/submission-review-3403/uploading-not-found.test.tsx).
 *
 * FIXTURE PROVENANCE (every id, name and number invented): columns the page
 * reads (information_schema, production, 2026-10-04); participants shapes from
 * pm_comments f745183e and mapEmailToSubmissionMessage; message_id and
 * excluded_files as written by PR #2797 @ cede03a5d (submissionService.ts
 * :349-357, :897-921, :955-961).
 */

import { render, screen } from '@testing-library/react';
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
let mockFeatures = ORG_WITHOUT_PLAN_FEATURES;
const featuresWith = (textView: boolean) =>
  [
    ['broker_portal_access', true],
    ['broker_text_attachments', true],
    ['broker_email_attachments', true],
    ['broker_text_view', textView],
  ].reduce((f, [k, v]) => withFeature(f, k as string, v as boolean), ORG_WITHOUT_PLAN_FEATURES);
const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name === 'broker_get_org_features') return { data: mockFeatures, error: null };
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
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }) }) },
  }),
}));
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/submission/ReviewActions', () => ({ ReviewActions: function ReviewActions() { return null; } }));
jest.mock('@/components/submission/StatusHistory', () => ({ StatusHistory: function StatusHistory() { return null; } }));
jest.mock('@/components/submission/ChecklistReview', () => ({ ChecklistReview: function ChecklistReview() { return null; } }));
jest.mock('@/components/submission/SubmissionVersions', () => ({ SubmissionVersions: function SubmissionVersions() { return null; } }));

import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';

const SUB = '00000000-0000-4000-8000-000000368201'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000368202'; // pii-allow-uuid: invented fixture id
const EMAIL_MSG = '00000000-0000-4000-8000-000000368203'; // pii-allow-uuid: invented fixture id
const TEXT_MSG = '00000000-0000-4000-8000-000000368204'; // pii-allow-uuid: invented fixture id

const EXCLUDED = [
  { filename: 'Video.mov', kind: 'email', message_id: EMAIL_MSG, sent_at: '2026-10-03T15:00:00.000Z', source_label: 'Signed contract', reason: 'file_too_large' },
  { filename: null, kind: 'text', message_id: TEXT_MSG, sent_at: '2026-10-03T16:05:00.000Z', source_label: 'Gina Example', reason: 'text_attachment_not_on_this_computer' },
];

function subRow(metadata: unknown): Row {
  return {
    id: SUB,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    submitted_by: AGENT_ID,
    local_transaction_id: 'deal-3682',
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
    message_count: 2,
    attachment_count: 2,
    parent_submission_id: null,
    submission_metadata: metadata,
    created_at: '2026-10-04T09:00:00+00:00',
    status_history: [],
  };
}

const messageRows: Row[] = [
  {
    id: EMAIL_MSG, submission_id: SUB, local_message_id: 'e1', channel: 'email', direction: 'inbound',
    subject: 'Signed contract', body_text: 'x', sent_at: '2026-10-02T22:15:00+00:00', thread_id: null,
    has_attachments: true, attachment_count: 1, message_type: 'email',
    participants: { from: 'Avery Example <jane@fixture.example.test>', to: ['agent@fixture.example.test'] },
  },
  {
    id: TEXT_MSG, submission_id: SUB, local_message_id: 't1', channel: 'sms', direction: 'inbound',
    subject: null, body_text: '', sent_at: '2026-10-03T16:05:00+00:00', thread_id: 'th1',
    has_attachments: true, attachment_count: 1, message_type: 'attachment_only',
    participants: { from: '+14155550101', to: 'me', to_names: {} },
  },
];

const att = (id: string, filename: string, message_id: string | null): Row => ({
  id, submission_id: SUB, filename, mime_type: 'application/pdf', file_size_bytes: 2048,
  storage_path: `${FIXTURE_BROKERAGE_ORG_ID}/${SUB}/${id}/${filename}`, document_type: null,
  local_attachment_id: `local-${id}`, message_id, created_at: '2026-10-04T09:00:00+00:00',
});

function given(opts: { linked: boolean; metadata: unknown; textView?: boolean }): void {
  mockFeatures = featuresWith(opts.textView ?? true);
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: [subRow(opts.metadata)],
      users: [{ id: FIXTURE_USER_ID, display_name: 'viewer', first_name: null, last_name: null, email: 'viewer@fixture.example.test' }],
      profiles: [{ id: FIXTURE_USER_ID, display_name: 'Viewer Fixture' }],
      submission_messages: messageRows,
      submission_attachments: [
        att('a1', 'Contract.pdf', opts.linked ? EMAIL_MSG : null),
        att('a2', 'Photo.pdf', opts.linked ? TEXT_MSG : null),
      ],
      submission_checklists: [],
      submission_checklist_items: [],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
      checklist_templates: [],
    },
  });
}

const renderPage = async () => render(await SubmissionDetailPage({ params: Promise.resolve({ id: SUB }) }));
const sourceLines = () => screen.queryAllByTestId('attachment-source').map((n) => n.textContent);

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('review page attachment sources and excluded files (BACKLOG-3682)', () => {
  it('a 2.39 submission: each file shows its source; the notice is the last thing on the page', async () => {
    given({ linked: true, metadata: { excluded_files: EXCLUDED } });
    const { container } = await renderPage();
    expect(sourceLines().sort()).toEqual([
      'Oct 2, 2026, 3:15 PM · From Avery Example · Email "Signed contract"',
      'Oct 3, 2026, 9:05 AM · From +14155550101 · Text',
    ]);
    const notice = screen.getByTestId('excluded-files-notice');
    expect(screen.getAllByTestId('excluded-file').map((li) => li.textContent)).toEqual([
      'Video.movEmail "Signed contract", Oct 3, 2026, 8:00 AMLarger than 50 MB',
      "A photo or fileText with Gina Example, Oct 3, 2026, 9:05 AMKeepr has no copy on the agent's computer",
    ]);
    const page = container.firstElementChild as HTMLElement;
    expect(page.lastElementChild).toBe(notice);
  });

  it.each([
    ['null metadata', null],
    ['metadata without excluded_files', { source: 'desktop' }],
    ['an empty list', { excluded_files: [] }],
  ])('an older submission (no message_id, %s) renders cleanly: no source lines, no notice', async (_label, metadata) => {
    given({ linked: false, metadata });
    await renderPage();
    expect(screen.getByText('Contract.pdf')).toBeTruthy();
    expect(screen.getByText('Photo.pdf')).toBeTruthy();
    expect(sourceLines()).toEqual([]);
    expect(screen.queryByTestId('excluded-files-notice')).toBeNull();
    expect(screen.queryByText(/not included by the agent/)).toBeNull();
  });

  it('with broker text view off, a text file shows no sender and the notice drops the text label', async () => {
    given({ linked: true, metadata: { excluded_files: EXCLUDED }, textView: false });
    await renderPage();
    expect(sourceLines()).toEqual(['Oct 2, 2026, 3:15 PM · From Avery Example · Email "Signed contract"']);
    expect(screen.queryByText(/\+14155550101/)).toBeNull();
    expect(screen.queryByText(/Gina Example/)).toBeNull();
    expect(screen.getAllByTestId('excluded-file')[1].textContent).toBe(
      "A photo or fileA text, Oct 3, 2026, 9:05 AMKeepr has no copy on the agent's computer"
    );
  });
});
