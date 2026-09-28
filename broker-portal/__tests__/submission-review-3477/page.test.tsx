/**
 * Submission review page — BACKLOG-3477 (PR C).
 *
 * Runs the real server page (app/dashboard/submissions/[id]/page.tsx) with the
 * real feature gate, the real review-access module and the real loaders,
 * against the BACKLOG-3364 PostgREST emulator. The presentation components are
 * captured, not rendered, so each assertion reads exactly what the page
 * handed them.
 *
 * FIXTURE PROVENANCE (read-only MCP, 2026-09-27; every id invented):
 *   - status entries: shape of production transaction_submissions.status_history
 *     elements, {notes, status, changed_at, changed_by}; changed_by is null on
 *     submitted/under_review and a user id on a review decision.
 *   - typed entries: the jsonb_build_object calls in
 *     supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql
 *     §7 (checklist_review) and §8 (checklist_added).
 *   - copy-table rows: live column lists of submission_checklists,
 *     submission_checklist_items, submission_checklist_links,
 *     submission_checklist_link_members (information_schema, 2026-09-27).
 *   - RLS, emulated by what each table RETURNS to the viewer:
 *       profiles  users_can_read_own_profile (id = auth.uid()) -> the viewer's
 *                 own row only;
 *       users     users_select_public -> every member of an organization the
 *                 viewer belongs to; a removed member is absent.
 *   - can_review_submission: §3 of the same migration (member of the org with
 *     role broker / admin / it_admin).
 *   - broker_get_org_features payload: __tests__/fixtures/orgFeatures.ts
 *     (transcribed), with keys switched on through withFeature.
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
let mockFeaturePayload: { data: unknown; error: unknown } = { data: null, error: null };

const REVIEWER_ROLES = ['broker', 'admin', 'it_admin'];
/** F4: how can_review_submission answers. 'live' evaluates the membership. */
let mockReviewRpc: 'live' | 'error' | 'null' = 'live';
/** F3: the users read fails (a PostgREST error). */
let mockUsersReadFails = false;
const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name === 'broker_get_org_features') return mockFeaturePayload;
  if (name === 'can_review_submission') {
    if (mockReviewRpc === 'error') return { data: null, error: { code: 'XX000', message: 'fixture: rpc failed' } };
    if (mockReviewRpc === 'null') return { data: null, error: null };
    const ok = (mockEmulator.state.rows.organization_members ?? []).some(
      (m) =>
        m.organization_id === args?.p_org_id &&
        m.user_id === FIXTURE_USER_ID &&
        REVIEWER_ROLES.includes(m.role as string)
    );
    return { data: ok, error: null };
  }
  return { data: null, error: null };
});

function mockServerFrom(table: string) {
  const chain = mockEmulator.from(table);
  if (mockUsersReadFails && table === 'users') {
    (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { code: '42501', message: 'fixture: users read failed' }, status: 403 }).then(ok, ko);
  }
  return chain;
}

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockServerFrom(table),
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
  // For the real ChecklistReview rendered by the F4 controls.
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
// The real ChecklistReview imports these server actions; F4 never calls them.
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: jest.fn(),
  addChecklistAtReview: jest.fn(),
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

import { fireEvent, render as renderDom } from '@testing-library/react';
import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';
import { ReviewActions } from '@/components/submission/ReviewActions';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { ChecklistReview } from '@/components/submission/ChecklistReview';
import { FORMER_MEMBER, type StatusHistoryEntry } from '@/lib/submissions/history';
import type { ChecklistReviewProps } from '@/components/submission/ChecklistReview';

