/**
 * Phone status board on the Submissions page — BACKLOG-3914.
 *
 * Everything renders the REAL SubmissionsPage / DashboardPage through the
 * PostgREST emulator. ONE fixture feeds the board, the dashboard cards and the
 * list, so lane membership and counts are compared as ID sets across all three.
 *
 * FIXTURE PROVENANCE: identical to __tests__/dashboard-cards-3904/cards.test.tsx
 * (row shape = __tests__/helpers/submissionRows.ts, the production columns;
 * chain shapes from __tests__/submission-deals-3597), plus a second submitter on
 * two deals for the agent filter. A second org WITHOUT broker_portal_access
 * holds one deal in every lane status (the org gate). Every id, name and
 * address is invented.
 */

import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';
import { submissionRow, userNameRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockAuthFrom = jest.fn();
const mockPush = jest.fn();
let mockNoAccessOrgs: string[] = [];

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('@/components/submission/SubmissionListClient', () => ({
  SubmissionListClient: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  usePathname: () => '/dashboard/submissions',
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/pwa/NavigationProgress', () => ({
  startNavigationProgress: jest.fn(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'b@example.test', user_metadata: {} } } }) },
    from: (...a: unknown[]) => mockAuthFrom(...a),
  }),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: { from: (t: string) => mockEmulator.from(t) },
    impersonation: null,
    organizationId: null,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', !mockNoAccessOrgs.includes(orgId))
    ),
  };
});

import DashboardPage from '@/app/dashboard/page';
import SubmissionsPage from '@/app/dashboard/submissions/page';
import { BOARD_LANES, OPEN_LANES } from '@/lib/submissions/boardLanes';
import { STAT_CARDS } from '@/lib/dashboard/statCards';

const ORG = FIXTURE_BROKERAGE_ORG_ID;
const AGENT_B = '00000000-0000-4000-8000-0000003914a1'; // pii-allow-uuid: invented fixture id
const ORG_NO_ACCESS = '00000000-0000-4000-8000-0000003914b2'; // pii-allow-uuid: invented fixture id

function row(id: string, status: string, parent: string | null, createdAt: string, by = FIXTURE_USER_ID): Row {
  return {
    ...submissionRow({ id, organizationId: ORG, submittedBy: by, status, parentSubmissionId: parent, createdAt }),
    version: 1,
  };
}

// c1: v1 rejected -> v2 needs_changes (head); c2: v1 needs_changes -> v2 resubmitted (head);
// a1 approved with an `uploading` v2 on top (a1 stays head); a0 submitted -> a2 approved.
const ROWS: Row[] = [
  row('c1-v1', 'rejected', null, '2026-09-01T00:00:00Z'),
  row('c1-v2', 'needs_changes', 'c1-v1', '2026-09-02T00:00:00Z'),
  row('c2-v1', 'needs_changes', null, '2026-09-01T01:00:00Z'),
  row('c2-v2', 'resubmitted', 'c2-v1', '2026-09-02T01:00:00Z'),
  row('s1', 'submitted', null, '2026-09-03T00:00:00Z'),
  row('s2', 'submitted', null, '2026-09-03T01:00:00Z', AGENT_B),
  row('u1', 'under_review', null, '2026-09-03T02:00:00Z'),
  row('n1', 'needs_changes', null, '2026-09-03T03:00:00Z', AGENT_B),
  row('a1', 'approved', null, '2026-09-03T04:00:00Z'),
  row('a1-v2', 'uploading', 'a1', '2026-09-04T00:00:00Z'),
  row('a2', 'approved', 'a0', '2026-09-03T05:00:00Z'),
  row('a0', 'submitted', null, '2026-09-01T05:00:00Z'),
  row('r1', 'rejected', null, '2026-09-03T06:00:00Z'),
];

function outsideRow(id: string, status: string, createdAt: string): Row {
  return {
    ...submissionRow({ id, organizationId: ORG_NO_ACCESS, submittedBy: FIXTURE_USER_ID, status, createdAt }),
    version: 1,
  };
}
const OUTSIDE_ROWS: Row[] = [
  outsideRow('x-sub', 'submitted', '2026-09-05T00:00:00Z'),
  outsideRow('x-resub', 'resubmitted', '2026-09-05T01:00:00Z'),
  outsideRow('x-review', 'under_review', '2026-09-05T02:00:00Z'),
  outsideRow('x-changes', 'needs_changes', '2026-09-05T03:00:00Z'),
  outsideRow('x-ok', 'approved', '2026-09-05T04:00:00Z'),
  outsideRow('x-no', 'rejected', '2026-09-05T05:00:00Z'),
];
const OUTSIDE_IDS = OUTSIDE_ROWS.map((r) => r.id as string);

/** Expected deals per lane (in-scope heads only). */
const LANE_IDS: Record<string, string[]> = {
  new: ['s1', 's2'],
  resubmitted: ['c2-v2'],
  under_review: ['u1'],
  needs_changes: ['c1-v2', 'n1'],
  approved: ['a1', 'a2'],
  rejected: ['r1'],
};

