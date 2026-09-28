/**
 * One row per deal — BACKLOG-3597.
 *
 * The REAL broker Submissions list page and the REAL lib/submissions/dealList
 * run against the PostgREST emulator (eq/neq/in applied as filters, NO RLS, so
 * every scope asserted here is the page's own query). The feature gate's
 * payload is the transcribed ORG_WITHOUT_PLAN_FEATURES with broker_portal_access
 * switched per organization.
 *
 * FIXTURE PROVENANCE (read-only MCP on production, 2026-09-27; every id invented):
 *   - row shape: __tests__/helpers/submissionRows.ts (the production columns).
 *   - chain shapes, live: v1 `rejected` (parent null) -> v2 `needs_changes`
 *     (parent = v1); v3 `needs_changes` -> v4 `resubmitted`. Every live child
 *     has the same organization_id, submitted_by and local_transaction_id as
 *     its parent, a later created_at, and no row has two children.
 *   - the producer inserts every version as `uploading` first
 *     (electron/services/submissionService.ts), so an uploading child exists
 *     for a while under a landed parent.
 */

import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
let mockImpersonatedOrg: string | null = null;
let mockPortalAccess: Record<string, boolean> = {};

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: { from: (t: string) => mockEmulator.from(t) },
    impersonation: mockImpersonatedOrg ? { organizationId: mockImpersonatedOrg } : null,
    organizationId: mockImpersonatedOrg,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', mockPortalAccess[orgId] ?? true)
    ),
  };
});
jest.mock('@/lib/auth/portalAccess', () => ({ requireFullPortalAccess: jest.fn(async () => ({ ok: true })) }));
jest.mock('@/components/submission/SubmissionListClient', () => ({
  SubmissionListClient: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  usePathname: () => '/dashboard/submissions',
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';
import { loadDealPage, selectDealHeads, READ_BLOCK, type ChainLink } from '@/lib/submissions/dealList';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = FIXTURE_BROKERAGE_ORG_ID;
const ORG_NO_ACCESS = '00000000-0000-4000-8000-0000003597b1'; // pii-allow-uuid: invented fixture id
const AGENT = '00000000-0000-4000-8000-0000003597a1'; // pii-allow-uuid: invented fixture id
const V1 = '00000000-0000-4000-8000-000000359701'; // pii-allow-uuid: invented fixture id
const V2 = '00000000-0000-4000-8000-000000359702'; // pii-allow-uuid: invented fixture id
const W3 = '00000000-0000-4000-8000-000000359713'; // pii-allow-uuid: invented fixture id
const W4 = '00000000-0000-4000-8000-000000359714'; // pii-allow-uuid: invented fixture id
const W5_UPLOADING = '00000000-0000-4000-8000-000000359715'; // pii-allow-uuid: invented fixture id
const SOLO = '00000000-0000-4000-8000-000000359720'; // pii-allow-uuid: invented fixture id
const HIDDEN = '00000000-0000-4000-8000-000000359730'; // pii-allow-uuid: invented fixture id

function version(
  id: string,
  n: number,
  status: string,
  parent: string | null,
  createdAt: string,
  org: string = ORG
): Row {
  return {
    ...submissionRow({ id, organizationId: org, submittedBy: AGENT, status, parentSubmissionId: parent, createdAt }),
    version: n,
  };
}

/** Deal A: the live 2-version shape. Deal B: v3 -> v4 (+ a v5 still uploading). Deal C: one version. */
const ROWS: Row[] = [
  // Deliberately NOT in created_at order: the list must sort.
  version(SOLO, 1, 'submitted', null, '2026-09-05T00:00:00Z'),
  version(V1, 1, 'rejected', null, '2026-09-01T00:00:00Z'),
  version(W3, 3, 'needs_changes', null, '2026-09-02T00:00:00Z'),
  version(V2, 2, 'needs_changes', V1, '2026-09-06T00:00:00Z'),
  version(W4, 4, 'resubmitted', W3, '2026-09-04T00:00:00Z'),
  version(W5_UPLOADING, 5, 'uploading', W4, '2026-09-07T00:00:00Z'),
  version(HIDDEN, 1, 'submitted', null, '2026-09-08T00:00:00Z', ORG_NO_ACCESS),
];

function given(rows: Row[] = ROWS, opts: { impersonating?: string | null; noAccess?: string[] } = {}): void {
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: rows } });
  mockImpersonatedOrg = opts.impersonating ?? null;
  mockPortalAccess = Object.fromEntries((opts.noAccess ?? [ORG_NO_ACCESS]).map((o) => [o, false]));
}