// pii-allow-uuid: invented fixture ids below (whole block)
const SUBMISSION_ID = '00000000-0000-4000-8000-000000347701'; // pii-allow-uuid: invented fixture id
const COLLEAGUE_ID = '00000000-0000-4000-8000-000000347702'; // pii-allow-uuid: invented fixture id
const REMOVED_ID = '00000000-0000-4000-8000-000000347703'; // pii-allow-uuid: invented fixture id
const AGENT_ID = '00000000-0000-4000-8000-000000347704'; // pii-allow-uuid: invented fixture id
const HEADER_ID = '00000000-0000-4000-8000-000000347710'; // pii-allow-uuid: invented fixture id
const ADDED_HEADER_ID = '00000000-0000-4000-8000-000000347711'; // pii-allow-uuid: invented fixture id
const ITEM_A = '00000000-0000-4000-8000-000000347720'; // pii-allow-uuid: invented fixture id
const ITEM_B = '00000000-0000-4000-8000-000000347721'; // pii-allow-uuid: invented fixture id
const TEMPLATE_A = '00000000-0000-4000-8000-000000347730'; // pii-allow-uuid: invented fixture id
const TEMPLATE_B = '00000000-0000-4000-8000-000000347731'; // pii-allow-uuid: invented fixture id

const COLLEAGUE_NAME = 'Colleague Fixture';
const VIEWER_NAME = 'Viewer Fixture';

/** Production status entry shape, values invented. */
const STATUS_HISTORY: StatusHistoryEntry[] = [
  { notes: null, status: 'submitted', changed_at: '2026-09-20T15:00:00.000000+00:00', changed_by: null },
  { notes: null, status: 'under_review', changed_at: '2026-09-20T15:05:00.000000+00:00', changed_by: null },
  // §7 jsonb_build_object keys, in order.
  {
    type: 'checklist_review',
    changed_at: '2026-09-20T15:10:00.000000+00:00',
    changed_by: COLLEAGUE_ID,
    field: 'reviewer_checked',
    from: false,
    to: true,
    item_id: ITEM_A,
    item_title: 'Title commitment',
    checklist_name: 'Contract',
  },
  {
    type: 'checklist_review',
    changed_at: '2026-09-20T15:11:00.000000+00:00',
    changed_by: REMOVED_ID,
    field: 'reviewer_checked',
    from: true,
    to: false,
    item_id: ITEM_B,
    item_title: 'Closing disclosure',
    checklist_name: 'Contract',
  },
  // §8 jsonb_build_object keys, in order.
  {
    type: 'checklist_added',
    changed_at: '2026-09-20T15:12:00.000000+00:00',
    changed_by: COLLEAGUE_ID,
    checklist_id: ADDED_HEADER_ID,
    checklist_name: 'Lead-Based Paint',
    template_id: TEMPLATE_B,
  },
];

function submissionRow(status: string): Row {
  return {
    id: SUBMISSION_ID,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    submitted_by: AGENT_ID,
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
    created_at: '2026-09-20T15:00:00.000000+00:00',
    status_history: STATUS_HISTORY,
  };
}

