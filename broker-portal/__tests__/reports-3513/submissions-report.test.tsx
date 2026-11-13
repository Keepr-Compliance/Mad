/**
 * Submissions report: the loader and the page — BACKLOG-3513 PR-3a.
 *
 * The REAL loader (lib/reports/datasets/submissions.ts) and the REAL page run.
 * Mocked: the gate's answer (requireReportAccess), the session client's rpc and
 * users read, the browser client, and next/navigation.
 *
 * Fixture shapes are transcribed from migration 20261112200000:
 *  - broker_report_submissions_rows RETURNS TABLE (id, submitted_by,
 *    property_address, property_city, property_state, transaction_type, status,
 *    listing_price, sale_price, created_at, closed_at, total_count);
 *  - broker_report_scope returns jsonb {level, row_scope, service_off,
 *    effective_scope}; with p_def NULL, level and row_scope are null.
 * Ids and names are invented.
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { SUBMISSIONS_REPORT } from '@/lib/reports/registry';
import type { ReportCaller } from '@/lib/reports/report-gate';
import { SERVICE_OFF_LINE } from '@/lib/reports/datasets/submissions-filters';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = '00000000-0000-4000-8000-000000351301'; // pii-allow-uuid: invented fixture id
const OTHER_ORG = '00000000-0000-4000-8000-000000351309'; // pii-allow-uuid: invented fixture id
const BROKER = '00000000-0000-4000-8000-000000351302'; // pii-allow-uuid: invented fixture id
const AGENT_A = '00000000-0000-4000-8000-000000351303'; // pii-allow-uuid: invented fixture id
const AGENT_B = '00000000-0000-4000-8000-000000351304'; // pii-allow-uuid: invented fixture id

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
const mockFromTables: string[] = [];
const mockGrant = jest.fn();

const NAMES: Record<string, string> = { [AGENT_A]: 'Agent Alpha', [AGENT_B]: 'Agent Bravo' };

function supabase() {
  return {
    rpc: mockRpc,
    from: (table: string) => {
      mockFromTables.push(table);
      return {
        select: () => ({
          in: async (_c: string, ids: string[]) => ({
            data:
              table === 'users'
                ? ids.filter((id) => NAMES[id]).map((id) => ({ id, display_name: NAMES[id], first_name: null, last_name: null, email: null }))
                : [],
            error: null,
          }),
        }),
      };
    },
  };
}

jest.mock('@/lib/reports/report-gate', () => ({
  requireReportAccess: (...args: unknown[]) => mockGrant(...args),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc: async () => ({ data: [], error: null }) }),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/dashboard/reports/submissions',
  useSearchParams: () => new URLSearchParams(),
}));

import SubmissionsReportPage from '@/app/dashboard/reports/submissions/page';
import { loadSubmissionsReport } from '@/lib/reports/datasets/submissions';
import { DEFAULT_SUBMISSIONS_FILTERS } from '@/lib/reports/datasets/submissions-filters';

function caller(kind: 'full' | 'agent', userId = kind === 'full' ? BROKER : AGENT_A): ReportCaller {
  return {
    supabase: supabase() as unknown as ReportCaller['supabase'],
    userId,
    organizationId: ORG,
    role: kind === 'full' ? 'broker' : 'agent',
    kind,
  };
}

function row(n: number, submittedBy: string, total: number) {
  return {
    id: `00000000-0000-4000-8000-0000003513${String(n).padStart(2, '0')}`, // pii-allow-uuid: invented fixture id
    submitted_by: submittedBy,
    property_address: `${n} Birch Lane`,
    property_city: 'Springfield',
    property_state: 'IL',
    transaction_type: 'purchase',
    status: 'submitted',
    listing_price: 100000 + n,
    sale_price: null,
    created_at: '2026-11-01T12:00:00Z',
    closed_at: null,
    total_count: total,
  };
}

interface World {
  serviceOff?: boolean;
  /** Every deal in scope, in order; the fake pages through it like the row function. */
  deals?: ReturnType<typeof row>[];
  rowsError?: boolean;
  scopeError?: boolean;
}

