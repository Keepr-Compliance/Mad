/**
 * Broker Submissions sort - BACKLOG-3904.
 *
 * One transcribed fixture (row SHAPE from __tests__/helpers/submissionRows.ts,
 * which was read off production; addresses in the stored form
 * "<n> <street>, <city>, <ST> <zip>, USA"; every value invented) drives:
 *   - the comparator for every option (ties, missing price, mixed statuses),
 *   - sort-before-pagination, through pageOfHeads and through the real page,
 *   - the phone sort control (sheet, URL, highlight) and Users unchanged.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';
import { pageOfHeads, selectDealHeads, type BrokerChainLink } from '@/lib/submissions/dealList';
import { compareHeads, headPrice, parseSortParam, SORT_OPTIONS, type SortKey } from '@/lib/submissions/listSort';
import { buildListUrl } from '@/lib/submissions/listUrl';

const mockEmulator = createPostgrestEmulator();
const mockPush = jest.fn();
const mockReplace = jest.fn();

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
  useRouter: () => ({ push: mockPush, replace: mockReplace, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsPage from '@/app/dashboard/submissions/page';
import { SubmissionPhoneFilters } from '@/components/submission/SubmissionFilters';

const ORG = FIXTURE_BROKERAGE_ORG_ID;
const AGENT = '00000000-0000-4000-8000-0000003904c1'; // pii-allow-uuid: invented fixture id
const id = (n: number) => `00000000-0000-4000-8000-00000039040${n}`; // pii-allow-uuid: invented fixture ids

interface Spec {
  n: number;
  status: string;
  created: string;
  address: string;
  sale: number | null;
  listing: number | null;
}

// h1/h4 tie on price (700000) and on street; h2 shows its listing price; h5's
// sale_price is 0 so the row shows listing_price (as the page does); h3/h6 have none.
const SPECS: Spec[] = [
  { n: 1, status: 'submitted', created: '2026-09-03T00:00:00Z', address: '112 Maple Grove Road, Fixture City, CA 90000, USA', sale: 700000, listing: 710000 },
  { n: 2, status: 'resubmitted', created: '2026-09-01T00:00:00Z', address: '9 Alder Court, Fixture City, CA 90000, USA', sale: null, listing: 650000 },
  { n: 3, status: 'under_review', created: '2026-09-02T00:00:00Z', address: '45 birch Lane, Fixture City, CA 90000, USA', sale: null, listing: null },
  { n: 4, status: 'needs_changes', created: '2026-09-05T00:00:00Z', address: '112 Maple Grove Road, Fixture City, CA 90000, USA', sale: 700000, listing: null },
  { n: 5, status: 'approved', created: '2026-09-04T00:00:00Z', address: '300 Zephyr Way, Fixture City, CA 90000, USA', sale: 0, listing: 300000 },
  { n: 6, status: 'rejected', created: '2026-08-30T00:00:00Z', address: 'Zed Plaza, Fixture City, CA 90000, USA', sale: null, listing: null },
  { n: 7, status: 'submitted', created: '2026-08-31T00:00:00Z', address: '20 Cedar Court, Fixture City, CA 90000, USA', sale: null, listing: 500000 },
];

function row(s: Spec): Row {
  return {
    ...submissionRow({ id: id(s.n), organizationId: ORG, submittedBy: AGENT, status: s.status, address: s.address, createdAt: s.created }),
    sale_price: s.sale,
    listing_price: s.listing,
  };
}

const HEADS = selectDealHeads(SPECS.map(row) as unknown as BrokerChainLink[]);
const order = (sort: SortKey) => [...HEADS].sort(compareHeads(sort)).map((h) => Number(h.id.slice(-1)));

describe('comparator, every option, one fixture', () => {
  it('newest first (default)', () => expect(order('newest')).toEqual([4, 5, 1, 3, 2, 7, 6]));
  it('oldest first', () => expect(order('oldest')).toEqual([6, 7, 2, 3, 1, 5, 4]));
  it('waiting longest: waiting states oldest first, then the rest newest first', () =>
    expect(order('waiting')).toEqual([7, 2, 3, 1, 4, 5, 6]));
  it('status in pipeline order, newest first within a status', () =>
    expect(order('status')).toEqual([1, 7, 2, 3, 4, 5, 6]));
  it('price high to low: ties newest first, no price last', () =>
    expect(order('price_desc')).toEqual([4, 1, 2, 7, 5, 3, 6]));
  it('price low to high: ties newest first, no price still last', () =>
    expect(order('price_asc')).toEqual([5, 7, 2, 4, 1, 3, 6]));
  it('address A-Z: street line, case-insensitive, numbers as numbers, ties newest first', () =>
    expect(order('address')).toEqual([2, 7, 3, 4, 1, 5, 6]));

  it('price is the one the row shows (sale_price, else listing_price)', () => {
    const p = (n: number) => headPrice(HEADS.find((h) => h.id === id(n))!);
    expect([p(1), p(2), p(3), p(5)]).toEqual([700000, 650000, null, 300000]);
  });

  it('an unknown or repeated sort falls back to the default', () => {
    expect(parseSortParam('bogus')).toBe('newest');
    expect(parseSortParam('')).toBe('newest');
    expect(parseSortParam(undefined)).toBe('newest');
    expect(parseSortParam(['oldest', 'status'] as unknown as string)).toBe('newest');
    expect(parseSortParam('oldest')).toBe('oldest');
  });
});

describe('sort happens before pagination', () => {
  // 30 deals: price rises with n, created_at rises as n falls, so every sort puts a different deal first.
  const many: Row[] = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    return {
      ...submissionRow({
        id: `00000000-0000-4000-8000-0000003904${String(n).padStart(2, '0')}`, // pii-allow-uuid: invented fixture ids
        organizationId: ORG,
        submittedBy: AGENT,
        status: 'approved',
        address: `${n} Sorted Street, Fixture City, CA 90000, USA`,
        createdAt: `2026-09-${String(31 - n).padStart(2, '0')}T00:00:00Z`,
      }),
      sale_price: n * 1000,
      listing_price: null,
    };
  });
  const manyId = (n: number) => `00000000-0000-4000-8000-0000003904${String(n).padStart(2, '0')}`; // pii-allow-uuid: invented

  it('pageOfHeads: page 2 of price_desc is deals 5..1 (the whole list was sorted first)', async () => {
    const heads = selectDealHeads(many as unknown as BrokerChainLink[]);
    const res = await pageOfHeads<{ id: string }, BrokerChainLink>({
      heads,
      readRows: async (ids) => ({ data: many.filter((r) => ids.includes(r.id as string)), error: null }),
      status: null,
      compare: compareHeads('price_desc'),
      page: 2,
      pageSize: 25,
    });
    expect(res.rows.map((r) => r.id)).toEqual([5, 4, 3, 2, 1].map(manyId));
    expect(res.total).toBe(30);
  });

  it('the page: ?sort=price_desc&page=2 lists deals 5..1', async () => {
    mockEmulator.reset();
    mockEmulator.set({ rows: { transaction_submissions: many, users: [] } });
    const { container } = render(
      await SubmissionsPage({ searchParams: Promise.resolve({ sort: 'price_desc', page: '2' }) })
    );
    const ids = Array.from(container.querySelectorAll('tbody a[href^="/dashboard/submissions/"]')).map(
      (a) => (a.getAttribute('href') as string).split('/').pop()
    );
    expect(ids).toEqual([5, 4, 3, 2, 1].map(manyId));
    cleanup();
  });
});

describe('URL', () => {
  const base = { status: 'all', agent: null, search: '' };
  it('omits the default and keeps every other sort', () => {
    expect(buildListUrl({ ...base, sort: 'newest' })).toBe('/dashboard/submissions');
    expect(buildListUrl(base)).toBe('/dashboard/submissions');
    expect(buildListUrl({ ...base, sort: 'price_asc' })).toBe('/dashboard/submissions?sort=price_asc');
  });
  it('pagination and filters carry the sort', () => {
    expect(buildListUrl({ status: 'approved', agent: null, search: 'oak', sort: 'waiting' }, 2)).toBe(
      '/dashboard/submissions?status=approved&search=oak&sort=waiting&page=2'
    );
  });
});

describe('phone sort control', () => {
  const props = {
    statuses: [{ value: 'all', label: 'All' }],
    agents: [],
    facets: [],
    selectedAgentLabel: 'All agents',
    matchingCount: 3,
    scopeTotal: 3,
  };
  const renderPhone = (sort?: SortKey, status = 'all') =>
    render(<SubmissionPhoneFilters {...props} filters={{ status, agent: null, search: '', sort }} />);

  beforeEach(() => {
    mockPush.mockClear();
    cleanup();
  });

  it('sits third on the filter row, named for the current option', () => {
    renderPhone();
    const bar = document.querySelector('[data-slot=phone-filter-bar]') as HTMLElement;
    const sort = within(bar).getByRole('button', { name: 'Sort: Newest first' });
    const status = within(bar).getByRole('button', { name: 'Status: All' });
    expect(sort.parentElement).toBe(status.parentElement);
    expect(sort.parentElement!.lastElementChild).toBe(sort);
  });

  it('is highlighted only when the sort is not the default', () => {
    const { unmount } = renderPhone();
    expect(screen.getByRole('button', { name: 'Sort: Newest first' })).not.toHaveAttribute('data-active');
    unmount();
    renderPhone('newest');
    expect(screen.getByRole('button', { name: 'Sort: Newest first' })).not.toHaveAttribute('data-active');
    cleanup();
    renderPhone('waiting');
    expect(screen.getByRole('button', { name: 'Sort: Waiting longest' })).toHaveAttribute('data-active', 'true');
  });

  it('the sheet lists the 7 options; choosing one writes the URL and closes the sheet', () => {
    renderPhone(undefined, 'approved');
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Newest first' }));
    const dialog = screen.getByRole('dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(SORT_OPTIONS.map((o) => o.label));
    expect(radios).toHaveLength(7);
    expect(within(dialog).getByRole('radio', { name: 'Newest first' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Price high to low' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/submissions?status=approved&sort=price_desc');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('choosing the default removes sort from the URL', () => {
    renderPhone('oldest');
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Oldest first' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: 'Newest first' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/submissions');
  });
});
