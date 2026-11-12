/**
 * Shared report page, index, Save as shared report, Delete — BACKLOG-3513 PR-3b.
 *
 * The REAL page (app/dashboard/reports/d/[id]/page.tsx), the REAL server reads
 * (lib/reports/definitions/server.ts) and the REAL loader run. Mocked: the gate's
 * caller (getReportsCaller / requireMyReports), the session client's rpc and the
 * organizations name read, the browser client, next/navigation.
 *
 * Reply shapes transcribed from migration 20261112200000: broker_report_def_get
 * {id, organization_id, dataset_key, name, description, definition, row_scope,
 * general_access, level, owner {name, is_you}, updated_at}; broker_report_share_list
 * {owner {id, name, role, is_you}, ...} (owner.role NULL when the owner is not an
 * active member); broker_report_def_list [{id, name, dataset_key, level,
 * owner_name, updated_at}]; broker_report_scope {level, row_scope, service_off,
 * effective_scope}. Ids and names are invented.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import type { ReportCaller } from '@/lib/reports/report-gate';
import { SUBMISSIONS_REPORT } from '@/lib/reports/registry';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = '00000000-0000-4000-8000-0000003513c0'; // pii-allow-uuid: invented fixture id
const OTHER_ORG = '00000000-0000-4000-8000-0000003513c9'; // pii-allow-uuid: invented fixture id
const DEF = '00000000-0000-4000-8000-0000003513CA'; // pii-allow-uuid: invented fixture id (upper case on purpose)
const OWNER = '00000000-0000-4000-8000-0000003513c2'; // pii-allow-uuid: invented fixture id
const ME = '00000000-0000-4000-8000-0000003513c3'; // pii-allow-uuid: invented fixture id

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
const mockClientRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>(async () => ({ data: [], error: null }));
const mockCaller = jest.fn();
const mockMine = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@/lib/reports/report-gate', () => ({
  getReportsCaller: (...a: unknown[]) => mockCaller(...a),
  requireMyReports: (...a: unknown[]) => mockMine(...a),
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
import ReportsPage from '@/app/dashboard/reports/page';
import { SaveAsSharedReport } from '@/components/reports/SaveAsSharedReport';
import { DeleteReportButton, canTakeOver } from '@/components/reports/ReportDefinitionActions';
import { definitionViewsKey, resolveDefinitionFilters } from '@/lib/reports/datasets/submissions-filters';

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
  /** share_list owner.role: null = the owner is not an active member. */
  ownerRole?: string | null;
  ownerId?: string | null;
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
        },
        error: null,
      };
    }
    if (name === 'broker_report_share_list') {
      if (w.level === 'viewer') return { data: null, error: { message: 'Report not found' } };
      return {
        data: {
          owner: { id: w.ownerId === undefined ? OWNER : w.ownerId, name: 'Avery Quinn', role: w.ownerRole === undefined ? 'broker' : w.ownerRole, is_you: w.level === 'owner' },
          general_access: 'restricted',
          row_scope: 'all',
          level: w.level,
          entries: [],
        },
        error: null,
      };
    }
    if (name === 'broker_report_scope') return { data: { level: w.level, row_scope: 'all', service_off: false, effective_scope: 'all' }, error: null };
    if (name === 'broker_report_submissions_rows') return { data: [], error: null };
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
  update: () => screen.queryByRole('button', { name: 'Save filters' }),
  del: () => screen.queryByRole('button', { name: 'Delete' }),
  takeOver: () => screen.queryByRole('button', { name: 'Take over' }),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('who gets which action', () => {
  it('an agent viewer: no Share, no Save filters, no Delete', async () => {
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

  it('an agent editor: Share and Save filters, no Delete (V5, Q5)', async () => {
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

  it('the owner (an agent): Share, Save filters and Delete', async () => {
    await renderPage('agent', { level: 'owner' });
    expect(q.share()).toBeInTheDocument();
    expect(q.update()).toBeInTheDocument();
    expect(q.del()).toBeInTheDocument();
  });
});

describe('Take over (Q6): only when the owner is gone or deactivated, only for a broker, admin or IT admin', () => {
  it('owner active: no Take over', async () => {
    await renderPage('full', { level: 'editor', ownerRole: 'broker' });
    expect(q.takeOver()).toBeNull();
  });

  it.each([['broker'], ['admin'], ['it_admin']])('owner deactivated, %s editor: Take over', async (role) => {
    await renderPage('full', { level: 'editor', ownerRole: null }, {}, role);
    expect(screen.getByTestId('report-take-over')).toHaveTextContent('The owner of this report is no longer active.');
    expect(q.takeOver()).toBeInTheDocument();
  });

  it('owner account gone (id null), broker editor: Take over', async () => {
    await renderPage('full', { level: 'editor', ownerId: null, ownerRole: null });
    expect(q.takeOver()).toBeInTheDocument();
  });

  it('owner deactivated, agent editor: no Take over', async () => {
    await renderPage('agent', { level: 'editor', ownerRole: null });
    expect(q.takeOver()).toBeNull();
  });

  it('Take over calls broker_report_take_over and refreshes', async () => {
    await renderPage('full', { level: 'editor', ownerRole: null });
    mockClientRpc.mockResolvedValueOnce({ data: { success: true }, error: null });
    fireEvent.click(q.takeOver()!);
    await waitFor(() => expect(mockClientRpc).toHaveBeenCalledWith('broker_report_take_over', { p_def: DEF }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('the rule itself', () => {
    expect(canTakeOver({ kind: 'full', level: 'editor', ownerInactive: true })).toBe(true);
    expect(canTakeOver({ kind: 'full', level: 'viewer', ownerInactive: true })).toBe(true);
    expect(canTakeOver({ kind: 'full', level: 'editor', ownerInactive: false })).toBe(false);
    expect(canTakeOver({ kind: 'full', level: 'owner', ownerInactive: true })).toBe(false);
    expect(canTakeOver({ kind: 'agent', level: 'editor', ownerInactive: true })).toBe(false);
  });
});

describe('rows and filters', () => {
  it('U6 every request reads the definition, then rows with p_def = this report and its saved filters', async () => {
    await renderPage('full', { level: 'viewer' });
    const names = mockRpc.mock.calls.map(([n]) => n);
    expect(names[0]).toBe('broker_report_def_get');
    const rows = mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows').map(([, a]) => a);
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) expect(a).toMatchObject({ p_org: ORG, p_def: DEF, p_status: 'approved' });
    expect(mockRpc.mock.calls.find(([n]) => n === 'broker_report_scope')![1]).toEqual({ p_org: ORG, p_def: DEF });
  });

  it('filters the person changed on the page (status in the URL) win over the saved ones', async () => {
    await renderPage('full', { level: 'viewer' }, { status: 'all' });
    const rows = mockRpc.mock.calls.filter(([n]) => n === 'broker_report_submissions_rows').map(([, a]) => a);
    for (const a of rows) expect(a.p_status).toBeNull();
  });

  it('a page link alone keeps the saved filters', () => {
    expect(resolveDefinitionFilters({ page: '2' }, { filters: { status: 'approved' }, sort: { key: 'oldest' } })).toMatchObject({
      status: 'approved',
      sort: 'oldest',
      page: 2,
    });
  });

  it("U9 the saved-views key is 'd-' + id in lower case", () => {
    expect(definitionViewsKey(DEF)).toBe(`d-${DEF.toLowerCase()}`);
    expect(definitionViewsKey(DEF)).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
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

describe('index: Shared reports', () => {
  it('lists the shared reports from broker_report_def_list, linking to their pages', async () => {
    mockMine.mockResolvedValue({ caller: caller('agent'), reports: [{ report: SUBMISSIONS_REPORT, scope: 'own' }] });
    mockRpc.mockImplementation(async (name) =>
      name === 'broker_report_def_list'
        ? {
            data: [{ id: DEF, name: 'Q4 deals', dataset_key: 'submissions', level: 'viewer', owner_name: 'Avery Quinn', updated_at: 'x' }],
            error: null,
          }
        : { data: null, error: { message: 'unexpected' } }
    );
    render(await ReportsPage());
    const list = screen.getByTestId('shared-reports-index');
    expect(within(list).getByRole('link', { name: /Q4 deals/ })).toHaveAttribute('href', `/dashboard/reports/d/${encodeURIComponent(DEF)}`);
    expect(list).toHaveTextContent('Can view · Owner: Avery Quinn');
    expect(mockRpc).toHaveBeenCalledWith('broker_report_def_list', { p_org: ORG });
  });

  it('a failed list keeps the built-in reports and shows no section', async () => {
    mockMine.mockResolvedValue({ caller: caller('full'), reports: [{ report: SUBMISSIONS_REPORT, scope: 'all' }] });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function', code: 'PGRST202' } });
    render(await ReportsPage());
    expect(within(screen.getByTestId('reports-index')).getByText('Submissions')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-reports-index')).toBeNull();
  });
});

describe('Save as shared report and Delete', () => {
  it('saves the current filters as a new report and opens it (agents too)', async () => {
    mockClientRpc.mockResolvedValueOnce({ data: DEF, error: null });
    render(<SaveAsSharedReport orgId={ORG} current={{ filters: { status: 'approved' }, sort: null }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as shared report' }));
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
