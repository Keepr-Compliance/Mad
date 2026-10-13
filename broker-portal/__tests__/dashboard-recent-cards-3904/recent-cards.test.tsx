/**
 * BACKLOG-3904: the dashboard's Recent Submissions are the same phone cards as
 * the Submissions list - one shared SubmissionCard, no table look and no
 * wrapper frame on phones. Both REAL pages run against the PostgREST emulator.
 *
 * FIXTURE PROVENANCE: row shape = __tests__/helpers/submissionRows.ts (the
 * production columns); the users row copies the columns resolveUserIdentities
 * selects (id, display_name, first_name, last_name, email). Every id, name and
 * address is invented.
 */

import { render, screen, within } from '@testing-library/react';
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

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
jest.mock('@/lib/auth/portalAccess', () => {
  const actual = jest.requireActual('@/lib/auth/portalAccess');
  return { ...actual, requireFullPortalAccess: jest.fn(async () => ({ ok: true })) };
});
jest.mock('@/components/submission/SubmissionListClient', () => ({
  SubmissionListClient: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// A pass-through spy: records every render of the card, renders the real one.
jest.mock('@/components/submission/SubmissionCard', () => {
  const actual = jest.requireActual('@/components/submission/SubmissionCard');
  return { ...actual, SubmissionCard: jest.fn(actual.SubmissionCard) };
});

import DashboardPage from '@/app/dashboard/page';
import SubmissionsPage from '@/app/dashboard/submissions/page';
import { SubmissionCard } from '@/components/submission/SubmissionCard';

const spy = SubmissionCard as unknown as jest.Mock;
const ORG = FIXTURE_BROKERAGE_ORG_ID;

const ADDRESSES = [
  '11 Example Rd, Fixture City, CA 90000, USA',
  '22 Sample Ave, Unit 2, Fixture City, CA 90000, USA',
  '33 Invented Ln, Fixture City, CA 90000, USA',
  '44 Fictional St, Fixture City, CA 90000, USA',
  '55 Mock Ct, Fixture City, CA 90000, USA',
  '66 Placeholder Dr, Fixture City, CA 90000, USA',
];
const ROWS: Row[] = ADDRESSES.map((address, i) => ({
  ...submissionRow({
    id: `r${i + 1}`,
    organizationId: ORG,
    submittedBy: FIXTURE_USER_ID,
    status: i % 2 ? 'approved' : 'submitted',
    parentSubmissionId: null,
    createdAt: `2026-09-0${i + 1}T00:00:00Z`,
    address,
  }),
  version: 1,
}));
const USERS: Row[] = [
  { id: FIXTURE_USER_ID, display_name: 'fixture-agent', first_name: null, last_name: null, email: 'agent@fixture.example.test' },
];

function arrange(rows: Row[] = ROWS) {
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
  // The emulator does not apply .order(); the recent query asks created_at DESC (asserted
  // below from the recorded call), so the fixture is stored newest first.
  mockEmulator.set({ rows: { transaction_submissions: [...rows].reverse(), users: USERS } });
}

const dashboardCards = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-slot=submission-cards] [data-slot=submission-card]')) as HTMLElement[];

beforeEach(() => {
  jest.clearAllMocks();
  arrange();
});

describe('Recent Submissions on the dashboard (phone cards)', () => {
  it('renders one card per recent row (5 of 6, newest first), each linking to its submission', async () => {
    const { container } = render(await DashboardPage());
    const cards = dashboardCards(container);
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.getAttribute('href'))).toEqual(['r6', 'r5', 'r4', 'r3', 'r2'].map((id) => `/dashboard/submissions/${id}`));
    expect(spy).toHaveBeenCalledTimes(5);
    expect(mockEmulator.state.orders.some((o) => o.table === 'transaction_submissions' && o.column === 'created_at' && JSON.stringify(o.options) === JSON.stringify({ ascending: false }))).toBe(true);
  });

  it('the cards carry street, city line, status, agent - type - date', async () => {
    const { container } = render(await DashboardPage());
    const first = dashboardCards(container)[0];
    expect(first.textContent).toContain('66 Placeholder Dr');
    expect(first.textContent).toContain('Fixture City, CA 90000');
    expect(first.textContent).toContain('fixture-agent');
    expect(first.textContent).toMatch(/fixture-agent · .+ · .+/);
    expect(first.textContent).toContain('Approved');
  });

  it('keeps the Recent Submissions header and View all, and drops the frame below md', async () => {
    const { container } = render(await DashboardPage());
    expect(screen.getByText('Recent Submissions')).toBeInTheDocument();
    const viewAll = screen.getByRole('link', { name: 'View all' });
    expect(viewAll).toHaveAttribute('href', '/dashboard/submissions');
    const frame = container.querySelector('[data-slot=submission-cards]')!.parentElement as HTMLElement;
    for (const c of ['max-md:border-0', 'max-md:bg-transparent', 'max-md:shadow-none', 'max-md:rounded-none']) {
      expect(frame.className.split(' ')).toContain(c);
    }
    // desktop list stays, phone-hidden
    const ul = container.querySelector('ul.divide-y') as HTMLElement;
    expect(ul.className.split(' ')).toContain('max-md:hidden');
    expect(container.querySelector('[data-slot=submission-cards]')!.className.split(' ')).toContain('md:hidden');
  });

  it('with no recent rows there are no cards and the framed empty state stays', async () => {
    arrange([]);
    const { container } = render(await DashboardPage());
    expect(dashboardCards(container)).toHaveLength(0);
    expect(screen.getByText('No submissions yet')).toBeInTheDocument();
    const frame = screen.getByText('No submissions yet').closest('.bg-white') as HTMLElement;
    expect(frame.className.split(' ')).not.toContain('max-md:border-0');
  });
});

describe('one component for both lists', () => {
  it('the dashboard and the Submissions page render the same SubmissionCard, with identical markup per row', async () => {
    const dash = render(await DashboardPage());
    const dashCalls = spy.mock.calls.length;
    const dashHtml = new Map(dashboardCards(dash.container).map((c) => [c.getAttribute('href'), c.outerHTML]));
    dash.unmount();

    spy.mockClear();
    const list = render(await SubmissionsPage({ searchParams: Promise.resolve({}) }));
    expect(dashCalls).toBe(5);
    expect(spy).toHaveBeenCalledTimes(6);
    const cards = Array.from(list.container.querySelectorAll('[data-slot=submission-cards] [data-slot=submission-card]'));
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      const mine = dashHtml.get(card.getAttribute('href'));
      if (mine) expect(card.outerHTML).toBe(mine);
    }
    expect(dashHtml.size).toBe(5);
  });

  it('a card is a focusable link with a ring, hovering only where a pointer can', async () => {
    const { container } = render(await DashboardPage());
    const cls = dashboardCards(container)[0].className;
    expect(cls).toMatch(/focus-visible:ring-2/);
    expect(cls).toContain('[@media(hover:hover)]:hover:bg-gray-50');
    expect(cls.split(' ')).not.toContain('hover:bg-gray-50');
    expect(within(container).getAllByRole('link', { name: /66 Placeholder Dr/ }).length).toBeGreaterThan(0);
  });
});
