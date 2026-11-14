/**
 * Reports index (My reports / Shared with me) — BACKLOG-3513 PR-3g.
 *
 * The REAL page (app/dashboard/reports/page.tsx), the REAL server reads
 * (lib/reports/definitions/server.ts) and the REAL summary helpers run. Mocked:
 * the gate (requireMyReports), the session client's rpc and the organizations
 * name read, next/link.
 *
 * Reply shapes transcribed from migrations 20261112200000 / 20261112210000:
 * broker_report_def_list [{id, name, dataset_key, level, owner_name, updated_at}]
 * (coalesced to '[]', so null is never a real answer); broker_report_orphans
 * [{id, name, dataset_key, owner_name, owner_state, level}] (no updated_at);
 * broker_report_share_list {owner {id, name, role, is_you}, general_access,
 * row_scope, level, entries [{kind, id, name, detail, level}]} (role entry names
 * 'All agents', 'All brokers', 'All admins', ...). Ids and names are invented.
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import type { ReportCaller } from '@/lib/reports/report-gate';
import { SUBMISSIONS_REPORT } from '@/lib/reports/registry';

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = '00000000-0000-4000-8000-0000003513e0'; // pii-allow-uuid: invented fixture id
const ME = '00000000-0000-4000-8000-0000003513e1'; // pii-allow-uuid: invented fixture id
const R_MINE_A = '00000000-0000-4000-8000-0000003513e2'; // pii-allow-uuid: invented fixture id
const R_MINE_B = '00000000-0000-4000-8000-0000003513e3'; // pii-allow-uuid: invented fixture id
const R_EDIT = '00000000-0000-4000-8000-0000003513e4'; // pii-allow-uuid: invented fixture id
const R_VIEW = '00000000-0000-4000-8000-0000003513e5'; // pii-allow-uuid: invented fixture id
const R_ORPHAN = '00000000-0000-4000-8000-0000003513e6'; // pii-allow-uuid: invented fixture id
const R_ORPHAN_HIDDEN = '00000000-0000-4000-8000-0000003513e7'; // pii-allow-uuid: invented fixture id
const P1 = '00000000-0000-4000-8000-0000003513f1'; // pii-allow-uuid: invented fixture id
const P2 = '00000000-0000-4000-8000-0000003513f2'; // pii-allow-uuid: invented fixture id
// Invented names, kept off the lines that carry dates.
const SELF = 'Me Myself';
const DANA = 'Dana Pike';

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
const mockMine = jest.fn();

jest.mock('@/lib/reports/report-gate', () => ({
  requireMyReports: (...a: unknown[]) => mockMine(...a),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ReportsPage from '@/app/dashboard/reports/page';
import { AGENT_SUBTITLE, FULL_SUBTITLE } from '@/lib/reports/definitions/summary';

function caller(kind: 'full' | 'agent'): ReportCaller {
  return {
    supabase: {
      rpc: mockRpc,
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: table === 'organizations' ? { name: 'Maple Realty' } : null, error: null }),
          }),
        }),
      }),
    } as unknown as ReportCaller['supabase'],
    userId: ME,
    organizationId: ORG,
    role: kind === 'full' ? 'broker' : 'agent',
    kind,
  };
}

const listRow = (id: string, name: string, level: string, updated: string | null, owner = 'Jordan Lee') => ({
  id,
  name,
  dataset_key: 'submissions',
  level,
  owner_name: owner,
  ...(updated === null ? {} : { updated_at: updated }),
});

const person = (id: string, name: string) => ({ kind: 'person', id, name, detail: 'agent', level: 'viewer' });
const role = (id: string, name: string) => ({ kind: 'role', id, name, detail: null, level: 'viewer' });
const shareList = (generalAccess: 'restricted' | 'organization', rowScope: 'all' | 'own', entries: unknown[]) => ({
  owner: { id: ME, name: 'Me Myself', role: 'broker', is_you: true },
  general_access: generalAccess,
  row_scope: rowScope,
  level: 'owner',
  entries,
});

type Reply = { data: unknown; error: unknown };
interface World {
  defList?: Reply;
  orphans?: unknown;
  /** share_list reply per report id; missing id -> {error}. */
  share?: Record<string, Reply>;
}

