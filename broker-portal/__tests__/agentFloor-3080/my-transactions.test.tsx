/**
 * My Transactions — BACKLOG-3080 (PR 2).
 *
 * The REAL gate (lib/my-transactions-access.ts), the REAL portal classifier and
 * the REAL feature gate (NOT force-mocked here: the RPC is answered per
 * organization with the transcribed ORG_WITHOUT_PLAN_FEATURES payload, the same
 * payload with the key on/off, or an error). The REAL pages run against the
 * PostgREST emulator, which applies eq/neq/in as filters and NO RLS, so every
 * scope asserted here is the portal query's own. The REAL MessageList and
 * AttachmentList render in jsdom, with the browser Storage client recording
 * every call.
 *
 * Fixture shapes: __tests__/helpers/submissionRows.ts (production columns,
 * invented values). Users A (the fixture user) and B (a colleague) in one
 * brokerage; A also has a submission in ANOTHER brokerage.
 */

import { render, within, waitFor, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import {
  ABSENT_COLUMN_ERROR,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_OTHER_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';
import {
  ATTACHMENT_COLUMNS,
  MESSAGE_COLUMNS,
  STATUS_HISTORY_KEYS,
  SUBMISSION_COLUMNS,
  SUBMISSION_METADATA_KEYS,
  attachmentRow,
  historyEntry,
  messageRow,
  submissionRow,
} from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockMembershipReadFails = false;

type FeatureState = 'absent' | 'on' | 'off' | 'rpc_error' | 'payload_error';
let mockFeatures: Record<string, FeatureState> = {};
const mockRpc = jest.fn(async (name: string, args?: Record<string, unknown>) => {
  if (name !== 'broker_get_org_features') return { data: null, error: null };
  const orgId = String(args?.p_org_id);
  const state = mockFeatures[orgId] ?? 'absent';
  if (state === 'rpc_error') return { data: null, error: { message: 'fixture: rpc failed' } };
  if (state === 'payload_error') return { data: { error: 'not_authenticated', features: {} }, error: null };
  const base = { ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId };
  if (state === 'absent') return { data: base, error: null };
  return { data: withFeature(base, 'portal_my_transactions', state === 'on'), error: null };
});

function mockServerFrom(table: string) {
  const chain = mockEmulator.from(table);
  if (mockMembershipReadFails && table === 'organization_members') {
    (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 }).then(ok, ko);
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
  createServiceClient: jest.fn(() => ({
    from: (table: string) => mockServerFrom(table),
    rpc: mockRpc,
  })),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: jest.fn(async () => null),
}));
jest.mock('@/lib/impersonation-guards', () => {
  const actual = jest.requireActual('@/lib/impersonation-guards');
  return { ...actual, getDataClient: jest.fn(actual.getDataClient) };
});
jest.mock('@/lib/checklist-access', () => ({
  isChecklistEditorEnabled: jest.fn(async () => false),
}));

/** Browser Supabase client: records every Storage call and every table read. */
const mockStorageOps: { bucket: string; op: string; path: unknown }[] = [];
const mockBrowserTables: string[] = [];
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: (table: string) => {
      mockBrowserTables.push(table);
      throw new Error(`browser table read: ${table}`);
    },
    storage: {
      from: (bucket: string) =>
        new Proxy(
          {},
          {
            get: (_t, op) => async (path: unknown) => {
              mockStorageOps.push({ bucket, op: String(op), path });
              return { data: { signedUrl: `https://signed.fixture.test/${String(path)}` }, error: null };
            },
          }
        ),
    },
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

class Redirect extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
  }
}
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
  usePathname: () => '/dashboard/my-transactions',
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { getMyTransactionsGate, MY_TRANSACTIONS_FEATURE_KEY } from '@/lib/my-transactions-access';
import MyTransactionsPage from '@/app/dashboard/my-transactions/page';
import MyTransactionDetailPage from '@/app/dashboard/my-transactions/[id]/page';
import DashboardLayout from '@/app/dashboard/layout';
import DashboardPage from '@/app/dashboard/page';
import DashboardNewTicketPage from '@/app/dashboard/support/new/page';
import { Sidebar } from '@/components/layout/Sidebar';
import { MessageList } from '@/components/submission/MessageList';
import { AttachmentList } from '@/components/submission/AttachmentList';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { UpsellPanel, MY_TRANSACTIONS_UPSELL_TEXT } from '@/components/my-transactions/UpsellPanel';
import { TicketForm } from '@/app/support/components/TicketForm';
import { mayOpenDashboardPath, classifyPortalAccess } from '@/lib/auth/membership';
import { getImpersonationSession } from '@/lib/impersonation';
import { getDataClient } from '@/lib/impersonation-guards';
import { createServiceClient } from '@/lib/supabase/service';