function seed() {
  mockAuthFrom.mockImplementation(() => {
    const result = { data: [brokerageMembership('broker')], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'neq', 'eq', 'order', 'limit', 'in', 'gt']) b[m] = () => b;
    b.maybeSingle = async () => ({ data: brokerageMembership('broker'), error: null });
    b.single = b.maybeSingle;
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
    return b;
  });
  mockEmulator.reset();
  mockEmulator.set({
    rows: {
      transaction_submissions: [...ROWS, ...OUTSIDE_ROWS],
      users: [
        userNameRow(FIXTURE_USER_ID, 'Avery Example', 'avery@fixture.example.test'),
        userNameRow(AGENT_B, 'Gina Example', 'gina@fixture.example.test'),
      ],
    },
  });
}

async function renderList(params: Record<string, string>) {
  seed();
  return render(await SubmissionsPage({ searchParams: Promise.resolve(params) }));
}

const board = (c: HTMLElement) => c.querySelector('[data-slot="phone-board"]') as HTMLElement | null;
const laneLinks = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-slot="board-lanes"] a')) as HTMLAnchorElement[];
const laneCounts = (c: HTMLElement) =>
  Object.fromEntries(laneLinks(c).map((a) => [a.getAttribute('data-lane'), Number(a.getAttribute('data-count'))]));
const phoneCardIds = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-slot="submission-cards"] a[data-slot="submission-card"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();
const tableIds = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('tbody a[href^="/dashboard/submissions/"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockNoAccessOrgs = [ORG_NO_ACCESS];
});

describe('lane membership (ID sets)', () => {
  it.each(BOARD_LANES.map((l) => l.value))('lane %s shows exactly its deals, none from a no-access org', async (lane) => {
    const { container } = await renderList({ view: 'board', status: lane });
    const ids = phoneCardIds(container);
    expect(ids).toEqual([...LANE_IDS[lane]].sort());
    for (const id of OUTSIDE_IDS) expect(ids).not.toContain(id);
    // The current lane is marked, and only it.
    const current = laneLinks(container).filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('data-lane'))).toEqual([lane]);
  });

  it('a tap on a card opens the submission (each card is a link to its detail page)', async () => {
    const { container } = await renderList({ view: 'board', status: 'needs_changes' });
    const hrefs = Array.from(container.querySelectorAll('[data-slot="submission-cards"] a')).map((a) => a.getAttribute('href'));
    expect(hrefs.sort()).toEqual(['/dashboard/submissions/c1-v2', '/dashboard/submissions/n1']);
  });

  it('no status, or a status that is not a lane, opens the New lane', async () => {
    const variants: Record<string, string>[] = [{ view: 'board' }, { view: 'board', status: 'all' }, { view: 'board', status: 'pending' }];
    for (const params of variants) {
      const { container, unmount } = await renderList(params);
      expect(phoneCardIds(container)).toEqual(['s1', 's2']);
      unmount();
    }
  });
});

describe('counts parity: board lane == dashboard card == filtered list', () => {
  it('the four open lanes equal the dashboard cards and the list each card opens, excluding the no-access org', async () => {
    seed();
    const dash = render(await DashboardPage());
    const cardNumbers: Record<string, number> = {};
    for (const a of Array.from(dash.container.querySelectorAll('a[aria-label$="view submissions"]'))) {
      const m = /^(.*): (\d+), view submissions$/.exec(a.getAttribute('aria-label') as string)!;
      const def = STAT_CARDS.find((d) => d.label === m[1])!;
      cardNumbers[def.filter as string] = Number(m[2]);
    }
    dash.unmount();

    const { container, unmount } = await renderList({ view: 'board' });
    const counts = laneCounts(container);
    unmount();

    // Exact values: one more each would mean the no-access org leaked in.
    expect(counts).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2 });
    for (const lane of OPEN_LANES) {
      expect(counts[lane.value]).toBe(cardNumbers[lane.value]);
      const list = await renderList({ status: lane.value });
      const listed = tableIds(list.container);
      expect(listed).toEqual([...LANE_IDS[lane.value]].sort());
      expect(listed).toHaveLength(counts[lane.value]);
      list.unmount();
    }
  });

  it('closed lanes, once shown, count the same as the list filtered to that status', async () => {
    const { container } = await renderList({ view: 'board', status: 'approved' });
    const counts = laneCounts(container);
    expect(counts).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2, approved: 2, rejected: 1 });
  });

  it('every lane count equals the number of cards that lane shows', async () => {
    for (const lane of BOARD_LANES) {
      const { container, unmount } = await renderList({ view: 'board', status: lane.value });
      expect(laneCounts(container)[lane.value]).toBe(phoneCardIds(container).length);
      unmount();
    }
  });
});

