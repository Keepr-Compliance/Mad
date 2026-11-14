/**
 * Shared report page, Save as report, Delete — BACKLOG-3513 PR-3b.
 * The index moved to reports-index.test.tsx in PR-3g.
 *
 * The REAL page (app/dashboard/reports/d/[id]/page.tsx), the REAL server reads
 * (lib/reports/definitions/server.ts) and the REAL loader run. Mocked: the gate's
 * caller (getReportsCaller / requireMyReports), the session client's rpc and the
 * organizations name read, the browser client, next/navigation.
 *
 * Reply shapes transcribed from migration 20261112200000: broker_report_def_get
 * {id, organization_id, dataset_key, name, description, definition, row_scope,
 * general_access, level, owner {name, is_you}, updated_at, reassign_available}
 * (reassign_available: 20261112220000); broker_report_orphans [{id, name,
 * dataset_key, owner_name, owner_state 'gone'|'deactivated', level}] (20261112210000);
 * broker_report_share_list
 * {owner {id, name, role, is_you}, ...} (owner.role NULL when the owner is not an
 * active member); broker_report_def_list [{id, name, dataset_key, level,
 * owner_name, updated_at}]; broker_report_scope {level, row_scope, service_off,
 * effective_scope}. Ids and names are invented.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import type { ReportCaller } from '@/lib/reports/report-gate';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = '00000000-0000-4000-8000-0000003513c0'; // pii-allow-uuid: invented fixture id
const OTHER_ORG = '00000000-0000-4000-8000-0000003513c9'; // pii-allow-uuid: invented fixture id
const DEF = '00000000-0000-4000-8000-0000003513CA'; // pii-allow-uuid: invented fixture id (upper case on purpose)
const ME = '00000000-0000-4000-8000-0000003513c3'; // pii-allow-uuid: invented fixture id

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
const mockClientRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>(async () => ({ data: [], error: null }));
const mockCaller = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@/lib/reports/report-gate', () => ({
  getReportsCaller: (...a: unknown[]) => mockCaller(...a),
}));
jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mockClientRpc }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: mockRefresh }),
  usePathname: () => '/dashboard/reports/d/x',
  useSearchParams: () => new URLSearchParams(),
}));

import SharedReportPage from '@/app/dashboard/reports/d/[id]/page';
import { SaveAsReport } from '@/components/reports/SaveAsReport';
import { DeleteReportButton } from '@/components/reports/ReportDefinitionActions';
import { canReassign } from '@/components/reports/ReassignReport';
import { resolveDefinitionFilters } from '@/lib/reports/datasets/submissions-filters';

type Level = 'owner' | 'editor' | 'viewer';

function caller(kind: 'full' | 'agent', role = kind === 'full' ? 'broker' : 'agent'): ReportCaller {
  return {
    supabase: {
      rpc: mockRpc,
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === 'organizations' ? { name: 'Maple Realty' } : null, error: null }),
          }),
          in: async () => ({ data: [], error: null }),
        }),
      }),
    } as unknown as ReportCaller['supabase'],
    userId: ME,
    organizationId: ORG,
    role,
    kind,
  };
}

interface World {
  level: Level;
  org?: string;
  getError?: boolean;
  /** def_get reassign_available (the database's reassign test for this caller). */
  reassign?: boolean;
  definition?: unknown;
}