// ---------------------------------------------------------------------------
// Fixture (every id invented)
// ---------------------------------------------------------------------------

const BROKERAGE = FIXTURE_BROKERAGE_ORG_ID;
const OTHER_BROKERAGE = '00000000-0000-4000-8000-0000003080b1'; // pii-allow-uuid: invented fixture id
const A = FIXTURE_USER_ID;
const B = FIXTURE_OTHER_USER_ID;

const S_A = '00000000-0000-4000-8000-000000308a01'; // pii-allow-uuid: invented fixture id
const S_A_PARENT = '00000000-0000-4000-8000-000000308a00'; // pii-allow-uuid: invented fixture id
const S_A_OTHER_ORG = '00000000-0000-4000-8000-000000308a02'; // pii-allow-uuid: invented fixture id
const S_A_CHILD_OF_OTHER_ORG = '00000000-0000-4000-8000-000000308a03'; // pii-allow-uuid: invented fixture id
const S_A_UPLOADING = '00000000-0000-4000-8000-000000308a0f'; // pii-allow-uuid: invented fixture id
const S_B = '00000000-0000-4000-8000-000000308b01'; // pii-allow-uuid: invented fixture id

const PARENT_NOTE = 'Parent round: please add the disclosure';
const OTHER_ORG_NOTE = 'Other brokerage review note';
const REVIEWER = '00000000-0000-4000-8000-0000003080c1'; // pii-allow-uuid: invented fixture id

const SUBMISSIONS: Row[] = [
  submissionRow({
    id: S_A,
    organizationId: BROKERAGE,
    submittedBy: A,
    status: 'resubmitted',
    parentSubmissionId: S_A_PARENT,
    statusHistory: [historyEntry('resubmitted')],
    createdAt: '2026-09-03T00:00:00Z',
  }),
  submissionRow({
    id: S_A_PARENT,
    organizationId: BROKERAGE,
    submittedBy: A,
    status: 'needs_changes',
    statusHistory: [historyEntry('under_review', null, REVIEWER), historyEntry('needs_changes', PARENT_NOTE, REVIEWER)],
    createdAt: '2026-09-01T00:00:00Z',
  }),
  submissionRow({
    id: S_A_OTHER_ORG,
    organizationId: OTHER_BROKERAGE,
    submittedBy: A,
    status: 'needs_changes',
    statusHistory: [historyEntry('needs_changes', OTHER_ORG_NOTE, REVIEWER)],
  }),
  submissionRow({
    id: S_A_CHILD_OF_OTHER_ORG,
    organizationId: BROKERAGE,
    submittedBy: A,
    status: 'resubmitted',
    parentSubmissionId: S_A_OTHER_ORG,
    statusHistory: [historyEntry('resubmitted')],
  }),
  submissionRow({ id: S_A_UPLOADING, organizationId: BROKERAGE, submittedBy: A, status: 'uploading' }),
  submissionRow({ id: S_B, organizationId: BROKERAGE, submittedBy: B, status: 'submitted' }),
];

const MESSAGES: Row[] = [
  messageRow({ id: 'msg-a', submissionId: S_A, subject: 'subj msg-a' }),
  messageRow({ id: 'msg-b', submissionId: S_B, subject: 'subj msg-b' }),
  messageRow({ id: 'msg-a2', submissionId: S_A_OTHER_ORG, subject: 'subj msg-a2' }),
  messageRow({ id: 'msg-p', submissionId: S_A_PARENT, subject: 'subj msg-p' }),
];