function given(w: World) {
  mockRpc.mockImplementation(async (name, args) => {
    if (name === 'broker_report_def_list') return w.defList ?? { data: [], error: null };
    if (name === 'broker_report_orphans') return { data: w.orphans ?? [], error: null };
    if (name === 'broker_report_share_list') {
      return w.share?.[args.p_def as string] ?? { data: null, error: { message: 'Report not found' } };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

async function renderIndex(kind: 'full' | 'agent', w: World) {
  given(w);
  mockMine.mockResolvedValue({ caller: caller(kind), reports: [{ report: SUBMISSIONS_REPORT, scope: kind === 'full' ? 'all' : 'own' }] });
  const el = await ReportsPage();
  return render(el);
}

const ok = (data: unknown): Reply => ({ data, error: null });
const rowFor = (name: string) => screen.getByRole('link', { name }).closest('li') as HTMLElement;
const summaryOf = (name: string) => within(rowFor(name)).queryByTestId('report-row-summary')?.textContent ?? null;
const shareListIds = () => mockRpc.mock.calls.filter(([n]) => n === 'broker_report_share_list').map(([, a]) => a.p_def);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers({ now: new Date('2026-11-14T15:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('page shape', () => {
  it('C9: no data-source card; New report opens /dashboard/reports/submissions', async () => {
    await renderIndex('full', {});
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New report' })).toHaveAttribute('href', '/dashboard/reports/submissions');
    const toSubmissions = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/dashboard/reports/submissions');
    expect(toSubmissions).toHaveLength(1);
    expect(screen.queryByText(SUBMISSIONS_REPORT.title)).toBeNull();
    expect(screen.queryByText(SUBMISSIONS_REPORT.description)).toBeNull();
    expect(screen.queryByTestId('reports-index')).toBeNull();
  });

  it('C6: a full role gets the full subtitle and My reports first', async () => {
    await renderIndex('full', {
      defList: ok([listRow(R_MINE_A, 'Mine', 'owner', '2026-11-14T10:00:00Z'), listRow(R_VIEW, 'Theirs', 'viewer', '2026-11-13T10:00:00Z')]),
      share: { [R_MINE_A]: ok(shareList('restricted', 'all', [])) },
    });
    expect(screen.getByText(FULL_SUBTITLE)).toBeInTheDocument();
    expect(screen.queryByText(AGENT_SUBTITLE)).toBeNull();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['My reports', 'Shared with me']);
  });

  it('C6: an agent gets the agent subtitle and Shared with me first', async () => {
    await renderIndex('agent', {
      defList: ok([listRow(R_MINE_A, 'Mine', 'owner', '2026-11-14T10:00:00Z'), listRow(R_VIEW, 'Theirs', 'viewer', '2026-11-13T10:00:00Z')]),
      share: { [R_MINE_A]: ok(shareList('restricted', 'all', [])) },
    });
    expect(screen.getByText(AGENT_SUBTITLE)).toBeInTheDocument();
    expect(screen.queryByText(FULL_SUBTITLE)).toBeNull();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Shared with me', 'My reports']);
  });

  it('empty: My reports says "No reports yet"; Shared with me is hidden', async () => {
    await renderIndex('full', { defList: ok([]) });
    expect(screen.getByTestId('my-reports-empty')).toHaveTextContent('No reports yet');
    expect(screen.queryByTestId('shared-with-me')).toBeNull();
    expect(screen.queryByTestId('reports-index-error')).toBeNull();
    expect(shareListIds()).toEqual([]);
  });
});

describe('C8 / SR 1: a failed list says so, never "No reports yet"', () => {
  it.each([
    ['an error', { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } }],
    ['no data and no error (the route-audit shape)', { data: null, error: null }],
    ['a non-array reply', { data: { id: 'x' }, error: null }],
  ])('def_list returns %s', async (_n, defList) => {
    await renderIndex('full', { defList });
    expect(screen.getByTestId('reports-index-error')).toHaveTextContent('Your reports could not be loaded.');
    expect(screen.queryByText('No reports yet')).toBeNull();
    expect(screen.queryByTestId('my-reports-empty')).toBeNull();
  });

  it('a failed list still lists an orphan the caller can open (ok comes from def_list alone)', async () => {
    await renderIndex('full', {
      defList: { data: null, error: { message: 'boom' } },
      orphans: [{ id: R_ORPHAN, name: 'Closings', dataset_key: 'submissions', owner_name: 'Dana Pike', owner_state: 'gone', level: 'viewer' }],
    });
    expect(screen.getByTestId('reports-index-error')).toBeInTheDocument();
    expect(summaryOf('Closings')).toBe("From Dana Pike · Can view · Owner's account removed");
  });
});

describe('C5: the two lists partition on the caller level', () => {
  it('owner rows only in My reports; editor and viewer rows only in Shared with me', async () => {
    await renderIndex('full', {
      defList: ok([
        listRow(R_MINE_A, 'Mine', 'owner', '2026-11-14T10:00:00Z', SELF),
        listRow(R_EDIT, 'Office pipeline', 'editor', '2026-11-12T10:00:00Z'),
        listRow(R_VIEW, 'Closings this month', 'viewer', '2026-11-01T10:00:00Z', 'Priya Raman'),
      ]),
      share: { [R_MINE_A]: ok(shareList('restricted', 'all', [])) },
    });
    const mine = screen.getByTestId('my-reports');
    const withMe = screen.getByTestId('shared-with-me');
    expect(within(mine).getAllByTestId('report-row').map((r) => within(r).getByRole('link').textContent)).toEqual(['Mine']);
    expect(within(withMe).getAllByTestId('report-row').map((r) => within(r).getByRole('link').textContent)).toEqual([
      'Office pipeline',
      'Closings this month',
    ]);
    expect(summaryOf('Office pipeline')).toBe('From Jordan Lee · Can edit');
    expect(summaryOf('Closings this month')).toBe('From Priya Raman · Can view');
  });

  it('SR 3: share_list is asked for exactly the My reports ids', async () => {
    await renderIndex('full', {
      defList: ok([
        listRow(R_MINE_A, 'Mine A', 'owner', '2026-11-14T10:00:00Z'),
        listRow(R_EDIT, 'Office pipeline', 'editor', '2026-11-12T10:00:00Z'),
        listRow(R_MINE_B, 'Mine B', 'owner', '2026-11-13T10:00:00Z'),
        listRow(R_VIEW, 'Closings', 'viewer', '2026-11-01T10:00:00Z'),
      ]),
      share: { [R_MINE_A]: ok(shareList('restricted', 'all', [])), [R_MINE_B]: ok(shareList('restricted', 'all', [])) },
    });
    expect([...shareListIds()].sort()).toEqual([R_MINE_A, R_MINE_B].sort());
  });
});

describe('My reports summary (share_list)', () => {
  async function mineWith(reply: Reply) {
    await renderIndex('full', { defList: ok([listRow(R_MINE_A, 'Mine', 'owner', '2026-11-14T10:00:00Z')]), share: { [R_MINE_A]: reply } });
    return summaryOf('Mine');
  }

  it('C1: a failed share_list read shows no summary, never "Only you"', async () => {
    expect(await mineWith({ data: null, error: { message: 'Report not found' } })).toBeNull();
    expect(screen.queryByText('Only you')).toBeNull();
  });

  it('C1: an empty share_list reply shows no summary either', async () => {
    expect(await mineWith({ data: null, error: null })).toBeNull();
    expect(screen.queryByText('Only you')).toBeNull();
  });

  it('C2: a fresh report (restricted, no entries) reads "Only you"', async () => {
    expect(await mineWith(ok(shareList('restricted', 'all', [])))).toBe('Only you');
  });

  it('SR 2: restricted, no entries, row scope own -> exactly "Only you"', async () => {
    expect(await mineWith(ok(shareList('restricted', 'own', [])))).toBe('Only you');
  });

  it('C3: All agents with row scope own -> "Each sees their own"', async () => {
    expect(await mineWith(ok(shareList('restricted', 'own', [role('agent', 'All agents')])))).toBe(
      'Shared with All agents · Each sees their own'
    );
  });

  it('C3 pair: All agents with row scope all -> no "Each sees their own"', async () => {
    expect(await mineWith(ok(shareList('restricted', 'all', [role('agent', 'All agents')])))).toBe('Shared with All agents');
  });

  it('C4: two people / one person, counted from person entries only', async () => {
    expect(await mineWith(ok(shareList('restricted', 'all', [person(P1, 'Ann Lee'), person(P2, 'Bo Diaz')])))).toBe(
      'Shared with 2 people'
    );
  });

  it('C4: one person', async () => {
    expect(await mineWith(ok(shareList('restricted', 'all', [person(P1, 'Ann Lee')])))).toBe('Shared with 1 person');
  });

  it('C4: a role and a person', async () => {
    expect(await mineWith(ok(shareList('restricted', 'all', [role('broker', 'All brokers'), person(P1, 'Ann Lee')])))).toBe(
      'Shared with All brokers and 1 person'
    );
  });

  it('organization: only the organization sentence, never role or people text', async () => {
    expect(
      await mineWith(ok(shareList('organization', 'all', [role('agent', 'All agents'), person(P1, 'Ann Lee'), person(P2, 'Bo Diaz')])))
    ).toBe('Shared with everyone in Maple Realty');
  });

  it('organization with row scope own', async () => {
    expect(await mineWith(ok(shareList('organization', 'own', [])))).toBe('Shared with everyone in Maple Realty · Each sees their own');
  });
});

describe('Shared with me summary', () => {
  it('C7: the owner-state label is kept and the row links to its report page', async () => {
    await renderIndex('full', {
      defList: ok([listRow(R_ORPHAN, 'Closings', 'viewer', '2026-11-10T10:00:00Z', '')]),
      orphans: [
        { id: R_ORPHAN, name: 'Closings', dataset_key: 'submissions', owner_name: null, owner_state: 'gone', level: 'viewer' },
        { id: R_ORPHAN_HIDDEN, name: 'Old pipeline', dataset_key: 'submissions', owner_name: 'Dana Pike', owner_state: 'deactivated', level: null },
      ],
    });
    expect(screen.getAllByText('Closings')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Closings' })).toHaveAttribute('href', `/dashboard/reports/d/${encodeURIComponent(R_ORPHAN)}`);
    expect(summaryOf('Closings')).toBe("From a former member · Can view · Owner's account removed");
    // An orphan the caller cannot open is not listed (ruling A), and nothing offers Take over.
    expect(screen.queryByText('Old pipeline')).toBeNull();
    expect(screen.queryByRole('button', { name: /take over/i })).toBeNull();
  });

  it('C7: deactivated owner, editor', async () => {
    await renderIndex('full', {
      defList: ok([listRow(R_EDIT, 'Office pipeline', 'editor', '2026-11-10T10:00:00Z', DANA)]),
      orphans: [{ id: R_EDIT, name: 'Office pipeline', dataset_key: 'submissions', owner_name: 'Dana Pike', owner_state: 'deactivated', level: 'editor' }],
    });
    expect(summaryOf('Office pipeline')).toBe('From Dana Pike · Can edit · Owner deactivated');
  });
});

describe('Updated dates and order (SR 4)', () => {
  it('newest first; a row with no readable time shows no date and goes last', async () => {
    await renderIndex('full', {
      defList: ok([
        listRow(R_MINE_A, 'Garbage time', 'owner', 'x'),
        listRow(R_MINE_B, 'Older', 'owner', '2026-11-08T10:00:00Z'),
        listRow(R_EDIT, 'Newest', 'owner', '2026-11-14T09:00:00.123456+00:00'),
        listRow(R_VIEW, 'No time', 'owner', null),
      ]),
      share: {},
    });
    const names = within(screen.getByTestId('my-reports'))
      .getAllByTestId('report-row')
      .map((r) => within(r).getByRole('link').textContent);
    expect(names).toEqual(['Newest', 'Older', 'Garbage time', 'No time']);
    expect(within(rowFor('Newest')).getByTestId('report-row-updated')).toHaveTextContent('Updated today');
    expect(within(rowFor('Older')).getByTestId('report-row-updated')).toHaveTextContent('Updated Nov 8');
    expect(within(rowFor('Garbage time')).queryByTestId('report-row-updated')).toBeNull();
    expect(within(rowFor('No time')).queryByTestId('report-row-updated')).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});