function given(role: string, status = 'under_review'): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [
        brokerageMembership(role),
        { ...brokerageMembership('broker'), id: 'm-colleague', user_id: COLLEAGUE_ID },
      ],
      transaction_submissions: [submissionRow(status)],
      // users_select_public: same-org members; the removed member is absent.
      users: [
        { id: FIXTURE_USER_ID, display_name: VIEWER_NAME, first_name: null, last_name: null, email: 'viewer@fixture.example.test' },
        { id: COLLEAGUE_ID, display_name: COLLEAGUE_NAME, first_name: null, last_name: null, email: 'colleague@fixture.example.test' },
      ],
      // users_can_read_own_profile: the viewer's own row only.
      profiles: [{ id: FIXTURE_USER_ID, display_name: VIEWER_NAME }],
      submission_checklists: [
        { id: HEADER_ID, submission_id: SUBMISSION_ID, template_name: 'Contract', created_at: '2026-09-20T15:00:00+00:00', sort_order: 0, template_id: TEMPLATE_A, added_at_review_by: null, added_at_review_at: null },
        {
          id: ADDED_HEADER_ID,
          submission_id: SUBMISSION_ID,
          template_name: 'Lead-Based Paint',
          created_at: '2026-09-20T15:12:00+00:00',
          sort_order: 1,
          template_id: TEMPLATE_B,
          added_at_review_by: COLLEAGUE_ID,
          added_at_review_at: '2026-09-20T15:12:00+00:00',
        },
      ],
      submission_checklist_items: [
        { id: ITEM_A, submission_id: SUBMISSION_ID, submission_checklist_id: HEADER_ID, title: 'Title commitment', is_required: true, is_checked: true, note: 'Signed copy attached', sort_order: 0, created_at: '2026-09-20T15:00:00+00:00', reviewer_checked: true, reviewer_checked_by: COLLEAGUE_ID, reviewer_checked_at: '2026-09-20T15:10:00+00:00', description: null, expected_document_type: null },
        { id: ITEM_B, submission_id: SUBMISSION_ID, submission_checklist_id: HEADER_ID, title: 'Closing disclosure', is_required: true, is_checked: false, note: null, sort_order: 1, created_at: '2026-09-20T15:00:00+00:00', reviewer_checked: false, reviewer_checked_by: null, reviewer_checked_at: null, description: null, expected_document_type: null },
      ],
      submission_checklist_links: [],
      submission_checklist_link_members: [],
      checklist_templates: [
        { id: TEMPLATE_A, organization_id: FIXTURE_BROKERAGE_ORG_ID, name: 'Contract', sort_order: 0, archived_at: null },
        { id: TEMPLATE_B, organization_id: FIXTURE_BROKERAGE_ORG_ID, name: 'Lead-Based Paint', sort_order: 1, archived_at: null },
      ],
    },
  });
}

const PORTAL_ON = withFeature(ORG_WITHOUT_PLAN_FEATURES, 'broker_portal_access', true);
const CHECKLISTS_ON = withFeature(PORTAL_ON, 'transaction_checklists', true);
const CHECKLISTS_OFF = withFeature(PORTAL_ON, 'transaction_checklists', false);

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