const ATTACHMENTS: Row[] = [
  attachmentRow({ id: 'att-a1', submissionId: S_A, organizationId: BROKERAGE, filename: 'photo-a1.png', mimeType: 'image/png' }),
  attachmentRow({ id: 'att-a0', submissionId: S_A, organizationId: BROKERAGE, filename: 'meta-a0.pdf', mimeType: 'application/pdf', stored: false }),
  attachmentRow({ id: 'att-a3', submissionId: S_A, organizationId: BROKERAGE, filename: 'doc-a3.pdf', mimeType: 'application/pdf' }),
  attachmentRow({ id: 'att-b', submissionId: S_B, organizationId: BROKERAGE, filename: 'photo-b.png', mimeType: 'image/png' }),
  attachmentRow({ id: 'att-a2', submissionId: S_A_OTHER_ORG, organizationId: OTHER_BROKERAGE, filename: 'photo-a2.png', mimeType: 'image/png' }),
  attachmentRow({ id: 'att-p', submissionId: S_A_PARENT, organizationId: BROKERAGE, filename: 'photo-p.png', mimeType: 'image/png' }),
];

const PERSONAS = {
  'brokerage agent': [brokerageMembership('agent')],
  'personal-org owner': [personalMembership()],
  '[brokerage agent, personal-org owner]': [brokerageMembership('agent'), personalMembership()],
  'brokerage broker': [brokerageMembership('broker')],
  'brokerage admin': [brokerageMembership('admin')],
  'brokerage it_admin': [brokerageMembership('it_admin')],
  'no membership': [],
} as const;
type Persona = keyof typeof PERSONAS;

function given(
  persona: Persona,
  features: Record<string, FeatureState> = {},
  options: { impersonating?: boolean; membershipReadFails?: boolean } = {}
): void {
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: A,
        email: 'agent-3080@fixture.example.test',
        user_metadata: {
          full_name: 'Robin Fixture',
        },
      },
    },
  });
  mockFeatures = features;
  mockMembershipReadFails = options.membershipReadFails ?? false;
  (getImpersonationSession as jest.Mock).mockResolvedValue(
    options.impersonating
      ? {
          target_email: 'target@fixture.example.test',
          target_name: 'Target Fixture',
        }
      : null
  );
  mockEmulator.reset();
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organization_members: [...PERSONAS[persona]],
      transaction_submissions: SUBMISSIONS,
      submission_messages: MESSAGES,
      submission_attachments: ATTACHMENTS,
    },
  });
}

const ON = { [BROKERAGE]: 'on' } as Record<string, FeatureState>;
const tablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();
const featureRpcCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'broker_get_org_features');

type Outcome = { notFound: true } | { redirect: string } | { element: React.ReactElement };
async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { element: (await fn()) as React.ReactElement };
  } catch (e) {
    if (e instanceof NotFound) return { notFound: true };
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}
const list = (search: Record<string, string> = {}) => () => MyTransactionsPage({ searchParams: Promise.resolve(search) });
const detail = (id: string) => () => MyTransactionDetailPage({ params: Promise.resolve({ id }) });

/** Depth-first search of a server-rendered element tree for a component's props. */
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

