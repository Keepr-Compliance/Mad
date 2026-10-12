/**
 * Desktop status board on the Submissions page — BACKLOG-3914.
 *
 * Everything renders the REAL SubmissionsPage / DashboardPage through the
 * PostgREST emulator. ONE fixture feeds the board, the dashboard cards and the
 * list, so lane membership and counts are compared as ID sets across all three.
 *
 * FIXTURE PROVENANCE: identical to __tests__/dashboard-cards-3904/cards.test.tsx
 * (row shape = __tests__/helpers/submissionRows.ts, the production columns;
 * chain shapes from __tests__/submission-deals-3597), plus a second submitter on
 * two deals for the agent filter. A second org WITHOUT broker_portal_access
 * (fixtures/orgFeatures withFeature, the production feature shape) holds one
 * deal in every lane status (the org gate). Every id, name and address is invented.
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
import { BOARD_LANES, LANE_CARD_CAP, OPEN_LANES } from '@/lib/submissions/boardLanes';
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


const boardRoot = (c: HTMLElement) => c.querySelector('[data-slot="submission-board"]') as HTMLElement | null;
const lanes = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-slot="board-lanes"] > section')) as HTMLElement[];
const laneCounts = (c: HTMLElement) =>
  Object.fromEntries(lanes(c).map((s) => [s.getAttribute('data-lane'), Number(s.getAttribute('data-count'))]));
const laneCardIds = (lane: HTMLElement) =>
  Array.from(lane.querySelectorAll('a[data-slot="submission-card"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();
const laneIdSets = (c: HTMLElement) => Object.fromEntries(lanes(c).map((s) => [s.getAttribute('data-lane'), laneCardIds(s)]));
const phoneCardIds = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-slot="submission-cards"] a[data-slot="submission-card"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();
const tableIds = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('tbody a[href^="/dashboard/submissions/"]'))
    .map((a) => (a.getAttribute('href') as string).split('/').pop() as string)
    .sort();
const toggle = (c: HTMLElement) => c.querySelector('nav[aria-label="View"]') as HTMLElement | null;
const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
const url = (href: string) => new URL(href, 'http://x');

beforeEach(() => {
  jest.clearAllMocks();
  mockNoAccessOrgs = [ORG_NO_ACCESS];
});

describe('lane membership (ID sets)', () => {
  it('the four open lanes hold exactly their deals, none from a no-access org', async () => {
    const { container } = await renderList({ view: 'board' });
    expect(laneIdSets(container)).toEqual({
      new: LANE_IDS.new,
      resubmitted: LANE_IDS.resubmitted,
      under_review: LANE_IDS.under_review,
      needs_changes: LANE_IDS.needs_changes,
    });
    const all = lanes(container).flatMap(laneCardIds);
    for (const id of OUTSIDE_IDS) expect(all).not.toContain(id);
  });

  it('with Approved and Rejected shown, all six lanes hold exactly their deals', async () => {
    const { container } = await renderList({ view: 'board', closed: '1' });
    expect(laneIdSets(container)).toEqual(
      Object.fromEntries(BOARD_LANES.map((l) => [l.value, [...LANE_IDS[l.value]].sort()]))
    );
  });

  it('every card opens its submission', async () => {
    const { container } = await renderList({ view: 'board' });
    const lane = lanes(container).find((s) => s.getAttribute('data-lane') === 'needs_changes')!;
    const hrefs = Array.from(lane.querySelectorAll('a[data-slot="submission-card"]')).map((a) => a.getAttribute('href'));
    expect(hrefs.sort()).toEqual(['/dashboard/submissions/c1-v2', '/dashboard/submissions/n1']);
  });

  it('the status in the URL does not change the board (Status is moot there)', async () => {
    for (const status of ['approved', 'under_review', 'pending']) {
      const { container, unmount } = await renderList({ view: 'board', status });
      expect(Object.keys(laneCounts(container))).toEqual(OPEN_LANES.map((l) => l.value));
      expect(laneCounts(container)).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2 });
      unmount();
    }
  });
});

describe('counts parity: board lane == dashboard card == filtered list', () => {
  it('the four open lanes equal the dashboard cards and the list filtered to each lane', async () => {
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
    const ids = laneIdSets(container);
    unmount();

    // Exact values: one more each would mean the no-access org leaked in.
    expect(counts).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2 });
    for (const lane of OPEN_LANES) {
      expect(counts[lane.value]).toBe(cardNumbers[lane.value]);
      const list = await renderList({ status: lane.value });
      expect(tableIds(list.container)).toEqual(ids[lane.value]);
      list.unmount();
    }
  });

  it('closed lanes count the same as the list filtered to that status', async () => {
    const { container } = await renderList({ view: 'board', closed: '1' });
    const ids = laneIdSets(container);
    expect(laneCounts(container)).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2, approved: 2, rejected: 1 });
    for (const lane of ['approved', 'rejected']) {
      const list = await renderList({ status: lane });
      expect(tableIds(list.container)).toEqual(ids[lane]);
      list.unmount();
    }
  });

  it('the header subtitle counts the deals on the board', async () => {
    const { container } = await renderList({ view: 'board' });
    expect(container.querySelector('h1')!.parentElement!.querySelector('p')!.textContent).toBe('6 submissions');
  });
});

describe('org gate', () => {
  it('an org without broker access contributes nothing; with access its deals appear (the fixture can leak)', async () => {
    const gated = await renderList({ view: 'board', closed: '1' });
    expect(laneCounts(gated.container)).toEqual({ new: 2, resubmitted: 1, under_review: 1, needs_changes: 2, approved: 2, rejected: 1 });
    gated.unmount();
    mockNoAccessOrgs = [];
    const open = await renderList({ view: 'board', closed: '1' });
    expect(laneCounts(open.container)).toEqual({ new: 3, resubmitted: 2, under_review: 2, needs_changes: 3, approved: 3, rejected: 2 });
    open.unmount();
  });
});

describe('search, agent and sort apply to the board', () => {
  it('the agent filter narrows every lane', async () => {
    const { container } = await renderList({ view: 'board', agent: AGENT_B });
    expect(laneCounts(container)).toEqual({ new: 1, resubmitted: 0, under_review: 0, needs_changes: 1 });
    expect(laneIdSets(container)).toEqual({ new: ['s2'], resubmitted: [], under_review: [], needs_changes: ['n1'] });
    expect(container.querySelectorAll('[data-slot="board-lane-empty"]')).toHaveLength(2);
  });

  it('search narrows every lane', async () => {
    const { container } = await renderList({ view: 'board', search: 'n1 Fixture' });
    expect(laneCounts(container)).toEqual({ new: 0, resubmitted: 0, under_review: 0, needs_changes: 1 });
  });

  it('sort orders the cards within a lane', async () => {
    const order = async (sort?: string) => {
      const { container, unmount } = await renderList(sort ? { view: 'board', sort } : { view: 'board' });
      const lane = lanes(container).find((s) => s.getAttribute('data-lane') === 'new')!;
      const ids = Array.from(lane.querySelectorAll('a[data-slot="submission-card"]')).map((a) => (a.getAttribute('href') as string).split('/').pop());
      unmount();
      return ids;
    };
    expect(await order()).toEqual(['s2', 's1']);
    expect(await order('oldest')).toEqual(['s1', 's2']);
  });

  it('the desktop filter card has search and Agent but no Status select on the board', async () => {
    const { container } = await renderList({ view: 'board' });
    expect(container.querySelector('#submissions-status-desktop')).toBeNull();
    expect(container.querySelector('#submissions-agent-desktop')).not.toBeNull();
    expect(container.querySelector('#submissions-search-desktop')).not.toBeNull();
    const list = await renderList({});
    expect(list.container.querySelector('#submissions-status-desktop')).not.toBeNull();
  });
});

describe('view param', () => {
  it('a desktop status change drops view=board', async () => {
    const { container } = await renderList({ agent: AGENT_B });
    // The status select exists only on the list; it must never carry the board along.
    fireEvent.change(container.querySelector('#submissions-status-desktop')!, { target: { value: 'all' } });
    expect(mockPush).toHaveBeenCalledWith(`/dashboard/submissions?agent=${AGENT_B}`);
  });

  it('a phone status change on a board URL drops view=board and closed, and the result lists every status', async () => {
    const { container } = await renderList({ view: 'board', closed: '1', agent: AGENT_B, sort: 'oldest' });
    fireEvent.click(container.querySelector('button[aria-label^="Status"]')!);
    fireEvent.click(Array.from(document.querySelectorAll('button[aria-pressed]')).find((b) => b.textContent!.startsWith('Pending ·'))!);
    fireEvent.click(Array.from(document.querySelectorAll('button')).find((b) => /^Show \d+ submission/.test(b.textContent ?? ''))!);
    const pushed = url(mockPush.mock.calls.at(-1)![0]);
    expect(pushed.searchParams.has('view')).toBe(false);
    expect(pushed.searchParams.has('closed')).toBe(false);
    expect(pushed.searchParams.get('status')).toBe('submitted');
    expect(pushed.searchParams.get('agent')).toBe(AGENT_B);
    // Render the pushed URL: the list (both widths), with the chosen status.
    const next = await renderList(Object.fromEntries(pushed.searchParams));
    expect(boardRoot(next.container)).toBeNull();
    expect(tableIds(next.container)).toEqual(['s2']);
  });

  it('desktop Clear filters on the board keeps the board and its closed lanes', async () => {
    const { container } = await renderList({ view: 'board', closed: '1', agent: AGENT_B });
    const clear = Array.from(container.querySelectorAll('[data-slot="submissions-results-desktop"] button')).find(
      (b) => b.textContent === 'Clear filters'
    )!;
    fireEvent.click(clear);
    expect(mockPush).toHaveBeenCalledWith('/dashboard/submissions?view=board&closed=1');
  });

  it('Show / Hide approved and rejected: hidden by default, shown on ?closed=1, hide returns to the four open lanes', async () => {
    const hidden = await renderList({ view: 'board', agent: AGENT_B, sort: 'oldest' });
    const show = hidden.container.querySelector('[data-slot="board-toggle-closed"]')!;
    expect(show.textContent).toBe('Show approved and rejected (0)');
    const showUrl = url(show.getAttribute('href')!);
    expect(showUrl.searchParams.get('closed')).toBe('1');
    expect(showUrl.searchParams.get('view')).toBe('board');
    hidden.unmount();
    const allHidden = await renderList({ view: 'board' });
    expect(allHidden.container.querySelector('[data-slot="board-toggle-closed"]')!.textContent).toBe('Show approved and rejected (3)');
    allHidden.unmount();

    // Shown, with a closed status in the URL (as a list link would leave it): Hide must fall back
    // to the open lanes and drop the status, keeping search/agent/sort.
    const shown = await renderList({ view: 'board', closed: '1', status: 'approved', agent: AGENT_B, sort: 'oldest' });
    expect(Object.keys(laneCounts(shown.container))).toEqual(BOARD_LANES.map((l) => l.value));
    const hide = shown.container.querySelector('[data-slot="board-toggle-closed"]')!;
    expect(hide.textContent).toBe('Hide approved and rejected');
    expect(hide.getAttribute('href')).toBe(`/dashboard/submissions?agent=${AGENT_B}&sort=oldest&view=board`);
    shown.unmount();
    const back = await renderList(Object.fromEntries(url(hide.getAttribute('href')!).searchParams));
    expect(Object.keys(laneCounts(back.container))).toEqual(OPEN_LANES.map((l) => l.value));
  });

  it('toggle hrefs: List -> Board drops status and keeps search/agent/sort; Board -> List lists All', async () => {
    const list = await renderList({ status: 'under_review', agent: AGENT_B, search: 'Fixture', sort: 'oldest', page: '2' });
    const links = Array.from(toggle(list.container)!.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);
    expect(links).toEqual([
      ['List', `/dashboard/submissions?status=under_review&agent=${AGENT_B}&search=Fixture&sort=oldest`, 'page'],
      ['Board', `/dashboard/submissions?agent=${AGENT_B}&search=Fixture&sort=oldest&view=board`, null],
    ]);
    list.unmount();
    const b = await renderList({ view: 'board', closed: '1', agent: AGENT_B });
    const back = Array.from(toggle(b.container)!.querySelectorAll('a')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);
    expect(back).toEqual([
      ['List', `/dashboard/submissions?agent=${AGENT_B}`, null],
      ['Board', `/dashboard/submissions?agent=${AGENT_B}&view=board`, 'page'],
    ]);
  });
});

describe('desktop only, read-only', () => {
  it('the board and the toggle sit only inside max-md:hidden; on the board the list is md:hidden', async () => {
    const { container } = await renderList({ view: 'board' });
    expect(classes(boardRoot(container)!.parentElement)).toContain('max-md:hidden');
    expect(classes(toggle(container)!.closest('[data-slot="submissions-view-toggle"]'))).toContain('max-md:hidden');
    // The toggle is in the page header, opposite the title.
    expect(toggle(container)!.closest('div.justify-between')!.querySelector('h1')!.textContent).toBe('Submissions');
    const listFrame = container.querySelector('[data-slot="submission-cards"]')!.parentElement!;
    expect(classes(listFrame)).toContain('md:hidden');
  });

  it('a phone on a board URL gets the normal list: URL status honoured, Status control present', async () => {
    const { container } = await renderList({ view: 'board', status: 'approved' });
    expect(phoneCardIds(container)).toEqual(['a1', 'a2']);
    expect(container.querySelector('button[aria-label^="Status"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="Agent"]')).not.toBeNull();
  });

  it('the list view has the toggle and no board; its list frame is not hidden on desktop', async () => {
    const { container } = await renderList({});
    expect(boardRoot(container)).toBeNull();
    expect(toggle(container)).not.toBeNull();
    expect(classes(container.querySelector('[data-slot="submission-cards"]')!.parentElement)).not.toContain('md:hidden');
  });

  it('nothing on the board is draggable or changes a status', async () => {
    const { container } = await renderList({ view: 'board', closed: '1' });
    const b = boardRoot(container)!;
    expect(b.querySelector('[draggable="true"]')).toBeNull();
    expect(b.querySelectorAll('button, select, input')).toHaveLength(0);
    // Every link is a card, a "View all", or the show/hide toggle.
    for (const a of Array.from(b.querySelectorAll('a'))) {
      expect(['submission-card', 'board-lane-view-all', 'board-toggle-closed']).toContain(a.getAttribute('data-slot'));
    }
  });
});

describe('long lanes', () => {
  it(`a lane longer than ${LANE_CARD_CAP} shows ${LANE_CARD_CAP} cards and "View all N" to the list filtered to it`, async () => {
    seed();
    const extra: Row[] = Array.from({ length: LANE_CARD_CAP + 3 }, (_, i) =>
      row(`bulk-${String(i).padStart(2, '0')}`, 'under_review', null, `2026-08-${String(1 + i).padStart(2, '0')}T00:00:00Z`)
    );
    mockEmulator.set({ rows: { transaction_submissions: [...ROWS, ...OUTSIDE_ROWS, ...extra] } });
    const { container } = render(await SubmissionsPage({ searchParams: Promise.resolve({ view: 'board', agent: FIXTURE_USER_ID, sort: 'oldest' }) }));
    const lane = lanes(container).find((s) => s.getAttribute('data-lane') === 'under_review')!;
    expect(lane.getAttribute('data-count')).toBe(String(LANE_CARD_CAP + 4));
    expect(lane.querySelectorAll('a[data-slot="submission-card"]')).toHaveLength(LANE_CARD_CAP);
    const all = lane.querySelector('[data-slot="board-lane-view-all"]')!;
    expect(all.textContent).toBe(`View all ${LANE_CARD_CAP + 4}`);
    expect(all.getAttribute('href')).toBe(`/dashboard/submissions?status=under_review&agent=${FIXTURE_USER_ID}&sort=oldest`);
    // Oldest first: the first card is the oldest bulk deal.
    expect(lane.querySelector('a[data-slot="submission-card"]')!.getAttribute('href')).toBe('/dashboard/submissions/bulk-00');
    // A short lane has no "View all".
    expect(lanes(container).find((s) => s.getAttribute('data-lane') === 'new')!.querySelector('[data-slot="board-lane-view-all"]')).toBeNull();
  });
});