async function render(): Promise<React.ReactElement> {
  return (await SubmissionDetailPage({ params: Promise.resolve({ id: SUBMISSION_ID }) })) as React.ReactElement;
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  mockFeaturePayload = { data: CHECKLISTS_ON, error: null };
  mockReviewRpc = 'live';
  mockUsersReadFails = false;
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('Status History actor names (C5)', () => {
  it('a live colleague renders by name; a removed member renders as a former member', async () => {
    given('admin');
    const props = findProps<{ history: StatusHistoryEntry[] }>(await render(), StatusHistory)!;
    const byTitle = (t: string) => props.history.find((e) => e.item_title === t)!;
    expect(byTitle('Title commitment').changed_by).toBe(COLLEAGUE_NAME);
    expect(byTitle('Closing disclosure').changed_by).toBe(FORMER_MEMBER);
    expect(props.history.find((e) => e.type === 'checklist_added')!.changed_by).toBe(COLLEAGUE_NAME);
    // Status entries with no actor stay unattributed, never "former".
    expect(props.history.filter((e) => e.status).map((e) => e.changed_by)).toEqual([undefined, undefined]);
  });

  it('the rendered timeline shows names and never a raw actor id', async () => {
    given('admin');
    const props = findProps<React.ComponentProps<typeof StatusHistory>>(await render(), StatusHistory)!;
    const { StatusHistory: RealStatusHistory } = jest.requireActual('@/components/submission/StatusHistory');
    const { container } = renderDom(<RealStatusHistory {...props} />);
    // Grouped (founder decision 795ff7c5): the three typed entries follow the
    // latest status change, collapsed until opened.
    const group = container.querySelector('[data-testid="pending-history-group"]')!;
    expect(group.textContent).toContain('3 checklist changes since the last review');
    expect(container.textContent).not.toContain(`by ${COLLEAGUE_NAME}`);
    fireEvent.click(group.querySelector('button[aria-expanded="false"]')!);
    expect(group.querySelectorAll('[data-testid="typed-history-entry"]')).toHaveLength(3);
    expect(container.textContent).toContain(`by ${COLLEAGUE_NAME}`);
    expect(container.textContent).toContain(`by ${FORMER_MEMBER}`);
    for (const id of [COLLEAGUE_ID, REMOVED_ID]) expect(container.innerHTML).not.toContain(id);
    // No raw id of any kind (actor, item, checklist, template) with the group open.
    expect(container.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('F3: when the users read fails, nobody is named and nobody is "a former member"', async () => {
    given('admin');
    mockUsersReadFails = true;
    const el = await render();
    const props = findProps<React.ComponentProps<typeof StatusHistory>>(el, StatusHistory)!;
    expect(props.history.map((e) => e.changed_by)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const { StatusHistory: RealStatusHistory } = jest.requireActual('@/components/submission/StatusHistory');
    const { container } = renderDom(<RealStatusHistory {...props} />);
    for (const b of Array.from(container.querySelectorAll('[data-testid="checklist-changes-group"] > button'))) fireEvent.click(b);
    expect(container.querySelectorAll('[data-testid="typed-history-entry"]')).toHaveLength(3);
    expect(container.textContent).not.toContain(FORMER_MEMBER);
    expect(container.textContent).not.toMatch(/\bby /);
    for (const id of [COLLEAGUE_ID, REMOVED_ID]) expect(container.innerHTML).not.toContain(id);
    expect(findProps<ChecklistReviewProps>(el, ChecklistReview)!.names).toBeNull();
  });

  it('names are read from users, never profiles', async () => {
    given('admin');
    await render();
    const tables = mockEmulator.state.selects.map((s) => s.table);
    expect(tables).toContain('users');
    expect(tables).not.toContain('profiles');
  });
});

describe('Checklists area gate (fail-closed)', () => {
  it('renders the area with the loaded sections when the feature is on', async () => {
    given('admin');
    const props = findProps<ChecklistReviewProps>(await render(), ChecklistReview)!;
    expect(props).not.toBeNull();
    expect(props.loaded).toBe(true);
    expect(props.sections.map((s) => s.name)).toEqual(['Contract', 'Lead-Based Paint']);
    expect(props.canTick).toBe(true);
    expect(props.names?.[COLLEAGUE_ID]).toBe(COLLEAGUE_NAME);
    expect(props.templates.map((t) => t.id)).toEqual([TEMPLATE_A, TEMPLATE_B]);
  });

  it('is absent when the feature is off', async () => {
    given('admin');
    mockFeaturePayload = { data: CHECKLISTS_OFF, error: null };
    expect(findProps(await render(), ChecklistReview)).toBeNull();
  });

  it('is absent when the feature read fails, even though the fail-open page still renders', async () => {
    given('admin');
    mockFeaturePayload = { data: null, error: { message: 'rpc down' } };
    const el = await render();
    expect(findProps(el, StatusHistory)).not.toBeNull();
    expect(findProps(el, ChecklistReview)).toBeNull();
  });
});

describe('F4: can_review_submission fails closed', () => {
  it.each([
    ['errors', 'error'],
    ['returns null', 'null'],
  ] as const)('when it %s, the checklists render with no ticking and no Add', async (_name, mode) => {
    given('admin');
    mockReviewRpc = mode;
    const props = findProps<ChecklistReviewProps>(await render(), ChecklistReview)!;
    expect(props.canTick).toBe(false);
    const { ChecklistReview: RealChecklistReview } = jest.requireActual('@/components/submission/ChecklistReview');
    const { container, getByRole } = renderDom(<RealChecklistReview {...props} />);
    getByRole('button', { name: 'Expand all' }).click();
    expect(container.querySelectorAll('[data-testid="checklist-item"]').length).toBeGreaterThan(0);
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    // BACKLOG-3596: nothing to tick. Every broker checkbox is a disabled,
    // read-only record (an item already checked by someone else stays checked).
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(labels).not.toContain('Add checklist');
  });

  it('control: the live answer for an admin does show ticking and Add', async () => {
    given('admin');
    const props = findProps<ChecklistReviewProps>(await render(), ChecklistReview)!;
    const { ChecklistReview: RealChecklistReview } = jest.requireActual('@/components/submission/ChecklistReview');
    const { container, getByRole } = renderDom(<RealChecklistReview {...props} />);
    getByRole('button', { name: 'Expand all' }).click();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).toContain('Add checklist');
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    expect(boxes.every((b) => !b.disabled)).toBe(true);
  });
});

/**
 * BACKLOG-3596: whether a newer version exists, in ANY status. Child rows
 * carry the live transaction_submissions columns the page reads
 * (parent_submission_id, status); a version still uploading counts, because
 * the tick RPC refuses as soon as the child row exists (PR 1 migration §5).
 */
describe('superseded version (BACKLOG-3596)', () => {
  const CHILD_ID = '00000000-0000-4000-8000-000000359601'; // pii-allow-uuid: invented fixture id
  function withChild(status: string | null): void {
    given('broker', 'needs_changes');
    const rows = mockEmulator.state.rows;
    if (status) {
      rows.transaction_submissions = [
        ...(rows.transaction_submissions ?? []),
        { ...submissionRow(status), id: CHILD_ID, parent_submission_id: SUBMISSION_ID, status_history: [] },
      ];
    }
  }

  it.each([
    [null, null],
    ['resubmitted', 'newer'],
    ['under_review', 'newer'],
    ['uploading', 'uploading'],
  ] as const)('child %s -> supersededBy %s', async (child, expected) => {
    withChild(child);
    expect(findProps<ChecklistReviewProps>(await render(), ChecklistReview)!.supersededBy).toBe(expected);
  });

  it('the real component closes every checkbox on a superseded version, with the reason', async () => {
    withChild('uploading');
    const props = findProps<ChecklistReviewProps>(await render(), ChecklistReview)!;
    const { ChecklistReview: RealChecklistReview } = jest.requireActual('@/components/submission/ChecklistReview');
    const { container, getByText } = renderDom(<RealChecklistReview {...props} />);
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(getByText('A newer version of this submission is being sent, so this version is closed.')).toBeTruthy();
  });
});

describe('Roles (C7)', () => {
  it('a broker gets review decisions, with the checklist hint', async () => {
    given('broker');
    const props = findProps<{ canDecide: boolean; showChecklistHint: boolean }>(await render(), ReviewActions)!;
    expect(props.canDecide).toBe(true);
    expect(props.showChecklistHint).toBe(true);
  });

  it('an it_admin gets no review decisions but can tick', async () => {
    given('it_admin');
    const el = await render();
    expect(findProps(el, ReviewActions)).toBeNull();
    expect(findProps<ChecklistReviewProps>(el, ChecklistReview)!.canTick).toBe(true);
    // The added-at-review banner must not point an it_admin at Request Changes.
    expect(findProps<ChecklistReviewProps>(el, ChecklistReview)!.canDecide).toBe(false);
  });

  it('a broker is told the banner may point at Request Changes', async () => {
    given('broker');
    expect(findProps<ChecklistReviewProps>(await render(), ChecklistReview)!.canDecide).toBe(true);
  });

  it('an it_admin opening a submitted submission does not mark it under review', async () => {
    given('it_admin', 'submitted');
    await render();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it('an admin opening a submitted submission marks it under review', async () => {
    given('admin', 'submitted');
    await render();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEmulator.state.writes).toEqual([
      { table: 'transaction_submissions', op: 'update', values: { status: 'under_review' } },
    ]);
  });
});