function given(w: World) {
  mockRpc.mockImplementation(async (name, args) => {
    if (name === 'broker_report_def_get') {
      if (w.getError) return { data: null, error: { message: 'Report not found' } };
      return {
        data: {
          id: args.p_def,
          organization_id: w.org ?? ORG,
          dataset_key: 'submissions',
          name: 'Q4 deals',
          description: null,
          definition: w.definition ?? { filters: { status: 'approved' }, sort: null },
          row_scope: 'all',
          general_access: 'restricted',
          level: w.level,
          owner: { name: 'Avery Quinn', is_you: w.level === 'owner' },
          updated_at: '2026-11-12T10:00:00.123456+00:00',
          reassign_available: w.reassign === true,
        },
        error: null,
      };
    }
    // The page never reads share_list (owner state comes from def_get.reassign_available).
    if (name === 'broker_report_scope') return { data: { level: w.level, row_scope: 'all', service_off: false, effective_scope: 'all' }, error: null };
    if (name === 'broker_report_submissions_rows_multi') return { data: [], error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

async function renderPage(kind: 'full' | 'agent', w: World, search: Record<string, string> = {}, role?: string) {
  given(w);
  mockCaller.mockResolvedValue(caller(kind, role));
  const el = await SharedReportPage({ params: Promise.resolve({ id: DEF }), searchParams: Promise.resolve(search) });
  return render(el);
}

const q = {
  share: () => screen.queryByRole('button', { name: 'Share Q4 deals' }),
  update: () => screen.queryByRole('button', { name: 'Save changes' }),
  del: () => screen.queryByRole('button', { name: 'Delete' }),
  reassign: () => screen.queryByRole('button', { name: 'Reassign' }),
  takeOver: () => screen.queryByRole('button', { name: /take over/i }),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('who gets which action', () => {
  it('an agent viewer: no Share, no Save changes, no Delete', async () => {
    await renderPage('agent', { level: 'viewer' });
    expect(screen.getByRole('heading', { name: 'Q4 deals' })).toBeInTheDocument();
    expect(q.share()).toBeNull();
    expect(q.update()).toBeNull();
    expect(q.del()).toBeNull();
  });

  it('a broker viewer: no Share either', async () => {
    await renderPage('full', { level: 'viewer' });
    expect(q.share()).toBeNull();
    expect(q.del()).toBeNull();
  });

  it('an agent editor: Share and Save changes, no Delete (V5, Q5)', async () => {
    await renderPage('agent', { level: 'editor' });
    expect(q.share()).toBeInTheDocument();
    expect(q.update()).toBeInTheDocument();
    expect(q.del()).toBeNull();
  });

  it('a broker editor: Share, no Delete', async () => {
    await renderPage('full', { level: 'editor' });
    expect(q.share()).toBeInTheDocument();
    expect(q.del()).toBeNull();
  });

  it('the owner (an agent): Share, Save changes and Delete', async () => {
    await renderPage('agent', { level: 'owner' });
    expect(q.share()).toBeInTheDocument();
    expect(q.update()).toBeInTheDocument();
    expect(q.del()).toBeInTheDocument();
  });
});

describe('Reassign (founder ruling 2026-11-13: IT admin, or admin when the brokerage has no IT admin)', () => {
  it('reassign_available false: no Reassign, and never a Take over', async () => {
    await renderPage('full', { level: 'editor', reassign: false }, {}, 'it_admin');
    expect(q.reassign()).toBeNull();
    expect(screen.queryByTestId('report-reassign')).toBeNull();
    expect(q.takeOver()).toBeNull();
  });

  it.each([['it_admin'], ['admin']])('a %s VIEWER with reassign_available: Reassign, no Take over', async (role) => {
    await renderPage('full', { level: 'viewer', reassign: true }, {}, role);
    expect(screen.getByTestId('report-reassign')).toHaveTextContent('The owner of this report is no longer active.');
    expect(q.reassign()).toBeInTheDocument();
    expect(q.takeOver()).toBeNull();
    expect(q.share()).toBeNull();
  });

  it('an agent, even if the flag were set: no Reassign', async () => {
    await renderPage('agent', { level: 'editor', reassign: true });
    expect(q.reassign()).toBeNull();
  });

  it('the page never reads share_list for the owner state', async () => {
    await renderPage('full', { level: 'viewer', reassign: true }, {}, 'it_admin');
    expect(mockRpc.mock.calls.map(([n]) => n)).not.toContain('broker_report_share_list');
  });

  it('the rule itself', () => {
    expect(canReassign({ kind: 'full', reassignAvailable: true })).toBe(true);
    expect(canReassign({ kind: 'full', reassignAvailable: false })).toBe(false);
    expect(canReassign({ kind: 'agent', reassignAvailable: true })).toBe(false);
  });
});

describe('rows and filters', () => {
  it('PR-3c: the page has a Back link to the Reports index', async () => {
    await renderPage('agent', { level: 'viewer' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/dashboard/reports');
  });

  it('PR-3c (founder ruling A): no personal saved-views panel on a shared report', async () => {
    await renderPage('full', { level: 'owner' });
    expect(document.querySelector('[data-slot="saved-views"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Views/ })).toBeNull();
    expect(mockClientRpc.mock.calls.map(([n]) => n)).not.toContain('broker_report_list_views');
  });

  // The default definition is the 2.48 shape: {filters: {status: 'approved'}} (one string).
  // Mutation (run): the reader takes lists only -> red.
  it('U6 every request reads the definition, then rows with p_def = this report and its saved filters', async () => {
    await renderPage('full', { level: 'viewer' });
    const names = mockRpc.mock.calls.map(([n]) => n);
    expect(names[0]).toBe('broker_report_def_get');
    const rows = mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows_multi').map(([, a]) => a);
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) expect(a).toMatchObject({ p_org: ORG, p_def: DEF, p_statuses: ['approved'] });
    expect(mockRpc.mock.calls.find(([n]) => n === 'broker_report_scope')![1]).toEqual({ p_org: ORG, p_def: DEF });
  });

  it('filters the person changed on the page (status in the URL) win over the saved ones', async () => {
    await renderPage('full', { level: 'viewer' }, { status: 'all' });
    const rows = mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows_multi').map(([, a]) => a);
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) expect(a.p_statuses).toBeNull();
  });

  it('a definition saved with lists sends the lists', async () => {
    const agentA = '00000000-0000-4000-8000-0000003513c5'; // pii-allow-uuid: invented fixture id
    await renderPage('full', { level: 'viewer', definition: { filters: { status: ['approved', 'rejected'], agent: agentA }, sort: null } });
    const rows = mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows_multi').map(([, a]) => a);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ p_statuses: ['approved', 'rejected'], p_agents: [agentA] });
  });

  it('a page link alone keeps the saved filters', () => {
    expect(resolveDefinitionFilters({ page: '2' }, { filters: { status: 'approved' }, sort: { key: 'oldest' } })).toMatchObject({
      statuses: ['approved'],
      sort: 'oldest',
      page: 2,
    });
  });

});

describe('refusals are notFound', () => {
  it('the database refuses the definition', async () => {
    await expect(renderPage('full', { level: 'viewer', getError: true })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a definition from another organization', async () => {
    await expect(renderPage('full', { level: 'owner', org: OTHER_ORG })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('the report gate refuses', async () => {
    given({ level: 'owner' });
    mockCaller.mockResolvedValue(null);
    await expect(SharedReportPage({ params: Promise.resolve({ id: DEF }), searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('Save as report and Delete', () => {
  it('saves the current filters as a new report and opens it (agents too)', async () => {
    mockClientRpc.mockResolvedValueOnce({ data: DEF, error: null });
    render(<SaveAsReport orgId={ORG} current={{ filters: { status: 'approved' }, sort: null }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as report' }));
    // PR-3g C10: the dialog says the new report is private, and def_create gets no general-access argument.
    expect(await screen.findByRole('dialog', { name: 'Save as report' })).toHaveTextContent('Only you can see it until you share it.');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '  Q4 deals ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/dashboard/reports/d/${encodeURIComponent(DEF)}`));
    expect(mockClientRpc).toHaveBeenCalledWith('broker_report_def_create', {
      p_org: ORG,
      p_dataset: 'submissions',
      p_name: 'Q4 deals',
      p_description: null,
      p_definition: { filters: { status: 'approved' }, sort: null },
      p_row_scope: 'all',
    });
    const createArgs = mockClientRpc.mock.calls.find(([n]) => n === 'broker_report_def_create')![1];
    expect(Object.keys(createArgs).filter((k) => /general|access/i.test(k))).toEqual([]);
  });

  it('Delete asks first, then calls broker_report_def_delete and goes to the index', async () => {
    mockClientRpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    render(<DeleteReportButton defId={DEF} name="Q4 deals" level="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(mockClientRpc).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockClientRpc).toHaveBeenCalledWith('broker_report_def_delete', { p_def: DEF }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard/reports'));
  });

  it.each([['editor' as const], ['viewer' as const]])('Delete is not offered to an %s', (level) => {
    render(<DeleteReportButton defId={DEF} name="Q4 deals" level={level} />);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
