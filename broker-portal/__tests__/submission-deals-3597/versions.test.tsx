/**
 * The versions of a deal on its submission page — BACKLOG-3597.
 *
 * Runs the REAL server page (app/dashboard/submissions/[id]/page.tsx), the REAL
 * lib/submissions/versions walk and the REAL SubmissionVersions component
 * against the PostgREST emulator. The other presentation components are
 * captured, not rendered, as in __tests__/submission-review-3477/page.test.tsx
 * (whose mock set this copies).
 *
 * FIXTURE PROVENANCE (read-only MCP on production, 2026-09-27; every id
 * invented): the live 3-link chain v1 `rejected` -> v2 `needs_changes` ->
 * v3 `resubmitted`, same org and submitter, created_at increasing, one child
 * per row; the producer inserts a version as `uploading` before it lands.
 */

import type React from 'react';
import { render as renderDom } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockPayload = {
  data: withFeature(withFeature(ORG_WITHOUT_PLAN_FEATURES, 'broker_portal_access', true), 'transaction_checklists', false),
  error: null,
};
const mockRpc = jest.fn(async (name: string) => {
  if (name === 'broker_get_org_features') return mockPayload;
  if (name === 'can_review_submission') return { data: true, error: null };
  return { data: null, error: null };
});

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
    rpc: mockRpc,
  })),
}));
// BACKLOG-3605: the notice polls with the browser client; same emulator.
jest.mock('@/lib/supabase/client', () => ({
  createClient: jest.fn(() => ({ from: (t: string) => mockEmulator.from(t) })),
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
jest.mock('@/lib/actions/submissionChecklists', () => ({ setReviewerCheck: jest.fn(), addChecklistAtReview: jest.fn() }));
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('@/components/submission/MessageList', () => ({ MessageList: function MessageList() { return null; } }));
jest.mock('@/components/submission/AttachmentList', () => ({ AttachmentList: function AttachmentList() { return null; } }));
jest.mock('@/components/submission/ReviewActions', () => ({ ReviewActions: function ReviewActions() { return null; } }));
jest.mock('@/components/submission/StatusHistory', () => ({ StatusHistory: function StatusHistory() { return null; } }));
jest.mock('@/components/submission/ChecklistReview', () => ({ ChecklistReview: function ChecklistReview() { return null; } }));

import SubmissionDetailPage from '@/app/dashboard/submissions/[id]/page';
import { getImpersonationSession } from '@/lib/impersonation';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { SubmissionVersions } from '@/components/submission/SubmissionVersions';

// pii-allow-uuid: invented fixture ids below (whole block)
const AGENT = '00000000-0000-4000-8000-0000003597a1'; // pii-allow-uuid: invented fixture id
const V1 = '00000000-0000-4000-8000-000000359741'; // pii-allow-uuid: invented fixture id
const V2 = '00000000-0000-4000-8000-000000359742'; // pii-allow-uuid: invented fixture id
const V3 = '00000000-0000-4000-8000-000000359743'; // pii-allow-uuid: invented fixture id
const V4_UPLOADING = '00000000-0000-4000-8000-000000359744'; // pii-allow-uuid: invented fixture id
const SOLO = '00000000-0000-4000-8000-000000359750'; // pii-allow-uuid: invented fixture id

function version(id: string, n: number | null, status: string, parent: string | null, createdAt: string): Row {
  return {
    ...submissionRow({ id, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status, parentSubmissionId: parent, createdAt }),
    version: n,
  };
}

const CHAIN: Row[] = [
  version(V1, 1, 'rejected', null, '2026-09-01T00:00:00Z'),
  version(V2, 2, 'needs_changes', V1, '2026-09-02T00:00:00Z'),
  version(V3, 3, 'resubmitted', V2, '2026-09-03T00:00:00Z'),
  version(SOLO, 1, 'under_review', null, '2026-09-04T00:00:00Z'),
];

function given(rows: Row[] = CHAIN): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID, email: 'viewer@fixture.example.test' } } });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      organization_members: [brokerageMembership('broker')],
      transaction_submissions: rows,
      users: [],
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

type VersionsProps = React.ComponentProps<typeof SubmissionVersions>;

/** The element itself (props AND key), for what findProps cannot see. */
function findElement(node: unknown, type: unknown): React.ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as React.ReactElement<{ children?: unknown }>;
  if (el.type === type) return el;
  return findElement(el.props?.children, type);
}

