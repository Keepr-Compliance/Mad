/**
 * Submission review page — BACKLOG-3607, PR 3: what the page hands ChecklistReview.
 *
 * Runs the real server page with the real loaders against the BACKLOG-3364
 * PostgREST emulator (same plumbing as __tests__/submission-review-3477/page.test.tsx);
 * ChecklistReview and StatusHistory are captured, not rendered.
 *
 * FIXTURE PROVENANCE (every id and name invented):
 *   - history entries: jsonb_build_object in
 *     supabase/migrations/20260929120000_backlog_3607_checklist_add_remove.sql :509-524
 *     (carry version diff, written on the NEW version's row).
 *   - header rows: the live submission_checklists columns plus the four the 3607
 *     migration adds (§1). Link-member rows: live columns (information_schema,
 *     2026-09-27, as the 3477 page test). submission_attachments.local_attachment_id
 *     and submission_messages.local_message_id: the columns the remove RPC counts
 *     on (migration :773-782).
 *   - A parent version's own removal entry sits on the PARENT's row.
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

import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';
import { ChecklistReview, type ChecklistReviewProps } from '@/components/submission/ChecklistReview';
import { StatusHistory } from '@/components/submission/StatusHistory';
import type { StatusHistoryEntry } from '@/lib/submissions/history';

// pii-allow-uuid: invented fixture ids below (whole block)
const V1 = '00000000-0000-4000-8000-000000360710'; // pii-allow-uuid: invented fixture id
const V2 = '00000000-0000-4000-8000-000000360711'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000360712'; // pii-allow-uuid: invented fixture id
const V1_HEADER_GONE = '00000000-0000-4000-8000-000000360713'; // pii-allow-uuid: invented fixture id
const V0_HEADER_OLD = '00000000-0000-4000-8000-000000360714'; // pii-allow-uuid: invented fixture id
const HDR_LIVE = '00000000-0000-4000-8000-000000360715'; // pii-allow-uuid: invented fixture id
const HDR_REMOVED = '00000000-0000-4000-8000-000000360716'; // pii-allow-uuid: invented fixture id
const TPL_A = '00000000-0000-4000-8000-000000360717'; // pii-allow-uuid: invented fixture id
const TPL_B = '00000000-0000-4000-8000-000000360718'; // pii-allow-uuid: invented fixture id
const TPL_GONE = '00000000-0000-4000-8000-000000360719'; // pii-allow-uuid: invented fixture id
const TPL_OLD = '00000000-0000-4000-8000-000000360720'; // pii-allow-uuid: invented fixture id

const removalEntry = (key: string, name: string, removedId: string, fromVersion: number, at: string): StatusHistoryEntry =>
  ({
    type: 'checklist_removed',
    changed_at: at,
    changed_by: AGENT_ID,
    source: 'version',
    checklist_key: key,
    template_id: key,
    checklist_name: name,
    from_version: fromVersion,
    removed_checklist_id: removedId,
  }) as StatusHistoryEntry;

// The PARENT's own removal (v0 -> v1): must never be offered on v2.
const V1_HISTORY: StatusHistoryEntry[] = [
  removalEntry(TPL_OLD, 'legacy checklist', V0_HEADER_OLD, 0, '2026-09-27T09:00:00+00:00'),
  { status: 'resubmitted', changed_at: '2026-09-27T09:00:01+00:00', changed_by: null, notes: null },
];
const V2_HISTORY: StatusHistoryEntry[] = [
  removalEntry(TPL_GONE, 'disclosures', V1_HEADER_GONE, 1, '2026-09-28T09:00:00+00:00'),
  { status: 'resubmitted', changed_at: '2026-09-28T09:00:01+00:00', changed_by: null, notes: null },
];

function subRow(id: string, version: number, parent: string | null, history: StatusHistoryEntry[], status: string): Row {
  return {
    id,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    submitted_by: AGENT_ID,
    local_transaction_id: 'deal-1',
    version,
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
    parent_submission_id: parent,
    created_at: version === 1 ? '2026-09-27T09:00:00+00:00' : '2026-09-28T09:00:00+00:00',
    status_history: history,
  };
}

const header = (id: string, tpl: string, name: string, order: number, removedBy: string | null): Row => ({
  id,
  submission_id: V2,
  template_id: tpl,
  template_name: name,
  sort_order: order,
  added_at_review_by: null,
  added_at_review_at: null,
  removed_at_review_by: removedBy,
  removed_at_review_at: removedBy ? '2026-09-28T10:00:00+00:00' : null,
  restored_from_checklist_id: null,
});
const itemRow = (id: string, hdr: string): Row => ({
  id,
  submission_id: V2,
  submission_checklist_id: hdr,
  title: id,
  description: null,
  is_required: true,
  is_checked: false,
  note: null,
  sort_order: 0,
  reviewer_checked: false,
  reviewer_checked_by: null,
  reviewer_checked_at: null,
  cleared_reviewer_id: null,
  cleared_at: null,
  restored_from_item_id: null,
});
const link = (id: string, itemId: string, kind: string): Row => ({ id, submission_id: V2, submission_checklist_item_id: itemId, kind, label: id, sort_order: 0 });
const member = (linkId: string, kind: string, att: string | null, msg: string | null): Row => ({
  link_id: linkId,
  submission_id: V2,
  kind,
  submission_attachment_id: att,
  submission_message_id: msg,
});

function given(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: [subRow(V1, 1, null, V1_HISTORY, 'needs_changes'), subRow(V2, 2, V1, V2_HISTORY, 'under_review')],
      users: [{ id: FIXTURE_USER_ID, display_name: 'viewer', first_name: null, last_name: null, email: 'viewer@fixture.example.test' }],
      profiles: [{ id: FIXTURE_USER_ID, display_name: 'Viewer Fixture' }],
      submission_checklists: [header(HDR_LIVE, TPL_A, 'Purchase Contract', 0, null), header(HDR_REMOVED, TPL_B, 'Inspection', 1, FIXTURE_USER_ID)],
      submission_checklist_items: [itemRow('item-a', HDR_LIVE), itemRow('item-b', HDR_LIVE), itemRow('item-r', HDR_REMOVED)],
      submission_checklist_links: [link('l1', 'item-a', 'attachment'), link('l2', 'item-b', 'attachment'), link('l3', 'item-b', 'email'), link('l4', 'item-r', 'attachment')],
      submission_checklist_link_members: [
        member('l1', 'attachment', 'att-1', null),
        member('l2', 'attachment', 'att-1b', null), // same local file as att-1
        member('l2', 'attachment', 'att-nolocal', null), // no local id: not counted
        member('l3', 'email', null, 'msg-1'),
        member('l4', 'attachment', 'att-2', null),
      ],
      submission_attachments: [
        { id: 'att-1', submission_id: V2, filename: 'a.pdf', mime_type: null, file_size_bytes: null, storage_path: null, document_type: null, local_attachment_id: 'L-1' },
        { id: 'att-1b', submission_id: V2, filename: 'a.pdf', mime_type: null, file_size_bytes: null, storage_path: null, document_type: null, local_attachment_id: 'L-1' },
        { id: 'att-nolocal', submission_id: V2, filename: 'b.pdf', mime_type: null, file_size_bytes: null, storage_path: null, document_type: null, local_attachment_id: null },
        { id: 'att-2', submission_id: V2, filename: 'c.pdf', mime_type: null, file_size_bytes: null, storage_path: null, document_type: null, local_attachment_id: 'L-2' },
      ],
      submission_messages: [
        { id: 'msg-1', submission_id: V2, channel: 'email', direction: 'inbound', subject: 's', body_text: null, sent_at: '2026-09-28T08:00:00+00:00', has_attachments: false, attachment_count: 0, thread_id: null, message_type: 'text', participants: null, local_message_id: 'M-1' },
      ],
      checklist_templates: [],
    },
  });
}

function findProps<P>(node: unknown, type: unknown): P | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return el.props as P;
  return findProps<P>(el.props?.children, type);
}

async function renderPage(): Promise<React.ReactElement> {
  return (await SubmissionDetailPage({ params: Promise.resolve({ id: V2 }) })) as React.ReactElement;
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  given();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('review page wiring (BACKLOG-3607)', () => {
  it("the removal notice reads THIS version's history only, never the parent chain", async () => {
    const el = await renderPage();
    const props = findProps<ChecklistReviewProps>(el, ChecklistReview)!;
    const history = props.versionHistory as StatusHistoryEntry[];
    const keys = history.filter((e) => e.type === 'checklist_removed').map((e) => e.checklist_key);
    expect(keys).toEqual([TPL_GONE]);
    // The timeline still shows both versions' lines.
    const timeline = findProps<{ history: StatusHistoryEntry[] }>(el, StatusHistory)!.history;
    expect(timeline.filter((e) => e.type === 'checklist_removed').map((e) => e.checklist_key)).toEqual([TPL_OLD, TPL_GONE]);
  });

  it('passes the version number and the removal markers', async () => {
    const props = findProps<ChecklistReviewProps>(await renderPage(), ChecklistReview)!;
    expect(props.version).toBe(2);
    expect(props.sections.map((s) => [s.name, s.removedAtReviewBy ?? null])).toEqual([
      ['Purchase Contract', null],
      ['Inspection', FIXTURE_USER_ID],
    ]);
  });

  it('confirm counts per checklist: distinct local ids, none without one, emails apart', async () => {
    const props = findProps<ChecklistReviewProps>(await renderPage(), ChecklistReview)!;
    expect(props.linkedCounts).toEqual({
      [HDR_LIVE]: { documents: 1, emails: 1 },
      [HDR_REMOVED]: { documents: 1, emails: 0 },
    });
  });

  it('N-3: counts are not cut by the server row cap (every block is read)', async () => {
    // Four emails linked to Purchase Contract; the emulated server returns at
    // most 2 rows per response, as PostgREST's max-rows does at 1000.
    const rows = mockEmulator.state.rows;
    for (const n of [2, 3, 4]) {
      rows.submission_messages.push({
        ...rows.submission_messages[0],
        id: `msg-${n}`,
        sent_at: `2026-09-28T0${n}:00:00+00:00`,
        local_message_id: `M-${n}`,
      });
      rows.submission_checklist_link_members.push(member('l3', 'email', null, `msg-${n}`));
    }
    mockEmulator.set({ maxRows: 2 });
    const el = await renderPage();
    const props = findProps<ChecklistReviewProps>(el, ChecklistReview)!;
    expect(props.linkedCounts).toEqual({
      [HDR_LIVE]: { documents: 1, emails: 4 },
      [HDR_REMOVED]: { documents: 1, emails: 0 },
    });
    // The page shows every message, not the first block.
    expect(props.messages.map((m) => m.id).sort()).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });
});
