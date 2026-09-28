/**
 * My Transactions, one submission: the checklists section — BACKLOG-3593.
 *
 * The REAL gate, REAL feature gate (broker_get_org_features answered with the
 * transcribed ORG_WITHOUT_PLAN_FEATURES payload plus the two keys this page
 * reads), REAL loaders and the REAL ChecklistReview, against the PostgREST
 * emulator (no RLS: every scope asserted here is the portal query's own).
 *
 * FIXTURE PROVENANCE (read-only MCP, 2026-09-27; every id and value invented):
 *   - copy-table columns: information_schema.columns for submission_checklists,
 *     submission_checklist_items, submission_checklist_links,
 *     submission_checklist_link_members.
 *   - shape: the live QA submission — 3 checklists, the third added at review;
 *     4 + 2 + 3 items; required 2 / 1 / 1; agent ticks 2 / 1 / 0; 3 reviewer
 *     ticks, all in the first checklist; 1 note. It has no links; one link per
 *     kind is added here so the View chips have something to open.
 *   - RLS: the four SELECT policies admit `ts.submitted_by = auth.uid()`
 *     (policy text in pm_comments on BACKLOG-3593); the page reads through the
 *     gate's session client only.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, FIXTURE_USER_ID, brokerageMembership, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { attachmentRow, historyEntry, messageRow, submissionRow, userNameRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
/** Tables whose read returns a PostgREST error. */
let mockFailingTables: string[] = [];
let mockChecklistKey: 'on' | 'off' | 'absent' = 'on';

const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name !== 'broker_get_org_features') return { data: null, error: null };
  let payload = withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: String(args?.p_org_id) }, 'portal_my_transactions', true);
  if (mockChecklistKey !== 'absent') payload = withFeature(payload, 'transaction_checklists', mockChecklistKey === 'on');
  return { data: payload, error: null };
});

function mockServerFrom(table: string) {
  const chain = mockEmulator.from(table);
  if (mockFailingTables.includes(table)) {
    (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { code: '42501', message: `fixture: ${table} read failed` }, status: 403 }).then(ok, ko);
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
  createServiceClient: jest.fn(() => ({ from: (table: string) => mockServerFrom(table), rpc: mockRpc })),
}));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('@/lib/impersonation-guards', () => {
  const actual = jest.requireActual('@/lib/impersonation-guards');
  return { ...actual, getDataClient: jest.fn(actual.getDataClient) };
});
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: jest.fn(),
  addChecklistAtReview: jest.fn(),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: (table: string) => {
      throw new Error(`browser table read: ${table}`);
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.fixture.test/x' }, error: null }) }) },
  }),
}));
jest.mock('heic2any', () => jest.fn());
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new NotFound();
  },
  usePathname: () => '/dashboard/my-transactions',
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import MyTransactionDetailPage from '@/app/dashboard/my-transactions/[id]/page';
import { ChecklistReview, type ChecklistReviewProps } from '@/components/submission/ChecklistReview';
import { getImpersonationSession } from '@/lib/impersonation';
import { getDataClient } from '@/lib/impersonation-guards';
import { createServiceClient } from '@/lib/supabase/service';
import { FORMER_MEMBER } from '@/lib/submissions/history';

// ---------------------------------------------------------------------------
// Fixture (every id invented)
// ---------------------------------------------------------------------------

const BROKERAGE = FIXTURE_BROKERAGE_ORG_ID;
const AGENT = FIXTURE_USER_ID;
const SUB = '00000000-0000-4000-8000-000000359301'; // pii-allow-uuid: invented fixture id
const REVIEWER = '00000000-0000-4000-8000-0000003593c1'; // pii-allow-uuid: invented fixture id
const REMOVED = '00000000-0000-4000-8000-0000003593c2'; // pii-allow-uuid: invented fixture id
const H1 = '00000000-0000-4000-8000-0000003593a1'; // pii-allow-uuid: invented fixture id
const H2 = '00000000-0000-4000-8000-0000003593a2'; // pii-allow-uuid: invented fixture id
const H3 = '00000000-0000-4000-8000-0000003593a3'; // pii-allow-uuid: invented fixture id
const T = (n: number) => `00000000-0000-4000-8000-0000003593b${n}`; // pii-allow-uuid: invented fixture id template
const I = (n: number) => `00000000-0000-4000-8000-0000003593d${n}`; // pii-allow-uuid: invented fixture id template
const L = (n: number) => `00000000-0000-4000-8000-0000003593e${n}`; // pii-allow-uuid: invented fixture id template
const ATT = '00000000-0000-4000-8000-0000003593f1'; // pii-allow-uuid: invented fixture id
const MSG = '00000000-0000-4000-8000-0000003593f2'; // pii-allow-uuid: invented fixture id