describe('search, agent and sort apply to the board', () => {
  it('agent filter narrows every lane count and the cards', async () => {
    const { container } = await renderList({ view: 'board', agent: AGENT_B });
    expect(laneCounts(container)).toEqual({ new: 1, resubmitted: 0, under_review: 0, needs_changes: 1 });
    expect(phoneCardIds(container)).toEqual(['s2']);
  });

  it('search narrows every lane count and the cards', async () => {
    const { container } = await renderList({ view: 'board', status: 'needs_changes', search: 'n1 Fixture' });
    expect(laneCounts(container)).toEqual({ new: 0, resubmitted: 0, under_review: 0, needs_changes: 1 });
    expect(phoneCardIds(container)).toEqual(['n1']);
  });

  it('lane links keep view, search, agent and sort and drop the page', async () => {
    const { container } = await renderList({ view: 'board', agent: AGENT_B, search: 'Fixture', sort: 'oldest', page: '2' });
    for (const a of laneLinks(container)) {
      const url = new URL(a.getAttribute('href') as string, 'http://x');
      expect(url.searchParams.get('view')).toBe('board');
      expect(url.searchParams.get('agent')).toBe(AGENT_B);
      expect(url.searchParams.get('search')).toBe('Fixture');
      expect(url.searchParams.get('sort')).toBe('oldest');
      expect(url.searchParams.get('status')).toBe(a.getAttribute('data-lane'));
      expect(url.searchParams.has('page')).toBe(false);
    }
  });

  it('the board has Agent and Sort but no Status control', async () => {
    const { container } = await renderList({ view: 'board' });
    const b = board(container)!;
    expect(b.querySelector('button[aria-label^="Agent"]')).not.toBeNull();
    expect(b.querySelector('button[aria-label^="Sort:"]')).not.toBeNull();
    expect(b.querySelector('button[aria-label^="Status"]')).toBeNull();
  });
});

describe('phone only, read-only', () => {
  it('the board and the view toggle sit only inside md:hidden containers', async () => {
    const { container } = await renderList({ view: 'board' });
    const b = board(container)!;
    expect(b.className.split(/\s+/)).toContain('md:hidden');
    for (const el of Array.from(container.querySelectorAll('nav[aria-label="View"], [data-slot="board-lanes"]'))) {
      expect(el.closest('.md\\:hidden')).not.toBeNull();
    }
    // The cards under the lanes are the phone card list (md:hidden); the md+ table is unchanged.
    expect(container.querySelector('[data-slot="submission-cards"]')!.className.split(/\s+/)).toContain('md:hidden');
    expect(container.querySelector('table')!.className.split(/\s+/)).toContain('max-md:hidden');
  });

  it('the list view has the toggle (phone only) and no board', async () => {
    const { container } = await renderList({});
    expect(board(container)).toBeNull();
    const toggle = container.querySelector('nav[aria-label="View"]')!;
    expect(toggle.closest('.md\\:hidden')).not.toBeNull();
    const hrefs = Array.from(toggle.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);
    expect(hrefs).toEqual([
      ['List', '/dashboard/submissions', 'page'],
      ['Board', '/dashboard/submissions?status=new&view=board', null],
    ]);
  });

  it('switching the list (status under_review) to the board opens that lane; back to the list clears the status', async () => {
    const list = await renderList({ status: 'under_review', agent: AGENT_B });
    const toBoard = list.container.querySelector('nav[aria-label="View"] a:nth-child(2)')!.getAttribute('href')!;
    expect(new URL(toBoard, 'http://x').searchParams.get('status')).toBe('under_review');
    expect(new URL(toBoard, 'http://x').searchParams.get('agent')).toBe(AGENT_B);
    list.unmount();
    const b = await renderList({ view: 'board', status: 'under_review', agent: AGENT_B, sort: 'oldest' });
    const toList = b.container.querySelector('nav[aria-label="View"] a:nth-child(1)')!.getAttribute('href')!;
    expect(toList).toBe(`/dashboard/submissions?agent=${AGENT_B}&sort=oldest`);
  });

  it('cards cannot be dragged and nothing on the board changes a status', async () => {
    const { container } = await renderList({ view: 'board', status: 'needs_changes' });
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    const buttons = Array.from(board(container)!.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? b.textContent
    );
    // Agent, Sort and the show-closed toggle: the only buttons. No status action.
    expect(buttons).toEqual(['Agent: All agents', 'Sort: Newest first', 'Show approved and rejected']);
  });

  it('Approved and Rejected are hidden until asked for', async () => {
    const { container } = await renderList({ view: 'board' });
    expect(Object.keys(laneCounts(container))).toEqual(['new', 'resubmitted', 'under_review', 'needs_changes']);
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Show approved and rejected')!;
    fireEvent.click(toggle);
    expect(Object.keys(laneCounts(container))).toEqual([
      'new',
      'resubmitted',
      'under_review',
      'needs_changes',
      'approved',
      'rejected',
    ]);
    expect(toggle.textContent).toBe('Hide approved and rejected');
  });

  it('an empty lane says "Nothing here" on the phone', async () => {
    const { container } = await renderList({ view: 'board', agent: AGENT_B, status: 'under_review' });
    const empty = container.querySelector('[data-slot="board-lane-empty"]')!;
    expect(empty.textContent).toBe('Nothing here');
    expect(empty.className.split(/\s+/)).toContain('md:hidden');
  });
});