function given(world: World) {
  const deals = world.deals ?? [];
  mockRpc.mockImplementation(async (name, args) => {
    if (name === 'broker_report_scope') {
      return world.scopeError
        ? { data: null, error: { message: 'fixture: scope failed' } }
        : {
            data: { level: null, row_scope: null, service_off: world.serviceOff ?? false, effective_scope: world.serviceOff ? 'own' : 'all' },
            error: null,
          };
    }
    if (name === 'broker_report_submissions_rows') {
      if (world.rowsError) return { data: null, error: { message: 'fixture: rows failed' } };
      const matching = deals.filter((d) => !args.p_agent || d.submitted_by === args.p_agent);
      const page = matching
        .slice(Number(args.p_offset), Number(args.p_offset) + Number(args.p_limit))
        .map((d) => ({ ...d, total_count: matching.length }));
      return { data: page, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

const rowCalls = () => mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows').map(([, a]) => a);

async function renderPage(kind: 'full' | 'agent', params: Record<string, string> = {}) {
  const c = caller(kind);
  mockGrant.mockResolvedValue({ caller: c, report: SUBMISSIONS_REPORT, scope: kind === 'full' ? 'all' : 'own' });
  const el = await SubmissionsReportPage({ searchParams: Promise.resolve(params) });
  return render(el);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFromTables.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loader: rows only through the row function, for the gate-admitted organization', () => {
  it('asks the row function for the caller org, the code report (p_def null) and the parsed filters', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    const data = await loadSubmissionsReport(caller('full'), {
      ...DEFAULT_SUBMISSIONS_FILTERS,
      status: 'pending',
      from: '2026-11-01',
      to: '2026-11-03',
      sort: 'price_desc',
    });
    expect(data.ok).toBe(true);
    expect(rowCalls()[0]).toEqual({
      p_org: ORG,
      p_def: null,
      p_status: 'pending',
      p_agent: null,
      p_from: '2026-11-01T00:00:00Z',
      p_to: '2026-11-04T00:00:00.000Z',
      p_sort: 'price_desc',
      p_limit: 25,
      p_offset: 0,
    });
    expect(mockRpc).toHaveBeenCalledWith('broker_report_scope', { p_org: ORG, p_def: null });
    expect(mockFromTables).not.toContain('transaction_submissions');
    expect(mockFromTables.every((t) => t === 'users')).toBe(true);
  });

  it("status 'all' is sent as null (no filter)", async () => {
    given({ deals: [] });
    await loadSubmissionsReport(caller('full'), DEFAULT_SUBMISSIONS_FILTERS);
    expect(rowCalls()[0].p_status).toBeNull();
  });

  it("V1: the count is the row function's total_count, not the rows on this page", async () => {
    const deals = Array.from({ length: 57 }, (_, i) => row(i + 1, AGENT_A, 0));
    given({ deals });
    const data = await loadSubmissionsReport(caller('full'), DEFAULT_SUBMISSIONS_FILTERS);
    if (!data.ok) throw new Error('expected ok');
    expect(data.rows).toHaveLength(25);
    expect(data.total).toBe(57);
    expect(data.totalPages).toBe(3);
  });

  it('a page past the end shows the last page with the real total', async () => {
    given({ deals: Array.from({ length: 30 }, (_, i) => row(i + 1, AGENT_A, 0)) });
    const data = await loadSubmissionsReport(caller('full'), { ...DEFAULT_SUBMISSIONS_FILTERS, page: 9 });
    if (!data.ok) throw new Error('expected ok');
    expect(data.page).toBe(2);
    expect(data.total).toBe(30);
    expect(data.rows).toHaveLength(5);
  });

  it.each([
    ['rows', { rowsError: true }],
    ['scope', { scopeError: true }],
  ])('a failed %s read is an error, never an empty report', async (_n, w) => {
    given({ deals: [row(1, AGENT_A, 0)], ...w });
    expect(await loadSubmissionsReport(caller('full'), DEFAULT_SUBMISSIONS_FILTERS)).toEqual({ ok: false });
  });

  it('a full role gets the agents in scope, named from users', async () => {
    given({ deals: [row(1, AGENT_A, 0), row(2, AGENT_B, 0)] });
    const data = await loadSubmissionsReport(caller('full'), DEFAULT_SUBMISSIONS_FILTERS);
    if (!data.ok) throw new Error('expected ok');
    expect(data.agents).toEqual([
      { id: AGENT_A, label: 'Agent Alpha' },
      { id: AGENT_B, label: 'Agent Bravo' },
    ]);
  });

  it('N2: an agent caller with an agent filter in the URL sends no agent filter', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await loadSubmissionsReport(caller('agent'), { ...DEFAULT_SUBMISSIONS_FILTERS, agent: AGENT_B, page: 3 });
    expect(rowCalls().length).toBeGreaterThan(0);
    for (const args of rowCalls()) expect(args.p_agent).toBeNull();
  });

  it('N2: a full role keeps the agent filter (positive control)', async () => {
    given({ deals: [row(1, AGENT_A, 0), row(2, AGENT_B, 0)] });
    await loadSubmissionsReport(caller('full'), { ...DEFAULT_SUBMISSIONS_FILTERS, agent: AGENT_B });
    expect(rowCalls()[0].p_agent).toBe(AGENT_B);
  });

  it('N3: the agent options follow the status and date filters, not the agent filter', async () => {
    given({ deals: [row(1, AGENT_A, 0), row(2, AGENT_B, 0)] });
    await loadSubmissionsReport(caller('full'), {
      ...DEFAULT_SUBMISSIONS_FILTERS,
      status: 'approved',
      agent: AGENT_A,
      from: '2026-11-01',
      to: '2026-11-03',
    });
    const optionCalls = rowCalls().filter((a) => a.p_limit === 200);
    expect(optionCalls.length).toBeGreaterThan(0);
    for (const args of optionCalls) {
      expect(args).toMatchObject({ p_status: 'approved', p_agent: null, p_from: '2026-11-01T00:00:00Z' });
      expect(args.p_to).toBe('2026-11-04T00:00:00.000Z');
    }
  });

  it('an agent gets no agent list and no name lookup', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    const data = await loadSubmissionsReport(caller('agent'), DEFAULT_SUBMISSIONS_FILTERS);
    if (!data.ok) throw new Error('expected ok');
    expect(data.agents).toEqual([]);
    expect(data.names).toBeNull();
    expect(mockFromTables).toEqual([]);
    expect(rowCalls()).toHaveLength(1);
  });
});

describe('page', () => {
  it('PR-3c: the page has a Back link to the Reports index', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await renderPage('full');
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/dashboard/reports');
  });

  it('PR-3c (founder ruling A): no personal saved-views panel on the Submissions report', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await renderPage('full');
    expect(document.querySelector('[data-slot="saved-views"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Views/ })).toBeNull();
  });

  it('B3: the service-off line shows when broker_report_scope says service_off', async () => {
    given({ serviceOff: true, deals: [row(1, BROKER, 0)] });
    await renderPage('full');
    expect(screen.getByTestId('report-service-off')).toHaveTextContent(SERVICE_OFF_LINE);
  });

  it('B3: no service-off line when the service is on (pair control)', async () => {
    given({ serviceOff: false, deals: [row(1, AGENT_A, 0)] });
    await renderPage('full');
    expect(screen.queryByTestId('report-service-off')).toBeNull();
    expect(screen.queryByText(SERVICE_OFF_LINE)).toBeNull();
  });

  it('B3: an agent in a canceled brokerage sees the line too', async () => {
    given({ serviceOff: true, deals: [row(1, AGENT_A, 0)] });
    await renderPage('agent');
    expect(screen.getByTestId('report-service-off')).toHaveTextContent(SERVICE_OFF_LINE);
  });

  it('shows the total deal count and one table row per returned deal', async () => {
    given({ deals: Array.from({ length: 40 }, (_, i) => row(i + 1, AGENT_A, 0)) });
    await renderPage('full');
    expect(screen.getByTestId('submissions-report-count')).toHaveTextContent('40 deals');
    expect(screen.getAllByTestId('submissions-report-row')).toHaveLength(25);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('ignores an organization in the URL: the gate-admitted organization is the one read', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await renderPage('full', { org: OTHER_ORG, p_org: OTHER_ORG } as Record<string, string>);
    for (const args of rowCalls()) expect(args.p_org).toBe(ORG);
  });

  it('a full role sees the Agent column and filter, with names', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await renderPage('full');
    const table = screen.getByTestId('submissions-report-table');
    expect(within(table).getByText('Agent')).toBeInTheDocument();
    expect(within(table).getByText('Agent Alpha')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toBeInTheDocument();
  });

  it('an agent sees no Agent column and no agent filter, and rows link to My Transactions', async () => {
    given({ deals: [row(1, AGENT_A, 0)] });
    await renderPage('agent');
    const table = screen.getByTestId('submissions-report-table');
    expect(within(table).queryByText('Agent')).toBeNull();
    expect(screen.queryByLabelText('Agent')).toBeNull();
    expect(within(table).getByRole('link')).toHaveAttribute('href', expect.stringMatching(/^\/dashboard\/my-transactions\//));
  });

  it('a failed read says the report could not load, not "no submissions"', async () => {
    given({ rowsError: true });
    await renderPage('full');
    expect(screen.getByTestId('submissions-report-error')).toBeInTheDocument();
    expect(screen.queryByTestId('submissions-report-empty')).toBeNull();
  });

  it('an empty result says no submissions match', async () => {
    given({ deals: [] });
    await renderPage('full');
    expect(screen.getByTestId('submissions-report-empty')).toBeInTheDocument();
    expect(screen.getByTestId('submissions-report-count')).toHaveTextContent('0 deals');
  });

  it('reads the URL filters through the parser (unknown values fall back)', async () => {
    given({ deals: [] });
    await renderPage('full', { status: 'approved', sort: 'address', agent: 'not-a-uuid', from: '2026-02-30' });
    expect(rowCalls()[0]).toMatchObject({ p_status: 'approved', p_sort: 'newest', p_agent: null, p_from: null });
  });
});