const REVIEWER_NAME = 'Reviewer Fixture';
const USER_IDS = [AGENT, REVIEWER, REMOVED];

const header = (id: string, name: string, sort: number, tpl: string, addedBy: string | null = null): Row => ({
  id,
  submission_id: SUB,
  template_name: name,
  created_at: '2026-09-20T15:00:00+00:00',
  sort_order: sort,
  template_id: tpl,
  added_at_review_by: addedBy,
  added_at_review_at: addedBy ? '2026-09-20T15:30:00+00:00' : null,
});

const itemRow = (
  id: string,
  headerId: string,
  title: string,
  sort: number,
  o: { req?: boolean; ticked?: boolean; note?: string; desc?: string; reviewedBy?: string } = {}
): Row => ({
  id,
  submission_id: SUB,
  submission_checklist_id: headerId,
  title,
  is_required: o.req ?? false,
  is_checked: o.ticked ?? false,
  note: o.note ?? null,
  sort_order: sort,
  created_at: '2026-09-20T15:00:00+00:00',
  reviewer_checked: !!o.reviewedBy,
  reviewer_checked_by: o.reviewedBy ?? null,
  reviewer_checked_at: o.reviewedBy ? '2026-09-20T15:20:00+00:00' : null,
  description: o.desc ?? null,
  expected_document_type: null,
});

const CHECKLISTS: Row[] = [header(H1, 'Purchase Contract', 0, T(1)), header(H2, 'Disclosures', 1, T(2)), header(H3, 'Lead-Based Paint', 2, T(3), REVIEWER)];
const ITEMS: Row[] = [
  itemRow(I(1), H1, 'Executed contract', 0, { req: true, ticked: true, note: 'Signed by both parties', desc: 'All pages', reviewedBy: REVIEWER }),
  itemRow(I(2), H1, 'Earnest money receipt', 1, { req: true, ticked: true, desc: 'Bank receipt', reviewedBy: REMOVED }),
  itemRow(I(3), H1, 'Counter offers', 2, { reviewedBy: REVIEWER }),
  itemRow(I(4), H1, 'Addenda', 3),
  itemRow(I(5), H2, 'Seller disclosure', 0, { req: true, ticked: true, desc: 'Signed' }),
  itemRow(I(6), H2, 'HOA documents', 1),
  itemRow(I(7), H3, 'Lead-based paint disclosure', 0, { req: true }),
  itemRow(I(8), H3, 'EPA pamphlet', 1),
  itemRow(I(9), H3, 'Inspection waiver', 2),
];
const LINKS: Row[] = [
  { id: L(1), submission_id: SUB, submission_checklist_item_id: I(1), kind: 'attachment', label: 'contract-signed.pdf', sort_order: 0, created_at: '2026-09-20T15:00:00+00:00' },
  { id: L(2), submission_id: SUB, submission_checklist_item_id: I(5), kind: 'email', label: 'Disclosure email', sort_order: 0, created_at: '2026-09-20T15:00:00+00:00' },
];
const LINK_MEMBERS: Row[] = [
  { id: L(3), submission_id: SUB, link_id: L(1), kind: 'attachment', submission_attachment_id: ATT, submission_message_id: null },
  { id: L(4), submission_id: SUB, link_id: L(2), kind: 'email', submission_attachment_id: null, submission_message_id: MSG },
];
const CHECKLIST_TABLES = ['submission_checklist_items', 'submission_checklist_link_members', 'submission_checklist_links', 'submission_checklists'];

