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
let mockNoAccessOrgs: string[] = [];
/** BACKLOG-3906: orgs whose feature read fails (getOrgFeatures' fallback, feature-gate.ts failOpenDefault). */
let mockFeatureReadFails: string[] = [];

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
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
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
      mockFeatureReadFails.includes(orgId)
        ? { org_id: orgId, plan_name: 'unknown', plan_tier: 'unknown', features: {} }
        : withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', !mockNoAccessOrgs.includes(orgId))
    ),
  };
});

import DashboardPage from '@/app/dashboard/page';
import SubmissionsPage from '@/app/dashboard/submissions/page';
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

// A second org WITHOUT broker_portal_access, holding a deal in each card status.
// Neither the cards nor the list may count or show it (the org gate).
// Row shape = row() above; org id and addresses invented.
const ORG_NO_ACCESS = '00000000-0000-4000-8000-0000003904b2'; // pii-allow-uuid: invented fixture id
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
];
const LINKS = ROWS as unknown as ChainLink[];
const HEADS = selectDealHeads(LINKS.filter((l) => l.status !== 'uploading'));

function statusOf(href: string): string {
  return new URL(href, 'http://x').searchParams.get('status') ?? 'all';
}

/** Submission ids linked from the Recent Submissions card (detail links only, not the card hrefs). */
function recentIds(container: HTMLElement): string[] {
  return Array.from(new Set(Array.from(container.querySelectorAll('a[href^="/dashboard/submissions/"]')).map(
    (a) => (a.getAttribute('href') as string).split('/').pop() as string
  ))).sort();
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
  mockEmulator.set({ rows: { transaction_submissions: [...ROWS, ...OUTSIDE_ROWS] } });
  return render(await DashboardPage());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNoAccessOrgs = [ORG_NO_ACCESS];
  mockFeatureReadFails = [];
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
  it('BACKLOG-3906: a failed feature read for any org counts nothing', async () => {
    mockFeatureReadFails = [ORG];
    await renderDashboard();
    const labels = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('aria-label'))
      .filter((l): l is string => !!l && l.endsWith('view submissions'));
    expect(labels).toHaveLength(4);
    for (const l of labels) expect(l).toMatch(/: 0, view submissions$/);
  });

  it('BACKLOG-3906: Recent Submissions lists only orgs with portal access (the no-access org holds the newest rows)', async () => {
    const { container } = await renderDashboard();
    const ids = recentIds(container);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).not.toMatch(/^x-/);
  });

  it('BACKLOG-3906: Recent Submissions lists nothing when an org\'s feature read fails', async () => {
    mockFeatureReadFails = [ORG];
    const { container } = await renderDashboard();
    expect(recentIds(container)).toEqual([]);
    expect(screen.getByText('No submissions yet')).toBeInTheDocument();
  });

  it('shows the deal counts and the hrefs', async () => {
    await renderDashboard();
    const hrefs = Object.fromEntries(
      screen.getAllByRole('link').map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')])
    );
    expect(hrefs['New: 2, view submissions']).toBe('/dashboard/submissions?status=new');
    expect(hrefs['Resubmitted: 1, view submissions']).toBe('/dashboard/submissions?status=resubmitted');
    expect(hrefs['Under Review: 1, view submissions']).toBe('/dashboard/submissions?status=under_review');
    expect(hrefs['Needs Changes: 2, view submissions']).toBe('/dashboard/submissions?status=needs_changes');
  });

  it('every linked card opens exactly the deals its number counts (ID sets, not counts)', async () => {
    const { container } = await renderDashboard();
    const linked = Array.from(container.querySelectorAll('a[aria-label$="view submissions"]'));
    expect(linked).toHaveLength(4);
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

  it('each card: list set == card set as IDs, from the card key alone', () => {
    const expected: Record<string, string[]> = {
      new: ['s1', 's2'],
      resubmitted: ['c2-v2'],
      under_review: ['u1'],
      needs_changes: ['c1-v2', 'n1'],
    };
    for (const def of STAT_CARDS) {
      const viaList = HEADS.filter((h) => headMatchesFilter(h.status, def.filter!)).map((h) => h.id).sort();
      expect(cardDealIds(HEADS, def).sort()).toEqual(expected[def.key]);
      expect(viaList).toEqual(expected[def.key]);
    }
  });

  it('existing list values keep their meaning: submitted = submitted + resubmitted, pending still works', () => {
    const ids = (f: string) => HEADS.filter((h) => headMatchesFilter(h.status, f)).map((h) => h.id).sort();
    expect(ids('submitted')).toEqual(['c2-v2', 's1', 's2']);
    expect(ids('pending')).toEqual(['c2-v2', 's1', 's2', 'u1']);
    expect(ids('new')).not.toContain('c2-v2');
  });

  it('org gate: deals in an org without broker portal access are in no card and no linked list', async () => {
    const { container, unmount } = await renderDashboard();
    // Card values are the in-scope numbers only (2 / 1 / 1 / 2), not +1 each.
    const linked = Array.from(container.querySelectorAll('a[aria-label$="view submissions"]'));
    expect(linked.map((a) => a.getAttribute('aria-label'))).toEqual([
      'New: 2, view submissions',
      'Resubmitted: 1, view submissions',
      'Under Review: 1, view submissions',
      'Needs Changes: 2, view submissions',
    ]);
    const hrefs = linked.map((a) => a.getAttribute('href') as string);
    unmount();
    // Parity: the REAL Submissions page opened by each card lists the same deals.
    const outside = OUTSIDE_ROWS.map((r) => r.id as string);
    const expected: Record<string, string[]> = {
      new: ['s1', 's2'],
      resubmitted: ['c2-v2'],
      under_review: ['u1'],
      needs_changes: ['c1-v2', 'n1'],
    };
    for (const href of hrefs) {
      const status = statusOf(href);
      mockEmulator.reset();
      mockEmulator.set({ rows: { transaction_submissions: [...ROWS, ...OUTSIDE_ROWS], users: [] } });
      const page = render(await SubmissionsPage({ searchParams: Promise.resolve({ status }) }));
      const listed = Array.from(page.container.querySelectorAll('tbody a[href^="/dashboard/submissions/"]')).map(
        (a) => (a.getAttribute('href') as string).split('/').pop() as string
      );
      expect(listed.sort()).toEqual(expected[status]);
      for (const id of outside) expect(listed).not.toContain(id);
      page.unmount();
    }
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
  const icons = { new: <i />, resubmitted: <i />, under_review: <i />, needs_changes: <i /> };

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
    const link = screen.getByRole('link', { name: /^New/ });
    // React handles clicks at the root; stopping default there keeps jsdom from navigating.
    document.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link, { metaKey: true });
    expect(mockStartProgress).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(mockStartProgress).toHaveBeenCalledTimes(1);
  });
});

