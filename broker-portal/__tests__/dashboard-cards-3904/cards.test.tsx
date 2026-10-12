/**
 * Dashboard stat cards link to the Submissions list - BACKLOG-3904.
 *
 * ONE fixture feeds both sides: the card's number and the list the card's link
 * opens. The real DashboardPage reads it through the PostgREST emulator; the
 * list side is the real pageOfHeads filtered by the status parsed OUT OF THE
 * RENDERED href (so a card pointing at the wrong status goes red).
 *
 * FIXTURE PROVENANCE: row shape = __tests__/helpers/submissionRows.ts (the
 * production columns). Chain shapes copied from __tests__/submission-deals-3597:
 * live chains were v1 `rejected` -> v2 `needs_changes` and v3 `needs_changes`
 * -> v4 `resubmitted`; the producer inserts a version as `uploading` first.
 * Every id and address is invented.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
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
const mockAuthFrom = jest.fn();
const mockStartProgress = jest.fn();

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({ redirect: jest.fn(), usePathname: () => '/dashboard' }));
jest.mock('@/components/pwa/NavigationProgress', () => ({
  startNavigationProgress: () => mockStartProgress(),
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
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', true)
    ),
  };
});

import DashboardPage from '@/app/dashboard/page';
import { DashboardStatCards } from '@/components/dashboard/DashboardStatCards';
import { STAT_CARDS, buildStatCards, cardDealIds } from '@/lib/dashboard/statCards';
import { headMatchesFilter, pageOfHeads, selectDealHeads, type ChainLink } from '@/lib/submissions/dealList';

const ORG = FIXTURE_BROKERAGE_ORG_ID;
function row(id: string, status: string, parent: string | null, createdAt: string): Row {
  return {
    ...submissionRow({ id, organizationId: ORG, submittedBy: FIXTURE_USER_ID, status, parentSubmissionId: parent, createdAt }),
    version: 1,
  };
}

// v1 rejected -> v2 needs_changes (head); v3 needs_changes -> v4 resubmitted (head);
// a-1 approved with an `uploading` v2 on top (parent stays head).
const ROWS: Row[] = [
  row('c1-v1', 'rejected', null, '2026-09-01T00:00:00Z'),
  row('c1-v2', 'needs_changes', 'c1-v1', '2026-09-02T00:00:00Z'),
  row('c2-v1', 'needs_changes', null, '2026-09-01T01:00:00Z'),
  row('c2-v2', 'resubmitted', 'c2-v1', '2026-09-02T01:00:00Z'),
  row('s1', 'submitted', null, '2026-09-03T00:00:00Z'),
  row('s2', 'submitted', null, '2026-09-03T01:00:00Z'),
  row('u1', 'under_review', null, '2026-09-03T02:00:00Z'),
  row('n1', 'needs_changes', null, '2026-09-03T03:00:00Z'),
  row('a1', 'approved', null, '2026-09-03T04:00:00Z'),
  row('a1-v2', 'uploading', 'a1', '2026-09-04T00:00:00Z'),
  row('a2', 'approved', 'a0', '2026-09-03T05:00:00Z'),
  row('a0', 'submitted', null, '2026-09-01T05:00:00Z'),
  row('r1', 'rejected', null, '2026-09-03T06:00:00Z'),
];
const LINKS = ROWS as unknown as ChainLink[];
const HEADS = selectDealHeads(LINKS.filter((l) => l.status !== 'uploading'));

function statusOf(href: string): string {
  return new URL(href, 'http://x').searchParams.get('status') ?? 'all';
}

async function renderDashboard() {
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
  mockEmulator.set({ rows: { transaction_submissions: ROWS } });
  return render(await DashboardPage());
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fixture sanity (so the controls below can fail)', () => {
  it('has heads in every status the cards separate', () => {
    expect(HEADS.map((h) => h.id).sort()).toEqual(
      ['a1', 'a2', 'c1-v2', 'c2-v2', 'n1', 'r1', 's1', 's2', 'u1']
    );
    // rows != deals: 13 raw rows, 9 deals
    expect(ROWS).toHaveLength(13);
  });
});

describe('cards on the real dashboard', () => {
  it('shows the deal counts and the hrefs', async () => {
    await renderDashboard();
    const hrefs = Object.fromEntries(
      screen.getAllByRole('link').map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])
    );
    expect(hrefs['Needs Changes: 2, view submissions']).toBe('/dashboard/submissions?status=needs_changes');
    expect(hrefs['Approved: 2, view submissions']).toBe('/dashboard/submissions?status=approved');
    expect(hrefs['Total Submissions: 9, view submissions']).toBe('/dashboard/submissions');
  });

  it('Pending Review is not a link and counts submitted + under_review deals', async () => {
    await renderDashboard();
    expect(screen.queryByRole('link', { name: /Pending Review/ })).toBeNull();
    const label = screen.getByText('Pending Review');
    expect(label.closest('a')).toBeNull();
    expect(within(label.parentElement as HTMLElement).getByText('3')).toBeInTheDocument();
  });

  it('every linked card opens exactly the deals its number counts (ID sets, not counts)', async () => {
    const { container } = await renderDashboard();
    const linked = Array.from(container.querySelectorAll('a[aria-label$="view submissions"]'));
    expect(linked).toHaveLength(3);
    for (const a of linked) {
      const def = STAT_CARDS.find((d) => a.getAttribute('aria-label')!.startsWith(d.label))!;
      const list = await pageOfHeads<{ id: string }, ChainLink>({
        heads: HEADS,
        readRows: async (ids) => ({ data: ids.map((id) => ({ id })), error: null }),
        status: statusOf(a.getAttribute('href')!) === 'all' ? null : statusOf(a.getAttribute('href')!),
        page: 1,
        pageSize: 1000,
      });
      const shown = list.rows.map((r) => r.id).sort();
      expect(shown).toEqual(cardDealIds(HEADS, def).sort());
      expect(a.getAttribute('aria-label')).toBe(`${def.label}: ${shown.length}, view submissions`);
    }
  });

  it('why Pending is unlinked: the nearest filter selects a different set', () => {
    const pending = cardDealIds(HEADS, STAT_CARDS.find((d) => d.key === 'pending')!).sort();
    const viaSubmittedFilter = HEADS.filter((h) => headMatchesFilter(h.status, 'submitted')).map((h) => h.id).sort();
    const viaUnderReview = HEADS.filter((h) => headMatchesFilter(h.status, 'under_review')).map((h) => h.id).sort();
    expect(viaSubmittedFilter).toEqual(['c2-v2', 's1', 's2']);
    expect(viaSubmittedFilter).not.toEqual(pending);
    expect(viaUnderReview).not.toEqual(pending);
    expect(pending).toEqual(['s1', 's2', 'u1']);
  });

  it('hrefs carry no agent, search or page: a link cannot widen or narrow scope', async () => {
    const { container } = await renderDashboard();
    for (const a of Array.from(container.querySelectorAll('a[aria-label$="view submissions"]'))) {
      const keys = Array.from(new URL(a.getAttribute('href')!, 'http://x').searchParams.keys());
      expect(keys.filter((k) => k !== 'status')).toEqual([]);
    }
  });
});

describe('card markup', () => {
  const cards = buildStatCards(HEADS);
  const icons = { pending: <i />, needs_changes: <i />, approved: <i />, total: <i /> };

  it('is a 2x2 grid below md and 2 / 4 columns from md / lg, unchanged gaps', () => {
    const { container } = render(<DashboardStatCards cards={cards} icons={icons} />);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className.split(' ')).toEqual(
      expect.arrayContaining(['grid', 'grid-cols-2', 'gap-3', 'md:gap-4', 'lg:grid-cols-4'])
    );
    expect(grid.className).not.toContain('grid-cols-1');
  });

  it('links have a 44px target, a focus ring, and hover only under (hover: hover)', () => {
    render(<DashboardStatCards cards={cards} icons={icons} />);
    for (const a of screen.getAllByRole('link')) {
      const cls = a.className.split(/\s+/);
      expect(cls).toContain('min-h-[44px]');
      expect(cls).toContain('focus-visible:ring-2');
      expect(cls.filter((c) => c.startsWith('hover:'))).toEqual([]);
      expect(cls.some((c) => c.startsWith('[@media(hover:hover)]:hover:'))).toBe(true);
    }
  });

  it('starts the navigation bar on a plain tap, not on a new-tab click', () => {
    render(<DashboardStatCards cards={cards} icons={icons} />);
    const link = screen.getByRole('link', { name: /^Approved/ });
    // React handles clicks at the root; stopping default there keeps jsdom from navigating.
    document.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link, { metaKey: true });
    expect(mockStartProgress).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(mockStartProgress).toHaveBeenCalledTimes(1);
  });
});