function given(opts: { checklists?: Row[]; items?: Row[]; impersonating?: boolean } = {}): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: AGENT, email: 'agent-3593@fixture.example.test' } } });
  (getImpersonationSession as jest.Mock).mockResolvedValue(
    opts.impersonating ? { target_email: 'target@fixture.example.test', target_name: 'Target Fixture' } : null
  );
  mockEmulator.reset();
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organization_members: [brokerageMembership('agent')],
      transaction_submissions: [
        submissionRow({
          id: SUB,
          organizationId: BROKERAGE,
          submittedBy: AGENT,
          address: '12 Fixture Street',
          status: 'under_review',
          // Production shape: changed_by is null on submitted / under_review, so the
          // reviewer's name can only come from the checklist actors.
          statusHistory: [historyEntry('submitted'), historyEntry('under_review')],
        }),
      ],
      submission_messages: [{ ...messageRow({ id: MSG, submissionId: SUB, subject: 'Disclosure email' }) }],
      submission_attachments: [attachmentRow({ id: ATT, submissionId: SUB, organizationId: BROKERAGE, filename: 'contract-signed.pdf', mimeType: 'application/pdf' })],
      users: [userNameRow(AGENT, 'Agent Fixture', 'agent@fixture.example.test'), userNameRow(REVIEWER, REVIEWER_NAME, 'reviewer@fixture.example.test')],
      submission_checklists: opts.checklists ?? CHECKLISTS,
      submission_checklist_items: opts.items ?? ITEMS,
      submission_checklist_links: LINKS,
      submission_checklist_link_members: LINK_MEMBERS,
    },
  });
}

const tablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();
const featureRpcCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'broker_get_org_features');