async function renderList(params: { status?: string; page?: string } = {}) {
  const element = await SubmissionsPage({ searchParams: Promise.resolve(params) });
  return render(element);
}

/** Ids of the rows the list renders, in rendered order. */
function listedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody a[href^="/dashboard/submissions/"]')).map(
    (a) => (a.getAttribute('href') as string).split('/').pop() as string
  );
}

beforeEach(() => given());

// ---------------------------------------------------------------------------
// The broker list page
// ---------------------------------------------------------------------------

describe('broker Submissions list: one row per deal', () => {
  it('D1: a 2-version deal shows once, as its latest version; a single-version deal is unchanged', async () => {
    const { container } = await renderList();
    // Newest first by the head's own created_at: V2 (09-06), SOLO (09-05), W4 (09-04).
    expect(listedIds(container)).toEqual([V2, SOLO, W4]);
  });

  it('D1b: the row shows the latest version\'s status', async () => {
    const { container } = await renderList();
    const row = container.querySelector(`a[href="/dashboard/submissions/${V2}"]`)!.closest('tr')!;
    expect(row).toHaveTextContent('Needs Changes');
    expect(row).not.toHaveTextContent('Rejected');
  });

  it('D2: the status filter matches the head\'s status, never an older version\'s', async () => {
    // V1 is rejected, but superseded by V2: no deal is rejected.
    expect(listedIds((await renderList({ status: 'rejected' })).container)).toEqual([]);
    // W3 (needs_changes) is superseded; only V2's deal is needs_changes.
    expect(listedIds((await renderList({ status: 'needs_changes' })).container)).toEqual([V2]);
  });

  it('D2b: "Pending" lists submitted AND resubmitted deals, on the head, and nothing else', async () => {
    // One single-version deal per status, plus the fixture chains. Heads:
    // V2 needs_changes, SOLO submitted, W4 resubmitted, and one each below.
    const extra = (id: string, status: string, day: string) => version(id, 1, status, null, `2026-09-${day}T00:00:00Z`);
    const P_UR = '00000000-0000-4000-8000-000000359741'; // pii-allow-uuid: invented fixture id
    const P_NC = '00000000-0000-4000-8000-000000359742'; // pii-allow-uuid: invented fixture id
    const P_AP = '00000000-0000-4000-8000-000000359743'; // pii-allow-uuid: invented fixture id
    const P_RJ = '00000000-0000-4000-8000-000000359744'; // pii-allow-uuid: invented fixture id
    given([
      ...ROWS,
      extra(P_UR, 'under_review', '10'),
      extra(P_NC, 'needs_changes', '11'),
      extra(P_AP, 'approved', '12'),
      extra(P_RJ, 'rejected', '13'),
    ]);
    const pending = await renderList({ status: 'submitted' });
    // SOLO (submitted, 09-05) and W4 (resubmitted, 09-04). W4's superseded
    // parent W3 is needs_changes and must not pull the deal in or out.
    expect(listedIds(pending.container)).toEqual([SOLO, W4]);
    expect(pending.container).toHaveTextContent('2 submissions with status');
    // The tab's label is still "Pending".
    expect(pending.container.querySelector('a[href="/dashboard/submissions?status=submitted"]')).toHaveTextContent(
      /^Pending$/
    );
    // Every other tab is unchanged: an exact match on the head's status.
    expect(listedIds((await renderList({ status: 'needs_changes' })).container)).toEqual([P_NC, V2]);
    expect(listedIds((await renderList({ status: 'approved' })).container)).toEqual([P_AP]);
    expect(listedIds((await renderList({ status: 'rejected' })).container)).toEqual([P_RJ]);
    expect(listedIds((await renderList({ status: 'under_review' })).container)).toEqual([P_UR]);
  });

  it('D3: the count is of deals, not rows', async () => {
    const { container } = await renderList();
    expect(container).toHaveTextContent('3 submissions');
    const filtered = await renderList({ status: 'needs_changes' });
    expect(filtered.container).toHaveTextContent('1 submission with status');
  });

  it('D4: a version still uploading does not displace its parent', async () => {
    const { container } = await renderList();
    expect(listedIds(container)).toContain(W4);
    expect(container.innerHTML).not.toContain(W5_UPLOADING);
  });

  it('D5: pagination is per deal (30 two-version deals = 30 deals, 2 pages)', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0');
      const root = `00000000-0000-4000-8000-0000003599${n}`; // pii-allow-uuid: invented fixture id
      const head = `00000000-0000-4000-8000-0000003598${n}`; // pii-allow-uuid: invented fixture id
      rows.push(version(root, 1, 'needs_changes', null, `2026-08-01T00:${n}:00Z`));
      rows.push(version(head, 2, 'submitted', root, `2026-09-01T00:${n}:00Z`));
    }
    given(rows);
    const first = await renderList();
    expect(first.container).toHaveTextContent('30 submissions');
    const page1 = listedIds(first.container);
    expect(page1).toHaveLength(25);
    expect(page1.every((id) => id.includes('3598'))).toBe(true);
    expect(first.container.querySelector('a[href*="page=2"]')).not.toBeNull();

    const second = await renderList({ page: '2' });
    const page2 = listedIds(second.container);
    expect(page2).toHaveLength(5);
    expect(new Set([...page1, ...page2]).size).toBe(30);
  });

  it('D6: a page past the end shows the last page', async () => {
    const { container } = await renderList({ page: '9' });
    expect(listedIds(container)).toEqual([V2, SOLO, W4]);
  });

  it('D7: broker_portal_access filtering is unchanged (an org without it lists nothing)', async () => {
    const { container } = await renderList();
    expect(container.innerHTML).not.toContain(HIDDEN);
    given(ROWS, { noAccess: [ORG_NO_ACCESS, ORG] });
    expect(listedIds((await renderList()).container)).toEqual([]);
  });

  it('D8: impersonation scopes every read to the impersonated org', async () => {
    given(ROWS, { impersonating: ORG_NO_ACCESS, noAccess: [] });
    const { container } = await renderList();
    expect(listedIds(container)).toEqual([HIDDEN]);
  });

  it('D9: two reads of transaction_submissions per render beyond the org lookup, none per row', async () => {
    await renderList();
    const reads = mockEmulator.state.selects.filter((s) => s.table === 'transaction_submissions');
    // getAllowedOrgIds, the chain links, the page rows.
    expect(reads.map((r) => r.columns)).toEqual(['organization_id', 'id, parent_submission_id, status, created_at', '*']);
    expect(mockEmulator.state.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lib/submissions/dealList
// ---------------------------------------------------------------------------

function link(id: string, parent: string | null, status: string, createdAt: string): ChainLink {
  return { id, parent_submission_id: parent, status, created_at: createdAt };
}

describe('selectDealHeads', () => {
  it('keeps the head of each chain and every single-version deal', () => {
    const heads = selectDealHeads([
      link('v1', null, 'rejected', '1'),
      link('v2', 'v1', 'needs_changes', '2'),
      link('solo', null, 'submitted', '3'),
    ]);
    expect(heads.map((h) => h.id)).toEqual(['v2', 'solo']);
  });

  it('an uploading child does not supersede its parent (in case the read ever includes it)', () => {
    const heads = selectDealHeads([link('v1', null, 'needs_changes', '1'), link('v2', 'v1', 'uploading', '2')]);
    expect(heads.map((h) => h.id)).toEqual(['v1']);
  });
});

describe('loadDealPage', () => {
  it('reads links in blocks of READ_BLOCK until a short block', async () => {
    const all: ChainLink[] = Array.from({ length: READ_BLOCK + 3 }, (_, i) =>
      link(`d${String(i).padStart(5, '0')}`, null, 'submitted', String(i).padStart(5, '0'))
    );
    const calls: [number, number][] = [];
    const result = await loadDealPage<{ id: string }>({
      readLinks: async (from, to) => {
        calls.push([from, to]);
        return { data: all.slice(from, to + 1), error: null };
      },
      readRows: async (ids) => ({ data: ids.map((id) => ({ id })), error: null }),
      status: null,
      page: 1,
      pageSize: 25,
    });
    expect(calls).toEqual([
      [0, READ_BLOCK - 1],
      [READ_BLOCK, 2 * READ_BLOCK - 1],
    ]);
    expect(result.total).toBe(READ_BLOCK + 3);
  });

  it('never reads rows for an empty page', async () => {
    const readRows = jest.fn();
    const result = await loadDealPage({
      readLinks: async () => ({ data: [], error: null }),
      readRows,
      status: null,
      page: 1,
      pageSize: 25,
    });
    expect(readRows).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: [], total: 0, page: 1, totalPages: 1, error: null });
  });

  it('returns rows in head order whatever order the id read answers in', async () => {
    const result = await loadDealPage<{ id: string }>({
      readLinks: async () => ({
        data: [link('old', null, 'submitted', '2026-01'), link('new', null, 'submitted', '2026-02')],
        error: null,
      }),
      readRows: async (ids) => ({ data: [...ids].reverse().map((id) => ({ id })), error: null }),
      status: null,
      page: 1,
      pageSize: 25,
    });
    expect(result.rows.map((r) => r.id)).toEqual(['new', 'old']);
  });
});