describe('compact phone card (below md)', () => {
  const cards = buildStatCards(HEADS);
  const icons = { new: <i data-icon />, resubmitted: <i data-icon />, under_review: <i data-icon />, needs_changes: <i data-icon /> };
  const WORDS: Record<string, string[]> = {
    New: ['New'],
    Resubmitted: ['Resubmitted'],
    'Under Review': ['Under', 'Review'],
    'Needs Changes': ['Needs', 'Changes'],
  };
  const cardBoxes = (c: HTMLElement) => Array.from(c.firstElementChild!.children) as HTMLElement[];
  const plain = (cls: string) => cls.split(/\s+/).filter((t) => !t.startsWith('max-md:'));

  it('splits each title into one block span per word, in a single label', () => {
    const { container } = render(<DashboardStatCards cards={cards} icons={icons} />);
    const labels = Array.from(container.querySelectorAll('[data-stat-label]'));
    expect(labels).toHaveLength(4);
    for (const label of labels) {
      const spans = Array.from(label.querySelectorAll('span'));
      expect(spans.map((s) => s.textContent)).toEqual(WORDS[label.textContent!]);
      for (const s of spans) expect(s.className.split(/\s+/)).toContain('max-md:block');
    }
  });

  it('is one row: icon left, title next, number pushed right and vertically centred', () => {
    const { container } = render(<DashboardStatCards cards={cards} icons={icons} />);
    for (const box of cardBoxes(container)) {
      const cls = box.className.split(/\s+/);
      expect(cls).not.toContain('max-md:flex-col');
      expect(cls).toContain('items-center');
      expect(cls).not.toContain('max-md:items-start');
      const [tile, text] = Array.from(box.children) as HTMLElement[];
      expect(tile.querySelector('[data-icon]')).not.toBeNull();
      expect(text.className.split(/\s+/)).toContain('max-md:contents');
      const value = text.querySelector('[data-stat-value]')!.parentElement!;
      expect(value.className.split(/\s+/)).toContain('max-md:ml-auto');
      expect(text.querySelector('[data-stat-label]')!.className.split(/\s+/)).toContain('max-md:flex-1');
    }
  });

  it('keeps the desktop (md and up) classes exactly as before', () => {
    // plain (unlinked) box: the link affordance classes are asserted separately
    const { container } = render(<DashboardStatCards cards={cards.map((c) => ({ ...c, href: null }))} icons={icons} />);
    const box = cardBoxes(container)[0];
    expect(plain(box.className)).toEqual(
      expect.arrayContaining(['bg-white', 'rounded-lg', 'border', 'border-gray-200', 'p-5', 'flex', 'items-center', 'gap-4'])
    );
    expect(plain(box.className)).toHaveLength(8);
    expect(plain((box.children[0] as HTMLElement).className)).toEqual(['rounded-lg', 'p-3', 'text-blue-600', 'bg-blue-50']);
    const text = box.children[1] as HTMLElement;
    expect(plain(text.className)).toEqual(['min-w-0']);
    expect(plain(text.querySelector('[data-stat-label]')!.className)).toEqual(['text-sm', 'font-medium', 'text-gray-500', 'truncate']);
    expect(plain(text.querySelector('[data-stat-value]')!.className)).toEqual(['text-2xl', 'font-semibold', 'text-gray-900']);
    expect(plain(text.querySelector('[data-stat-value]')!.parentElement!.className)).toEqual(['flex', 'items-baseline', 'gap-2']);
  });

  it('a card without an href is a plain box; linked cards keep the aria labels', () => {
    const plainCards = cards.map((c) => (c.key === 'needs_changes' ? { ...c, href: null } : c));
    const { container } = render(<DashboardStatCards cards={plainCards} icons={icons} />);
    expect(cardBoxes(container)[3].tagName).toBe('DIV');
    expect(cardBoxes(container)[0].tagName).toBe('A');
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual([
      ...plainCards.filter((c) => c.href).map((c) => `${c.label}: ${c.value}, view submissions`),
    ]);
  });
});