async function page(): Promise<React.ReactElement> {
  return (await MyTransactionDetailPage({ params: Promise.resolve({ id: SUB }) })) as React.ReactElement;
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

function renderExpanded(element: React.ReactElement) {
  const view = render(element);
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  return view;
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  mockFailingTables = [];
  mockChecklistKey = 'on';
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('fixture shape', () => {
  it('matches the QA submission: 3 checklists (1 added at review), 9 items, 3 agent ticks, 3 reviewer ticks', () => {
    expect(CHECKLISTS).toHaveLength(3);
    expect(CHECKLISTS.filter((h) => h.added_at_review_by)).toHaveLength(1);
    expect(ITEMS).toHaveLength(9);
    expect(ITEMS.filter((i) => i.is_checked)).toHaveLength(3);
    expect(ITEMS.filter((i) => i.reviewer_checked)).toHaveLength(3);
  });
});

describe('the section renders for the agent', () => {
  it('passes viewer="agent" with the three checklists, read through the session client', async () => {
    given();
    const element = await page();
    const props = findProps<ChecklistReviewProps>(element, ChecklistReview)!;
    expect(props).not.toBeNull();
    expect(props.viewer).toBe('agent');
    expect(props.sections.map((s) => s.name)).toEqual(['Purchase Contract', 'Disclosures', 'Lead-Based Paint']);
    expect(props.sections.flatMap((s) => s.items)).toHaveLength(9);
    expect(tablesRead()).toEqual(expect.arrayContaining(CHECKLIST_TABLES));
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(getDataClient).not.toHaveBeenCalled();
  });

  it('shows counts, names, notes and the added-at-review banner with no call to act', async () => {
    given();
    renderExpanded(await page());
    const heading = screen.getByRole('heading', { name: 'Checklists' }).parentElement!;
    expect(heading).toHaveTextContent('3 of 4 required');
    expect(screen.getByRole('button', { name: /^Purchase Contract/ })).toHaveTextContent('2 of 2 required');
    expect(screen.getByRole('button', { name: /^Lead-Based Paint/ })).toHaveTextContent('0 of 1 required');
    expect(screen.getAllByTestId('checklist-item')).toHaveLength(9);
    expect(screen.getByText('Signed by both parties')).toBeInTheDocument();
    const banner = screen.getByText(/at review\./).closest('p')!;
    expect(banner.textContent).toBe(`Added by ${REVIEWER_NAME} at review.`);
    expect(document.body.textContent).not.toMatch(/Request Changes|next version/);
  });

  it('no tick, Add or Mark reviewed control', async () => {
    given();
    renderExpanded(await page());
    const card = screen.getByTestId('checklist-review');
    const labels = within(card)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
      .sort();
    expect(labels).toEqual(
      [
        'Collapse all',
        'Disclosures1 of 1 required',
        'Expand all',
        'Lead-Based PaintAdded0 of 1 required',
        'Purchase Contract2 of 2 required',
        'View Disclosure email',
        'View contract-signed.pdf',
      ].sort()
    );
    expect(within(card).queryByText('Mark reviewed')).toBeNull();
    expect(within(card).queryByText(/Add checklist/)).toBeNull();
    expect(card.querySelector('[aria-pressed]')).toBeNull();
  });

  it('reviewer pills are display-only: who and when, on the two reviewed pill rows', async () => {
    given();
    renderExpanded(await page());
    const pills = screen.getAllByTestId('reviewer-status');
    expect(pills).toHaveLength(2);
    for (const p of pills) {
      expect(within(p).queryByRole('button')).toBeNull();
      expect(within(p).getByText('Reviewed').tagName).toBe('SPAN');
    }
    const meta = pills.map((p) => within(p).getByTestId('reviewer-meta').textContent);
    expect(meta[0]).toMatch(new RegExp(`^${REVIEWER_NAME} · `));
    expect(meta[1]).toMatch(new RegExp(`^${FORMER_MEMBER} · `));
  });

  it('no raw ids anywhere in the rendered page', async () => {
    given();
    const { container } = renderExpanded(await page());
    for (const id of USER_IDS) expect(container.innerHTML).not.toContain(id);
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('a failed users read: nobody named, nobody a former member, no ids', async () => {
    given();
    mockFailingTables = ['users'];
    const { container } = renderExpanded(await page());
    expect(screen.getByText('Added at review.')).toBeInTheDocument();
    expect(container.textContent).not.toContain(FORMER_MEMBER);
    for (const id of USER_IDS) expect(container.innerHTML).not.toContain(id);
  });

  it('View chips open the existing viewers', async () => {
    given();
    renderExpanded(await page());
    expect(screen.queryAllByText('body of Disclosure email')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'View Disclosure email' }));
    expect(screen.getAllByText('body of Disclosure email').length).toBeGreaterThan(0);
  });

  it('zero checklists: the section says none were submitted', async () => {
    given({ checklists: [], items: [] });
    render(await page());
    expect(screen.getByText('No checklists were submitted with this transaction.')).toBeInTheDocument();
  });

  it('one feature read per render, on the brokerage', async () => {
    given();
    await page();
    expect(featureRpcCalls().map(([, a]) => (a as { p_org_id: string }).p_org_id)).toEqual([BROKERAGE]);
  });
});

describe('fail closed', () => {
  it.each(['off', 'absent'] as const)('transaction_checklists %s: no section and no checklist table read', async (state) => {
    given();
    mockChecklistKey = state;
    const element = await page();
    expect(findProps(element, ChecklistReview)).toBeNull();
    render(element);
    expect(screen.queryByTestId('checklist-review')).toBeNull();
    for (const t of CHECKLIST_TABLES) expect(tablesRead()).not.toContain(t);
    expect(tablesRead()).toContain('transaction_submissions');
  });

  it.each(CHECKLIST_TABLES)('a failed %s read: no section, the rest of the page renders', async (table) => {
    given();
    mockFailingTables = [table];
    const element = await page();
    expect(findProps(element, ChecklistReview)).toBeNull();
    render(element);
    expect(screen.queryByTestId('checklist-review')).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.getByText('Back to My Transactions')).toBeInTheDocument();
  });

  it('impersonating, checklists on: notFound before any read', async () => {
    given({ impersonating: true });
    await expect(page()).rejects.toBeInstanceOf(NotFound);
    expect(mockEmulator.state.selects).toEqual([]);
  });
});