function elementOf(outcome: Outcome): React.ReactElement {
  if (!('element' in outcome)) throw new Error(`expected an element, got ${JSON.stringify(outcome)}`);
  return outcome.element;
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  mockStorageOps.length = 0;
  mockBrowserTables.length = 0;
  quiet = [
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

// ---------------------------------------------------------------------------
// R1: the fixture shape is production's
// ---------------------------------------------------------------------------

describe('R1: fixture rows carry the production shape', () => {
  it('submission, message and attachment rows have exactly the production columns', () => {
    for (const row of SUBMISSIONS) expect(Object.keys(row)).toEqual([...SUBMISSION_COLUMNS]);
    for (const row of MESSAGES) expect(Object.keys(row)).toEqual([...MESSAGE_COLUMNS]);
    for (const row of ATTACHMENTS) expect(Object.keys(row)).toEqual([...ATTACHMENT_COLUMNS]);
    expect(SUBMISSION_COLUMNS).toHaveLength(26);
    expect(MESSAGE_COLUMNS).toHaveLength(14);
    expect(ATTACHMENT_COLUMNS).toHaveLength(10);
  });

  it('status_history elements and submission_metadata have exactly the produced keys', () => {
    for (const row of SUBMISSIONS) {
      for (const entry of row.status_history as object[]) {
        expect(Object.keys(entry).sort()).toEqual([...STATUS_HISTORY_KEYS]);
      }
      expect(Object.keys(row.submission_metadata as object).sort()).toEqual([...SUBMISSION_METADATA_KEYS]);
    }
  });

  it('includes a metadata-only attachment (storage_path NULL) and producer-shaped paths', () => {
    expect(ATTACHMENTS.filter((a) => a.storage_path === null).map((a) => a.id)).toEqual(['att-a0']);
    for (const a of ATTACHMENTS.filter((x) => x.storage_path !== null)) {
      const sub = SUBMISSIONS.find((s) => s.id === a.submission_id)!;
      expect(a.storage_path).toBe(`${sub.organization_id}/${sub.id}/${a.filename}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('getMyTransactionsGate', () => {
  it.each([
    ['brokerage agent', ON, 'admitted'],
    ['brokerage agent', { [BROKERAGE]: 'off' }, 'upsell'],
    ['brokerage agent', {}, 'upsell'],
    ['brokerage agent', { [BROKERAGE]: 'rpc_error' }, 'upsell'],
    ['brokerage agent', { [BROKERAGE]: 'payload_error' }, 'upsell'],
    ['personal-org owner', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }, null],
    ['[brokerage agent, personal-org owner]', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }, 'upsell'],
    ['[brokerage agent, personal-org owner]', ON, 'admitted'],
    ['brokerage broker', ON, null],
    ['brokerage admin', ON, null],
    ['brokerage it_admin', ON, null],
    ['no membership', ON, null],
  ] as [Persona, Record<string, FeatureState>, string | null][])('%s, features %j -> %s', async (persona, features, kind) => {
    given(persona, features);
    const gate = await getMyTransactionsGate();
    expect(gate === null ? null : gate.kind).toBe(kind);
    if (gate?.kind === 'admitted') expect(gate.organizationId).toBe(BROKERAGE);
  });

  it('R3: the key is read on the brokerage organization only, never the personal one', async () => {
    given('[brokerage agent, personal-org owner]', { [FIXTURE_PERSONAL_ORG_ID]: 'on' });
    await getMyTransactionsGate();
    expect(featureRpcCalls().map(([, args]) => (args as { p_org_id: string }).p_org_id)).toEqual([BROKERAGE]);
  });

  it('a failed membership read (unknown) -> null, and the key is never read', async () => {
    given('brokerage agent', ON, { membershipReadFails: true });
    expect(await getMyTransactionsGate()).toBeNull();
    expect(featureRpcCalls()).toEqual([]);
  });

  it('R5b: impersonating -> null, with zero table reads and no key read', async () => {
    given('brokerage agent', ON, { impersonating: true });
    expect(await getMyTransactionsGate()).toBeNull();
    expect(mockEmulator.state.selects).toEqual([]);
    expect(featureRpcCalls()).toEqual([]);
  });

  it('the key constant is the seeded key', () => {
    expect(MY_TRANSACTIONS_FEATURE_KEY).toBe('portal_my_transactions');
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function renderedDetailIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a[href^="/dashboard/my-transactions/"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();
}

describe('list page', () => {
  it('C1/R2: agent A sees exactly their own rows in THIS brokerage', async () => {
    given('brokerage agent', ON);
    const { container } = render(elementOf(await run(list())));
    expect(renderedDetailIds(container)).toEqual([S_A_PARENT, S_A, S_A_CHILD_OF_OTHER_ORG].sort());
    expect(container.innerHTML).not.toContain(S_B);
    expect(container.innerHTML).not.toContain(S_A_OTHER_ORG);
    expect(container.innerHTML).not.toContain(S_A_UPLOADING);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it('the status filter narrows the own set', async () => {
    given('brokerage agent', ON);
    const { container } = render(elementOf(await run(list({ status: 'needs_changes' }))));
    expect(renderedDetailIds(container)).toEqual([S_A_PARENT]);
  });

  it('an unknown status value is ignored, not passed to the query', async () => {
    given('brokerage agent', ON);
    const { container } = render(elementOf(await run(list({ status: 'uploading' }))));
    expect(renderedDetailIds(container)).toEqual([S_A_PARENT, S_A, S_A_CHILD_OF_OTHER_ORG].sort());
  });

  it('colleague B sees exactly B\'s row (the owner filter is the session user)', async () => {
    given('brokerage agent', ON);
    mockGetUser.mockResolvedValue({ data: { user: { id: B, email: 'b@fixture.example.test', user_metadata: {} } } });
    mockEmulator.set({
      rows: {
        ...mockEmulator.state.rows,
        organization_members: [brokerageMembership('agent', 'post', B)],
      },
    });
    const { container } = render(elementOf(await run(list())));
    expect(renderedDetailIds(container)).toEqual([S_B]);
  });

  it.each(['off', 'absent', 'rpc_error'] as FeatureState[])(
    'C5/C-M5: key %s -> the upsell, and nothing but the membership is read',
    async (state) => {
      given('brokerage agent', state === 'absent' ? {} : { [BROKERAGE]: state });
      const element = elementOf(await run(list()));
      expect(element.type).toBe(UpsellPanel);
      expect(tablesRead()).toEqual(['organization_members']);
      const { container } = render(element);
      expect(container.textContent).toContain(MY_TRANSACTIONS_UPSELL_TEXT);
      expect(within(container).getByRole('link', { name: 'Contact sales' })).toHaveAttribute(
        'href',
        '/dashboard/support/new?preset=my-transactions-upgrade'
      );
    }
  );

  it.each([
    ['personal-org owner', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }],
    ['brokerage broker', ON],
    ['brokerage admin', ON],
    ['brokerage it_admin', ON],
    ['no membership', ON],
  ] as [Persona, Record<string, FeatureState>][])('%s -> notFound before any submission read', async (persona, features) => {
    given(persona, features);
    expect(await run(list())).toEqual({ notFound: true });
    expect(tablesRead()).toEqual(['organization_members']);
    expect(mockEmulator.state.writes).toEqual([]);
  });

  it('R5b: impersonating -> notFound, zero table reads', async () => {
    given('brokerage agent', ON, { impersonating: true });
    expect(await run(list())).toEqual({ notFound: true });
    expect(mockEmulator.state.selects).toEqual([]);
  });

  it('R5a: no service client and no getDataClient during an admitted render', async () => {
    given('brokerage agent', ON);
    render(elementOf(await run(list())));
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(getDataClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface MessageListProps {
  messages: { id: string }[];
}
interface AttachmentListProps {
  attachments: { id: string; storage_path: string | null }[];
}
interface StatusHistoryProps {
  history: { status: string; notes?: string; changed_by?: string; parentSubmissionId?: string }[];
  previousVersionBasePath?: string | null;
}

describe('detail page', () => {
  it('C-M2: own submission -> exactly its own messages and attachments, no writes', async () => {
    given('brokerage agent', ON);
    const element = elementOf(await run(detail(S_A)));
    expect(findProps<MessageListProps>(element, MessageList)!.messages.map((m) => m.id)).toEqual(['msg-a']);
    expect(findProps<AttachmentListProps>(element, AttachmentList)!.attachments.map((a) => a.id).sort()).toEqual(
      ['att-a0', 'att-a1', 'att-a3']
    );
    const { container } = render(element);
    expect(container.textContent).toContain('subj msg-a');
    expect(container.textContent).not.toContain('subj msg-b');
    expect(container.textContent).not.toContain('subj msg-a2');
    expect(mockEmulator.state.writes).toEqual([]);
    expect(mockBrowserTables).toEqual([]);
  });

  it.each([
    ["a colleague's submission", S_B],
    ['their own submission in another brokerage', S_A_OTHER_ORG],
    ['a submission still uploading', S_A_UPLOADING],
    ['an id that does not exist', '00000000-0000-4000-8000-000000308fff'], // pii-allow-uuid: invented fixture id
  ])('C2/C-M1/R2: %s -> notFound, and no child table is read', async (_name, id) => {
    given('brokerage agent', ON);
    expect(await run(detail(id))).toEqual({ notFound: true });
    expect(tablesRead()).toEqual(['organization_members', 'transaction_submissions']);
  });

  it('a non-uuid id -> notFound with no submission read', async () => {
    given('brokerage agent', ON);
    expect(await run(detail('not-a-uuid'))).toEqual({ notFound: true });
    expect(tablesRead()).toEqual(['organization_members']);
  });

  it('children are read by the verified id', async () => {
    given('brokerage agent', ON);
    await run(detail(S_A));
    expect(tablesRead()).toEqual([
      'organization_members',
      'submission_attachments',
      'submission_messages',
      'transaction_submissions',
    ]);
  });

  it('R9/R10: history includes the own parent round and links to it under My Transactions', async () => {
    given('brokerage agent', ON);
    const element = elementOf(await run(detail(S_A)));
    const props = findProps<StatusHistoryProps>(element, StatusHistory)!;
    expect(props.history.map((h) => h.notes).filter(Boolean)).toEqual([PARENT_NOTE]);
    expect(props.history.every((h) => h.changed_by === undefined)).toBe(true);
    const { container } = render(element);
    expect(container.innerHTML).not.toContain(REVIEWER);
    const hrefs = Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') as string);
    expect(hrefs).toContain(`/dashboard/my-transactions/${S_A_PARENT}`);
    expect(hrefs.filter((h) => h.startsWith('/dashboard/submissions'))).toEqual([]);
  });

  it('R9: a parent in another brokerage contributes no history and gets no link', async () => {
    given('brokerage agent', ON);
    const element = elementOf(await run(detail(S_A_CHILD_OF_OTHER_ORG)));
    const props = findProps<StatusHistoryProps>(element, StatusHistory)!;
    expect(props.history.map((h) => h.notes).filter(Boolean)).toEqual([]);
    expect(props.history.some((h) => h.parentSubmissionId)).toBe(false);
    const { container } = render(element);
    expect(container.textContent).not.toContain(OTHER_ORG_NOTE);
    expect(container.innerHTML).not.toContain(S_A_OTHER_ORG);
  });

  it('R4: the upsell renders identically for any id and never echoes it', async () => {
    const htmls: string[] = [];
    for (const id of [S_A, S_B, 'not-a-uuid-3080']) {
      given('brokerage agent', { [BROKERAGE]: 'off' });
      const element = elementOf(await run(detail(id)));
      expect(element.type).toBe(UpsellPanel);
      expect(tablesRead()).toEqual(['organization_members']);
      const { container, unmount } = render(element);
      expect(container.innerHTML).not.toContain(id);
      htmls.push(container.innerHTML);
      unmount();
    }
    expect(new Set(htmls).size).toBe(1);
  });

  it.each(['absent', 'rpc_error'] as FeatureState[])('C-M5: key %s -> detail upsell, zero submission reads', async (state) => {
    given('brokerage agent', state === 'absent' ? {} : { [BROKERAGE]: state });
    expect(elementOf(await run(detail(S_A))).type).toBe(UpsellPanel);
    expect(tablesRead()).toEqual(['organization_members']);
  });

  it.each([
    ['personal-org owner', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }],
    ['brokerage admin', ON],
    ['brokerage it_admin', ON],
  ] as [Persona, Record<string, FeatureState>][])('%s -> notFound before any submission read', async (persona, features) => {
    given(persona, features);
    expect(await run(detail(S_A))).toEqual({ notFound: true });
    expect(tablesRead()).toEqual(['organization_members']);
  });

  it('R3: [agent, personal owner] with the key on the personal org only -> upsell; on the brokerage -> own rows', async () => {
    given('[brokerage agent, personal-org owner]', { [FIXTURE_PERSONAL_ORG_ID]: 'on' });
    expect(elementOf(await run(detail(S_A))).type).toBe(UpsellPanel);
    given('[brokerage agent, personal-org owner]', ON);
    const { container } = render(elementOf(await run(list())));
    expect(renderedDetailIds(container)).toEqual([S_A_PARENT, S_A, S_A_CHILD_OF_OTHER_ORG].sort());
  });

  it('R5b: impersonating -> notFound, zero table reads', async () => {
    given('brokerage agent', ON, { impersonating: true });
    expect(await run(detail(S_A))).toEqual({ notFound: true });
    expect(mockEmulator.state.selects).toEqual([]);
  });

  it('R5a: no service client and no getDataClient, loaders included', async () => {
    given('brokerage agent', ON);
    render(elementOf(await run(detail(S_A))));
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(getDataClient).not.toHaveBeenCalled();
  });

  it('C-M11: exactly one feature read per detail render (no broker_* view block)', async () => {
    given('brokerage agent', ON);
    await run(detail(S_A));
    expect(featureRpcCalls()).toHaveLength(1);
  });

  it('C-M3/R11: the only paths ever signed are the own attachments, from the attachments section', async () => {
    given('brokerage agent', ON);
    render(elementOf(await run(detail(S_A))));

    // MessageList renders its own "All" tab; scope to the attachments section.
    const heading = screen.getByRole('heading', { name: /^Attachments \(/ });
    const section = heading.closest('.rounded-lg') as HTMLElement;
    expect(section).not.toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: /^All \(/ }));
    await waitFor(() => expect(mockStorageOps).toHaveLength(1));

    // Open the viewer on a document row.
    fireEvent.click(within(section).getByText('doc-a3.pdf'));
    await waitFor(() => expect(mockStorageOps.length).toBeGreaterThanOrEqual(2));

    const signed = Array.from(new Set(mockStorageOps.map((o) => o.path))).sort();
    expect(signed).toEqual([`${BROKERAGE}/${S_A}/doc-a3.pdf`, `${BROKERAGE}/${S_A}/photo-a1.png`]);
    expect(Array.from(new Set(mockStorageOps.map((o) => `${o.bucket}:${o.op}`)))).toEqual([
      'submission-attachments:createSignedUrl',
    ]);
    expect(mockBrowserTables).toEqual([]);
  });

  it('C-M6: the messages section issues no Storage call and no table read on render', async () => {
    given('brokerage agent', ON);
    const element = elementOf(await run(detail(S_A)));
    const props = findProps<MessageListProps>(element, MessageList)!;
    render(<MessageList messages={props.messages as never} />);
    expect(mockStorageOps).toEqual([]);
    expect(mockBrowserTables).toEqual([]);
  });
});

describe('StatusHistory previous-version link (R10)', () => {
  const history = [
    { status: 'needs_changes', changed_at: '2026-09-01T00:00:00Z' },
    { status: 'resubmitted', changed_at: '2026-09-02T00:00:00Z', parentSubmissionId: S_A_PARENT },
  ];
  const hrefsOf = (el: React.ReactElement) => {
    const { container, unmount } = render(el);
    const out = Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    unmount();
    return out;
  };

  it('the broker default is unchanged', () => {
    expect(hrefsOf(<StatusHistory history={history} currentStatus="resubmitted" submittedAt="2026-08-31T00:00:00Z" />)).toEqual([
      `/dashboard/submissions/${S_A_PARENT}`,
    ]);
  });

  it('a base path moves the link; null removes it', () => {
    expect(
      hrefsOf(
        <StatusHistory
          history={history}
          currentStatus="resubmitted"
          submittedAt="2026-08-31T00:00:00Z"
          previousVersionBasePath="/dashboard/my-transactions"
        />
      )
    ).toEqual([`/dashboard/my-transactions/${S_A_PARENT}`]);
    expect(
      hrefsOf(
        <StatusHistory
          history={history}
          currentStatus="resubmitted"
          submittedAt="2026-08-31T00:00:00Z"
          previousVersionBasePath={null}
        />
      )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R4: nav <=> page
// ---------------------------------------------------------------------------

async function layoutShows(): Promise<boolean> {
  const element = (await DashboardLayout({ children: null })) as React.ReactElement<{ showMyTransactions?: boolean }>;
  return element.props.showMyTransactions === true;
}

describe('R4: the nav entry shows exactly when the page renders', () => {
  it.each([
    ['brokerage agent', ON, {}],
    ['brokerage agent', { [BROKERAGE]: 'off' }, {}],
    ['brokerage agent', {}, {}],
    ['brokerage agent', { [BROKERAGE]: 'rpc_error' }, {}],
    ['[brokerage agent, personal-org owner]', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }, {}],
    ['personal-org owner', { [FIXTURE_PERSONAL_ORG_ID]: 'on' }, {}],
    ['brokerage broker', ON, {}],
    ['brokerage agent', ON, { impersonating: true }],
  ] as [Persona, Record<string, FeatureState>, { impersonating?: boolean }][])(
    '%s, features %j, %j',
    async (persona, features, options) => {
      given(persona, features, options);
      const shown = await layoutShows();
      given(persona, features, options);
      const page = await run(list());
      expect(shown).toBe(!('notFound' in page));
    }
  );

  it('the sidebar renders the entry only when told, and only in the floor bucket', () => {
    const hrefs = (props: Partial<React.ComponentProps<typeof Sidebar>>) => {
      const { container, unmount } = render(
        <Sidebar collapsed={false} onToggle={() => {}} isImpersonating={false} displayEmail="x@fixture.example.test" {...props} />
      );
      const out = Array.from(container.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));
      unmount();
      return out;
    };
    expect(hrefs({ role: 'agent', floorOnly: true, showMyTransactions: true })).toEqual([
      '/dashboard',
      '/dashboard/support',
      '/dashboard/my-transactions',
      '/dashboard/account',
    ]);
    expect(hrefs({ role: 'agent', floorOnly: true })).toEqual(['/dashboard', '/dashboard/support', '/dashboard/account']);
    expect(hrefs({ role: 'broker', showMyTransactions: true })).not.toContain('/dashboard/my-transactions');
    expect(hrefs({ isImpersonating: true, floorOnly: true, showMyTransactions: true })).not.toContain(
      '/dashboard/my-transactions'
    );
  });
});

// ---------------------------------------------------------------------------
// R6: the floor is not toggleable
// ---------------------------------------------------------------------------

describe('R6: the floor opens whatever the plan says', () => {
  const FLOOR = ['/dashboard', '/dashboard/support', '/dashboard/support/new', '/dashboard/account'];

  it.each([
    ['brokerage agent', 'every key off', { [BROKERAGE]: 'off' }],
    ['brokerage agent', 'the feature read failing', { [BROKERAGE]: 'rpc_error' }],
    ['personal-org owner', 'every key off', { [FIXTURE_PERSONAL_ORG_ID]: 'off' }],
    ['personal-org owner', 'the feature read failing', { [FIXTURE_PERSONAL_ORG_ID]: 'rpc_error' }],
  ] as [Persona, string, Record<string, FeatureState>][])('%s, %s', async (persona, _label, features) => {
    given(persona, features);
    const access = classifyPortalAccess(PERSONAS[persona] as never, A);
    for (const path of FLOOR) expect(mayOpenDashboardPath(access, path)).toBe(true);

    const { container: dash, unmount } = render((await DashboardPage()) as React.ReactElement);
    expect(dash.textContent).toContain('Your Keepr account');
    unmount();

    const ticket = elementOf(await run(() => DashboardNewTicketPage({ searchParams: Promise.resolve({}) })));
    expect(findProps(ticket, TicketForm)).not.toBeNull();

    given(persona, features);
    const shell = (await DashboardLayout({ children: null })) as React.ReactElement<{ floorOnly?: boolean }>;
    expect(shell.props.floorOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware classifier (edge): brokerage floor only
// ---------------------------------------------------------------------------

describe('mayOpenDashboardPath for My Transactions', () => {
  it.each([
    ['brokerage agent', true],
    ['[brokerage agent, personal-org owner]', true],
    ['personal-org owner', false],
  ] as [Persona, boolean][])('%s -> %s', (persona, admitted) => {
    const access = classifyPortalAccess(PERSONAS[persona] as never, A);
    expect(mayOpenDashboardPath(access, '/dashboard/my-transactions')).toBe(admitted);
    expect(mayOpenDashboardPath(access, `/dashboard/my-transactions/${S_A}`)).toBe(admitted);
    expect(mayOpenDashboardPath(access, '/dashboard/my-transactionsx')).toBe(false);
  });

  it('unknown and none are refused', () => {
    expect(mayOpenDashboardPath({ kind: 'unknown' }, '/dashboard/my-transactions')).toBe(false);
    expect(mayOpenDashboardPath({ kind: 'none' }, '/dashboard/my-transactions')).toBe(false);
  });
});