/** Run the page for `id` and render the real SubmissionVersions it produced. */
async function open(id: string) {
  const element = (await SubmissionDetailPage({ params: Promise.resolve({ id }) })) as React.ReactElement;
  const props = findProps<VersionsProps>(element, SubmissionVersions);
  expect(props).not.toBeNull();
  const dom = renderDom(<SubmissionVersions {...props!} />);
  return { element, props: props!, container: dom.container };
}

function hrefs(root: Element | null): string[] {
  return root ? Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href') as string) : [];
}

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  given();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('Previous versions on the newest version', () => {
  it('V1: lists v1 and v2 (number, status, date), oldest first, each linking to its page', async () => {
    const { container } = await open(V3);
    const list = container.querySelector('[data-testid="previous-versions"]');
    expect(list).toHaveTextContent('Previous versions (2)');
    expect(hrefs(list)).toEqual([`/dashboard/submissions/${V1}`, `/dashboard/submissions/${V2}`]);
    const items = Array.from(list!.querySelectorAll('li')).map((li) => li.textContent);
    expect(items[0]).toContain('Version 1');
    expect(items[0]).toContain('Rejected');
    expect(items[0]).toContain('2026');
    expect(items[1]).toContain('Version 2');
    expect(items[1]).toContain('Needs Changes');
    expect(container.querySelector('[data-testid="newer-version-notice"]')).toBeNull();
  });

  it('V2: a single-version deal renders no versions control', async () => {
    const { props, container } = await open(SOLO);
    expect(props).toMatchObject({ previous: [], newest: null });
    expect(container.innerHTML).toBe('');
  });

  it('V3: the existing sections are unchanged (StatusHistory still gets the merged history)', async () => {
    const { element } = await open(V3);
    expect(findProps(element, StatusHistory)).not.toBeNull();
  });
});

describe('Newer version on an older version', () => {
  it('V4: v1 links to the newest version (v3), and lists no previous versions', async () => {
    const { container } = await open(V1);
    const notice = container.querySelector('[data-testid="newer-version-notice"]');
    expect(notice).toHaveTextContent('A newer version was submitted — View v3');
    expect(hrefs(notice)).toEqual([`/dashboard/submissions/${V3}`]);
    expect(container.querySelector('[data-testid="previous-versions"]')).toBeNull();
  });

  it('V5: v2 shows v1 as previous and v3 as newer', async () => {
    const { container } = await open(V2);
    expect(hrefs(container.querySelector('[data-testid="previous-versions"]'))).toEqual([`/dashboard/submissions/${V1}`]);
    expect(hrefs(container.querySelector('[data-testid="newer-version-notice"]'))).toEqual([`/dashboard/submissions/${V3}`]);
  });

  it('V6: a newer version still uploading is not offered', async () => {
    given([...CHAIN, version(V4_UPLOADING, 4, 'uploading', V3, '2026-09-05T00:00:00Z')]);
    const { container } = await open(V3);
    expect(container.querySelector('[data-testid="newer-version-notice"]')).toBeNull();
    expect(container.innerHTML).not.toContain(V4_UPLOADING);
  });

  it('V7: a null stored version number falls back to the position in the chain', async () => {
    given([
      version(V1, null, 'rejected', null, '2026-09-01T00:00:00Z'),
      version(V2, null, 'needs_changes', V1, '2026-09-02T00:00:00Z'),
    ]);
    const { container } = await open(V1);
    expect(container.querySelector('[data-testid="newer-version-notice"]')).toHaveTextContent('View v2');
  });

  it('V8: opening an older version writes nothing (it is not marked under review)', async () => {
    await open(V1);
    await open(V2);
    expect(mockEmulator.state.writes).toEqual([]);
  });
});

describe('BACKLOG-3605: the page wires the polling notice', () => {
  it('V9: the versions block is keyed by the submission id, polls, and polls from this version', async () => {
    const { element, props } = await open(V3);
    expect(findElement(element, SubmissionVersions)?.key).toBe(V3);
    expect(props).toMatchObject({ currentId: V3, poll: true });
  });

  it('V10: a support session does not poll', async () => {
    (getImpersonationSession as jest.Mock).mockResolvedValueOnce({
      session_id: 's',
      target_user_id: FIXTURE_USER_ID,
      admin_user_id: 'a',
      target_email: 'target@fixture.example.test',
      target_name: 'Target',
      expires_at: '2999-01-01T00:00:00Z',
      started_at: '2026-09-01T00:00:00Z',
    });
    const { props } = await open(V3);
    expect(props).toMatchObject({ currentId: V3, poll: false });
  });
});
