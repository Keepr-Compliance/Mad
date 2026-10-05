/**
 * Submission review page — BACKLOG-3748: the page hands MessageList each
 * message's files, joined on submission_attachments.message_id over the gated
 * messages, gated by the page's existing either-flag rule (showAttachments —
 * the same rule AttachmentList and the checklist file list already use, not
 * a stricter per-channel one; SR review, pm_comments efcb3cec). Runs the real
 * server page and loaders against the BACKLOG-3364 PostgREST emulator (harness
 * copied from __tests__/submission-review-3682/page.test.tsx).
 *
 * FIXTURE PROVENANCE (every id, name and number invented): row columns as in
 * the 3682 page test (information_schema, production, 2026-10-04); text photo
 * shapes from the production join on message_id, 2026-10-05 (imessage,
 * message_type 'text' with body and 'attachment_only', attachment_count 0,
 * image/jpeg); email row from mapEmailToSubmissionMessage.
 */

import { render } from '@testing-library/react';
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
const featuresWith = (f: { textView?: boolean; textAtt?: boolean; emailAtt?: boolean }) =>
  [
    ['broker_portal_access', true],
    ['broker_text_attachments', f.textAtt ?? true],
    ['broker_email_attachments', f.emailAtt ?? true],
    ['broker_text_view', f.textView ?? true],
    ['broker_email_view', true],
  ].reduce((acc, [k, v]) => withFeature(acc, k as string, v as boolean), ORG_WITHOUT_PLAN_FEATURES);
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
const mockMessageListProps = jest.fn();
jest.mock('@/components/submission/MessageList', () => ({
  ...jest.requireActual('@/components/submission/MessageList'),
  MessageList: function MessageList(props: unknown) {
    mockMessageListProps(props);
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

const SUB = '00000000-0000-4000-8000-000000374801'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000374802'; // pii-allow-uuid: invented fixture id
const EMAIL_MSG = '00000000-0000-4000-8000-000000374803'; // pii-allow-uuid: invented fixture id
const TEXT_MSG = '00000000-0000-4000-8000-000000374804'; // pii-allow-uuid: invented fixture id
const PHOTO_MSG = '00000000-0000-4000-8000-000000374805'; // pii-allow-uuid: invented fixture id
const OTHER_SUB = '00000000-0000-4000-8000-000000374806'; // pii-allow-uuid: invented fixture id

const subRow: Row = {
  id: SUB,
  organization_id: FIXTURE_BROKERAGE_ORG_ID,
  submitted_by: AGENT_ID,
  local_transaction_id: 'deal-3748',
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
  attachment_count: 4,
  parent_submission_id: null,
  submission_metadata: null,
  created_at: '2026-10-04T09:00:00+00:00',
  status_history: [],
};

const text = (id: string, local: string, sent_at: string, message_type: string, body_text: string): Row => ({
  id, submission_id: SUB, local_message_id: local, channel: 'imessage', direction: 'inbound',
  subject: null, body_text, sent_at, thread_id: 'th1', has_attachments: true, attachment_count: 0, message_type,
  participants: { from: '+14155550101', to: 'me' },
});

const messageRows: Row[] = [
  {
    id: EMAIL_MSG, submission_id: SUB, local_message_id: 'e1', channel: 'email', direction: 'inbound',
    subject: 'Signed contract', body_text: 'x', sent_at: '2026-10-02T22:15:00+00:00', thread_id: null,
    has_attachments: true, attachment_count: 1, message_type: 'email',
    participants: { from: 'Avery Example <jane@fixture.example.test>', to: ['agent@fixture.example.test'] },
  },
  text(TEXT_MSG, 't1', '2026-10-03T16:00:00+00:00', 'text', 'Front of the house'),
  text(PHOTO_MSG, 't2', '2026-10-03T16:01:00+00:00', 'attachment_only', ''),
];

const att = (id: string, filename: string, mime_type: string, message_id: string | null): Row => ({
  id, submission_id: SUB, filename, mime_type, file_size_bytes: 2048,
  storage_path: `${FIXTURE_BROKERAGE_ORG_ID}/${SUB}/${id}/${filename}`, document_type: null,
  local_attachment_id: `local-${id}`, message_id, created_at: '2026-10-04T09:00:00+00:00',
});

function given(f: { textView?: boolean; textAtt?: boolean; emailAtt?: boolean }): void {
  mockFeatures = featuresWith(f);
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: [subRow],
      users: [{ id: FIXTURE_USER_ID, display_name: 'viewer', first_name: null, last_name: null, email: 'viewer@fixture.example.test' }],
      profiles: [{ id: FIXTURE_USER_ID, display_name: 'Viewer Fixture' }],
      submission_messages: messageRows,
      submission_attachments: [
        att('a1', 'Contract.pdf', 'application/pdf', EMAIL_MSG),
        att('a2', 'Front.jpg', 'image/jpeg', TEXT_MSG),
        att('a3', 'Porch.jpg', 'image/jpeg', PHOTO_MSG),
        att('a4', 'Old.jpg', 'image/jpeg', null),
      ],
      submission_checklists: [],
      submission_checklist_items: [],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
      checklist_templates: [],
    },
  });
}

/** The map MessageList received, as message id -> filenames. */
async function mapPassed(): Promise<Record<string, string[]>> {
  render(await SubmissionDetailPage({ params: Promise.resolve({ id: SUB }) }));
  expect(mockMessageListProps).toHaveBeenCalled();
  const props = mockMessageListProps.mock.calls.at(-1)![0] as {
    attachmentsByMessage: Record<string, { filename: string }[]>;
  };
  return Object.fromEntries(
    Object.entries(props.attachmentsByMessage).map(([k, v]) => [k, v.map((a) => a.filename)])
  );
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('review page: files inside their message bubble (BACKLOG-3748)', () => {
  it('every linked file goes to its own message; a file with no message_id goes nowhere', async () => {
    given({});
    expect(await mapPassed()).toEqual({
      [EMAIL_MSG]: ['Contract.pdf'],
      [TEXT_MSG]: ['Front.jpg'],
      [PHOTO_MSG]: ['Porch.jpg'],
    });
  });

  it('text attachments off but email attachments on: both channels still show (either-flag rule)', async () => {
    given({ textAtt: false });
    expect(await mapPassed()).toEqual({
      [EMAIL_MSG]: ['Contract.pdf'],
      [TEXT_MSG]: ['Front.jpg'],
      [PHOTO_MSG]: ['Porch.jpg'],
    });
  });

  it('email attachments off but text attachments on: both channels still show (either-flag rule)', async () => {
    given({ emailAtt: false });
    expect(await mapPassed()).toEqual({
      [EMAIL_MSG]: ['Contract.pdf'],
      [TEXT_MSG]: ['Front.jpg'],
      [PHOTO_MSG]: ['Porch.jpg'],
    });
  });

  it('text view off: text messages are gated out, so their photos are too', async () => {
    given({ textView: false });
    expect(await mapPassed()).toEqual({ [EMAIL_MSG]: ['Contract.pdf'] });
  });

  // BACKLOG-3748 S1 (SR review efcb3cec): getAttachments scopes to this
  // submission via .eq('submission_id', submissionId) at page.tsx:118. A
  // foreign submission's row whose message_id happens to point at THIS
  // submission's message must never reach the map.
  it("a foreign submission's attachment pointed at this submission's message never reaches the map", async () => {
    given({});
    mockEmulator.state.rows.submission_attachments.push({
      ...att('f1', 'OtherSubmission.jpg', 'image/jpeg', TEXT_MSG),
      submission_id: OTHER_SUB,
    });
    expect(await mapPassed()).toEqual({
      [EMAIL_MSG]: ['Contract.pdf'],
      [TEXT_MSG]: ['Front.jpg'],
      [PHOTO_MSG]: ['Porch.jpg'],
    });
  });
});
