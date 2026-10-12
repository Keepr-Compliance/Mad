/**
 * Broker Submissions search and agent filter — BACKLOG-3904.
 *
 * Same harness as __tests__/submission-deals-3597/deal-list.test.tsx: the REAL
 * page, the REAL lib/submissions (dealList, names, listUrl) and the REAL
 * SubmissionFilters client component, against the PostgREST emulator. The
 * emulator applies eq/neq/in as filters with NO RLS, so every scope asserted
 * here is the page's own query, not a database policy.
 *
 * FIXTURES: submission rows from __tests__/helpers/submissionRows.ts (the
 * production columns); users rows from userNameRow (exactly the five columns
 * lib/submissions/names.ts selects). Every id, name, email and address is
 * invented.
 *
 * Modelling notes:
 *   - users_select_public admits members of ANY org the viewer belongs to, so
 *     the fixture gives an out-of-scope submitter and an in-org non-submitter
 *     users rows the viewer could read. Neither may reach the page.
 *   - Support sessions: scoped-client.ts ID-scopes users to the target user.
 *     The getDataClient mock bypasses that Proxy, so the R2 case MODELS it by
 *     seeding users with the target's row only.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { FIXTURE_BROKERAGE_ORG_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';
import { submissionRow, userNameRow } from '../helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
let mockImpersonatedOrg: string | null = null;
let mockPortalAccess: Record<string, boolean> = {};
let mockUsersLookupFails = false;
const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: {
      from: (t: string) =>
        t === 'users' && mockUsersLookupFails
          ? { select: () => ({ in: async () => ({ data: null, error: { message: 'lookup failed' } }) }) }
          : mockEmulator.from(t),
    },
    impersonation: mockImpersonatedOrg ? { organizationId: mockImpersonatedOrg } : null,
    organizationId: mockImpersonatedOrg,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', mockPortalAccess[orgId] ?? true)
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

// pii-allow-uuid: invented fixture ids below (whole block)
const ORG = FIXTURE_BROKERAGE_ORG_ID;
const ORG_NO_ACCESS = '00000000-0000-4000-8000-0000003904b1'; // pii-allow-uuid: invented fixture id
const AGENT_A = '00000000-0000-4000-8000-0000003904a1'; // pii-allow-uuid: invented fixture id
const AGENT_B = '00000000-0000-4000-8000-0000003904a2'; // pii-allow-uuid: invented fixture id
const AGENT_X = '00000000-0000-4000-8000-0000003904a9'; // pii-allow-uuid: invented fixture id
const NON_SUBMITTER = '00000000-0000-4000-8000-0000003904a8'; // pii-allow-uuid: invented fixture id
const A1 = '00000000-0000-4000-8000-000000390401'; // pii-allow-uuid: invented fixture id
const A2_V1 = '00000000-0000-4000-8000-000000390402'; // pii-allow-uuid: invented fixture id
const A2_V2 = '00000000-0000-4000-8000-000000390403'; // pii-allow-uuid: invented fixture id
const B1 = '00000000-0000-4000-8000-000000390404'; // pii-allow-uuid: invented fixture id
const X1 = '00000000-0000-4000-8000-000000390409'; // pii-allow-uuid: invented fixture id

// Invented display names (constants keep each name off any line with an id or address).
const NAME_A = 'Agent Alpha';
const NAME_B = 'Agent Bravo';
const NAME_X = 'Agent Xray';
const NAME_N = 'Agent November';

function sub(
  id: string,
  agent: string,
  address: string,
  status: string,
  createdAt: string,
  opts: { parent?: string | null; org?: string; version?: number } = {}
): Row {
  return {
    ...submissionRow({
      id,
      organizationId: opts.org ?? ORG,
      submittedBy: agent,
      status,
      address,
      parentSubmissionId: opts.parent ?? null,
      createdAt,
    }),
    version: opts.version ?? 1,
  };
}

/**
 * Deals: A1 (Alpha, submitted), A2 (Alpha, v1 "11 Old Mill Road" rejected ->
 * v2 "11 Mill Road" resubmitted: the address changed between versions), B1
 * (Bravo, approved). X1 is in ORG_NO_ACCESS (outside the list's scope).
 */
const ROWS: Row[] = [
  sub(A1, AGENT_A, '10 Birch Lane', 'submitted', '2026-09-03T00:00:00Z'),
  sub(A2_V1, AGENT_A, '11 Old Mill Road', 'rejected', '2026-09-01T00:00:00Z'),
  sub(A2_V2, AGENT_A, '11 Mill Road', 'resubmitted', '2026-09-04T00:00:00Z', { parent: A2_V1, version: 2 }),
  sub(B1, AGENT_B, '20 Cedar Court', 'approved', '2026-09-02T00:00:00Z'),
  sub(X1, AGENT_X, '99 Outside Way', 'submitted', '2026-09-05T00:00:00Z', { org: ORG_NO_ACCESS }),
];

const USERS: Row[] = [
  userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test'),
  userNameRow(AGENT_B, NAME_B, 'bravo@fixture.example.test'),
  // Readable under users_select_public, but neither may reach the page:
  userNameRow(AGENT_X, NAME_X, 'xray@outside.example.test'),
  userNameRow(NON_SUBMITTER, NAME_N, 'november@fixture.example.test'),
];

function given(
  rows: Row[] = ROWS,
  opts: { users?: Row[]; impersonating?: string | null; noAccess?: string[]; usersLookupFails?: boolean } = {}
): void {
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: rows, users: opts.users ?? USERS } });
  mockImpersonatedOrg = opts.impersonating ?? null;
  mockPortalAccess = Object.fromEntries((opts.noAccess ?? [ORG_NO_ACCESS]).map((o) => [o, false]));
  mockUsersLookupFails = opts.usersLookupFails ?? false;
}

async function renderList(params: { status?: string; page?: string; agent?: string; search?: string } = {}) {
  const element = await SubmissionsPage({ searchParams: Promise.resolve(params) });
  return render(element);
}

function listedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody a[href^="/dashboard/submissions/"]')).map(
    (a) => (a.getAttribute('href') as string).split('/').pop() as string
  );
}

function agentSelectOptions(): string[] {
  const select = screen.getByLabelText('Submitted by') as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent ?? '');
}

const OUT_OF_SCOPE_TEXT = [NAME_X, 'xray@outside.example.test', NAME_N, 'november@fixture.example.test'];

function expectNoOutOfScopeText(container: HTMLElement): void {
  for (const text of OUT_OF_SCOPE_TEXT) expect(container.innerHTML).not.toContain(text);
}

beforeEach(() => {
  given();
  mockPush.mockClear();
  mockReplace.mockClear();
});

describe('C1 org boundary: agents and search never reach outside the list scope', () => {
  it('agent options are exactly the in-scope submitters (no out-of-scope agent, no non-submitter)', async () => {
    const { container } = await renderList();
    expect(agentSelectOptions()).toEqual(['All agents', NAME_A, NAME_B]);
    expectNoOutOfScopeText(container);
  });

  it('a search for an out-of-scope agent or address finds nothing', async () => {
    for (const search of ['Xray', 'xray@outside', '99 Outside Way']) {
      const { container, unmount } = await renderList({ search });
      expect(listedIds(container)).toEqual([]);
      expectNoOutOfScopeText(container);
      unmount();
    }
  });

  it('R1: ?agent=<out-of-scope id> lists nothing and never resolves that id\'s name', async () => {
    const { container } = await renderList({ agent: AGENT_X });
    expect(listedIds(container)).toEqual([]);
    expectNoOutOfScopeText(container);
    expect(screen.getByRole('button', { name: 'Agent: Unknown agent' })).toBeInTheDocument();
    // The only users read is for in-scope submitters.
    const userReads = mockEmulator.state.selects.filter((s) => s.table === 'users');
    expect(userReads).toHaveLength(1);
  });
});

describe('search', () => {
  it('matches address, agent name and agent email, case-insensitively', async () => {
    expect(listedIds((await renderList({ search: 'birch' })).container)).toEqual([A1]);
    expect(listedIds((await renderList({ search: 'BRAVO' })).container)).toEqual([B1]);
    expect(listedIds((await renderList({ search: 'alpha@fixture' })).container)).toEqual([A2_V2, A1]);
  });

  it('C2: matches the latest version only (an older version\'s address finds nothing)', async () => {
    expect(listedIds((await renderList({ search: 'Old Mill' })).container)).toEqual([]);
    expect(listedIds((await renderList({ search: '11 Mill Road' })).container)).toEqual([A2_V2]);
  });

  it('C3: filters before paginating (the only match, oldest of 30, is on page 1)', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0');
      const id = `00000000-0000-4000-8000-0000003905${n}`; // pii-allow-uuid: invented fixture id
      rows.push(sub(id, AGENT_A, i === 0 ? '1 Needle Street' : `${i} Hay Street`, 'submitted', `2026-09-01T00:${n}:00Z`));
    }
    given(rows);
    const { container } = await renderList({ search: 'needle' });
    expect(listedIds(container)).toEqual(['00000000-0000-4000-8000-000000390500']); // pii-allow-uuid: invented fixture id
    expect(container).toHaveTextContent('1 submission');
    expect(container.querySelector('a[href*="page=2"]')).toBeNull();
  });

  it('works together with the status filter and the agent filter', async () => {
    expect(listedIds((await renderList({ search: 'road', status: 'submitted' })).container)).toEqual([A2_V2]);
    expect(listedIds((await renderList({ search: 'road', agent: AGENT_B })).container)).toEqual([]);
  });
});

describe('agent filter', () => {
  it('lists only that agent\'s deals and labels the control with the in-scope name', async () => {
    const { container } = await renderList({ agent: AGENT_B });
    expect(listedIds(container)).toEqual([B1]);
    expect(screen.getByRole('button', { name: `Agent: ${NAME_B}` })).toBeInTheDocument();
    expect((screen.getByLabelText('Submitted by') as HTMLSelectElement).value).toBe(AGENT_B);
  });

  it('C6: a non-uuid agent value is ignored (list unchanged)', async () => {
    const { container } = await renderList({ agent: 'not-a-uuid' });
    expect(listedIds(container)).toEqual([A2_V2, A1, B1]);
    expect(screen.getByRole('button', { name: 'Agent: All agents' })).toBeInTheDocument();
  });
});

describe('C5 links keep every filter (URLSearchParams)', () => {
  it('page-2 link carries agent and a search containing "&"', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, '0');
      const id = `00000000-0000-4000-8000-0000003906${n}`; // pii-allow-uuid: invented fixture id
      rows.push(sub(id, AGENT_A, `12 Oak & Elm Unit ${i}`, 'submitted', `2026-09-01T00:${n}:00Z`));
    }
    given(rows);
    const search = '12 Oak & Elm';
    const { container } = await renderList({ search, agent: AGENT_A });
    expect(listedIds(container)).toHaveLength(25);
    const next = container.querySelector('a[href*="page=2"]') as HTMLAnchorElement;
    expect(next).not.toBeNull();
    const url = new URL(next.getAttribute('href') as string, 'http://x');
    expect(url.pathname).toBe('/dashboard/submissions');
    expect(url.searchParams.get('search')).toBe(search);
    expect(url.searchParams.get('agent')).toBe(AGENT_A);
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('R7: desktop status tabs keep their text and carry agent + search, with no page', async () => {
    const { container } = await renderList({ agent: AGENT_A, search: 'a&b', page: '1' });
    const pending = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Pending') as HTMLAnchorElement;
    expect(pending).toBeDefined();
    const url = new URL(pending.getAttribute('href') as string, 'http://x');
    expect(url.searchParams.get('status')).toBe('submitted');
    expect(url.searchParams.get('agent')).toBe(AGENT_A);
    expect(url.searchParams.get('search')).toBe('a&b');
    expect(url.searchParams.has('page')).toBe(false);
  });
});

describe('R2 names in a support session and on a failed lookup', () => {
  it('impersonating: no name lookup, neutral labels, no "Former member"; address search still works', async () => {
    // Models scoped-client.ts: users is ID-scoped to the target (AGENT_A) only.
    given(ROWS, { impersonating: ORG, noAccess: [], users: [userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test')] });
    const { container } = await renderList();
    expect(container).not.toHaveTextContent('Former member');
    expect(agentSelectOptions()).toEqual(['All agents', 'Agent 1', 'Agent 2']);
    expect(mockEmulator.state.selects.filter((s) => s.table === 'users')).toEqual([]);
    expect(listedIds((await renderList({ search: 'cedar' })).container)).toEqual([B1]);
  });

  it('a failed users lookup gives neutral labels, never "Former member"', async () => {
    given(ROWS, { usersLookupFails: true });
    const { container } = await renderList();
    expect(container).not.toHaveTextContent('Former member');
    expect(agentSelectOptions()).toEqual(['All agents', 'Agent 1', 'Agent 2']);
  });

  it('a submitter missing from users (left the org) is "Former member" in a normal session', async () => {
    given(ROWS, { users: [userNameRow(AGENT_A, NAME_A, 'alpha@fixture.example.test')] });
    await renderList();
    expect(agentSelectOptions()).toEqual(['All agents', NAME_A, 'Former member']);
  });
});

describe('C4 + C7 phone filter sheets (one per filter)', () => {
  async function openStatus() {
    fireEvent.click(screen.getByRole('button', { name: 'Status: All' }));
    return screen.getByRole('dialog', { name: 'Status' });
  }
  async function openAgent() {
    fireEvent.click(screen.getByRole('button', { name: 'Agent: All agents' }));
    return screen.getByRole('dialog', { name: 'Agent' });
  }

  it('Status opens a status-only sheet', async () => {
    await renderList();
    const sheet = await openStatus();
    expect(within(sheet).getByRole('button', { name: 'Pending · 2' })).toBeInTheDocument();
    expect(within(sheet).queryByLabelText(NAME_A)).toBeNull();
    expect(within(sheet).queryByPlaceholderText('Find an agent')).toBeNull();
  });

  it('Agent opens an agent-only sheet with its own search', async () => {
    await renderList();
    const sheet = await openAgent();
    expect(within(sheet).getByLabelText(NAME_A)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^Pending/ })).toBeNull();
    fireEvent.change(within(sheet).getByPlaceholderText('Find an agent'), { target: { value: 'brav' } });
    expect(within(sheet).queryByLabelText(NAME_A)).toBeNull();
    expect(within(sheet).getByLabelText(NAME_B)).toBeInTheDocument();
  });

  it('C4: counts are of deals (a 2-version deal counts once)', async () => {
    await renderList();
    const agent = await openAgent();
    const alpha = within(agent).getByLabelText(NAME_A).closest('label') as HTMLElement;
    expect(alpha).toHaveTextContent(new RegExp(`${NAME_A}\\s*2$`));
    fireEvent.click(within(agent).getByRole('button', { name: 'Close' }));
    const status = await openStatus();
    expect(within(status).getByRole('button', { name: 'All · 3' })).toBeInTheDocument();
  });

  it('C7: Status Show N follows the pending status; applying navigates with that filter only; Clear resets', async () => {
    await renderList({ search: 'road' });
    const sheet = await openStatus();
    // search "road" leaves A2 (Mill Road, resubmitted) only.
    expect(within(sheet).getByRole('button', { name: 'Show 1 submission' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Approved · 0' }));
    expect(within(sheet).getByRole('button', { name: 'Show 0 submissions' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear' }));
    expect(within(sheet).getByRole('button', { name: 'Show 1 submission' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pending · 1' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 1 submission' }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = new URL(mockPush.mock.calls[0][0] as string, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'submitted', search: 'road' });
  });

  it('C7: Agent sheet applies the agent only, keeping status and search', async () => {
    await renderList({ status: 'submitted', search: 'road' });
    const sheet = await openAgent();
    fireEvent.click(within(sheet).getByLabelText(NAME_A));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show 1 submission' }));
    const url = new URL(mockPush.mock.calls[0][0] as string, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'submitted', agent: AGENT_A, search: 'road' });
  });

  it('Clear filters drops every filter', async () => {
    await renderList({ status: 'submitted', agent: AGENT_A, search: 'mill' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/submissions');
  });
});

describe('phone density: no count line', () => {
  it('the phone block has no "N submissions" text and the header count is hidden below md', async () => {
    const { container } = await renderList();
    const phone = container.querySelector('div.md\\:hidden') as HTMLElement;
    expect(phone).not.toBeNull();
    expect(phone.textContent ?? '').not.toMatch(/\d+ submissions?/);
    const header = Array.from(container.querySelectorAll('span.max-md\\:hidden')).find((e) =>
      /\d+ submissions?/.test(e.textContent ?? '')
    );
    expect(header).toBeDefined();
  });
});

describe('phone search as you type', () => {
  const phoneSearch = () => screen.getByPlaceholderText('Search address or agent') as HTMLInputElement;
  const type = (v: string) => fireEvent.change(phoneSearch(), { target: { value: v } });
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  const sentSearch = (call: number) =>
    new URL(mockReplace.mock.calls[call][0] as string, 'http://x').searchParams.get('search');

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('typing replaces the URL after 250 ms, trimmed and collapsed, keeping the other filters', async () => {
    await renderList({ agent: AGENT_A });
    type('  Oak   &  Elm ');
    tick(249);
    expect(mockReplace).not.toHaveBeenCalled();
    tick(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const url = new URL(mockReplace.mock.calls[0][0] as string, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ agent: AGENT_A, search: 'Oak & Elm' });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('runs from one character: "3" then "33" then "33 " sends 3 and 33, nothing for the space', async () => {
    await renderList();
    type('3');
    tick(250);
    type('33');
    tick(250);
    type('33 ');
    tick(500);
    expect(mockReplace).toHaveBeenCalledTimes(2);
    expect(sentSearch(0)).toBe('3');
    expect(sentSearch(1)).toBe('33');
  });

  it('a space typed while the request is in flight survives the URL echo', async () => {
    const { rerender } = await renderList();
    type('33');
    tick(250);
    type('33 ');
    // the server answers for "33": the page re-renders with search=33
    const echoed = await SubmissionsPage({ searchParams: Promise.resolve({ search: '33' }) });
    await act(async () => {
      rerender(echoed);
    });
    expect(phoneSearch().value).toBe('33 ');
  });

  it('Enter submits at once; clearing sends at once', async () => {
    await renderList({ search: 'mill' });
    type('oak');
    fireEvent.submit(phoneSearch().closest('form') as HTMLFormElement);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(sentSearch(0)).toBe('oak');
    type('');
    expect(mockReplace).toHaveBeenCalledTimes(2);
    expect(sentSearch(1)).toBeNull(); // an empty search is omitted from the URL
  });
});

describe('search matching: numbers and words', () => {
  const ID_33 = '00000000-0000-4000-8000-000000390411'; // pii-allow-uuid: invented fixture id
  const ID_133 = '00000000-0000-4000-8000-000000390412'; // pii-allow-uuid: invented fixture id
  const ID_7 = '00000000-0000-4000-8000-000000390413'; // pii-allow-uuid: invented fixture id
  const addrRows = [
    sub(ID_33, AGENT_A, '33 Oak Lane', 'submitted', '2026-09-03T00:00:00Z'),
    sub(ID_133, AGENT_A, '133 Elm Street', 'submitted', '2026-09-02T00:00:00Z'),
    sub(ID_7, AGENT_B, '7 Oak Lane', 'submitted', '2026-09-01T00:00:00Z'),
  ];

  it('"33" finds "33 Oak Lane" and not "133 Elm Street"', async () => {
    given(addrRows);
    const { container } = await renderList({ search: '33' });
    expect(listedIds(container)).toEqual([ID_33]);
  });

  it('every word must match, in any order: "oak 33" finds 33 Oak Lane only', async () => {
    given(addrRows);
    const { container } = await renderList({ search: 'oak 33' });
    expect(listedIds(container)).toEqual([ID_33]);
  });
});

/**
 * FOUNDER QA (BACKLOG-3904): "3" and "33" appeared to do nothing. The
 * producer stores the FULL formatted address in property_address
 * ("<n> <street>, <city>, <ST> <zip>, USA"; shape read from the live table
 * 2026-10-12, aggregate only), so a number matched the start of ANY word,
 * zip codes included. Values below are invented.
 */
describe('search matching: a number is a house number, not a zip code', () => {
  const HOUSE_33 = '00000000-0000-4000-8000-000000390421'; // pii-allow-uuid: invented fixture id
  const ZIP_331 = '00000000-0000-4000-8000-000000390422'; // pii-allow-uuid: invented fixture id
  const NO_NUMBER_ZIP_33 = '00000000-0000-4000-8000-000000390423'; // pii-allow-uuid: invented fixture id
  const HOUSE_57_ZIP_39 = '00000000-0000-4000-8000-000000390424'; // pii-allow-uuid: invented fixture id
  const HOUSE_330 = '00000000-0000-4000-8000-000000390425'; // pii-allow-uuid: invented fixture id
  const fullRows = [
    sub(HOUSE_33, AGENT_A, '33 Maple Rd, Pinecrest, FL 33156, USA', 'submitted', '2026-09-05T00:00:00Z'),
    sub(ZIP_331, AGENT_A, '572 Elm Dr, Lakeside, FL 33166, USA', 'submitted', '2026-09-04T00:00:00Z'),
    sub(NO_NUMBER_ZIP_33, AGENT_B, 'Birch Dr, Lakeside, FL 33133, USA', 'submitted', '2026-09-03T00:00:00Z'),
    sub(HOUSE_57_ZIP_39, AGENT_B, '57 Oak Rd, Hillview, MS 39428, USA', 'submitted', '2026-09-02T00:00:00Z'),
    sub(HOUSE_330, AGENT_B, '330 Cedar Ln, Hillview, MS 39428, USA', 'submitted', '2026-09-01T00:00:00Z'),
  ];

  it('"33" finds house numbers starting 33 and not zip codes starting 33', async () => {
    given(fullRows);
    const { container } = await renderList({ search: '33' });
    expect(listedIds(container)).toEqual([HOUSE_33, HOUSE_330]);
  });

  it('"3" finds house numbers starting with 3, so it narrows the list', async () => {
    given(fullRows);
    const { container } = await renderList({ search: '3' });
    expect(listedIds(container)).toEqual([HOUSE_33, HOUSE_330]);
  });

  it('"33 v" still finds the one 33 deal whose address has a v', async () => {
    given([...fullRows, sub('00000000-0000-4000-8000-000000390426', AGENT_A, '33 Vine St, Pinecrest, FL 33156, USA', 'submitted', '2026-08-01T00:00:00Z')]); // pii-allow-uuid: invented fixture id
    const { container } = await renderList({ search: '33 v' });
    expect(listedIds(container)).toEqual(['00000000-0000-4000-8000-000000390426']); // pii-allow-uuid: invented fixture id
  });

  it('a number still matches inside a name or email (only the address is anchored)', async () => {
    given([
      sub(HOUSE_57_ZIP_39, AGENT_B, '57 Oak Rd, Hillview, MS 39428, USA', 'submitted', '2026-09-02T00:00:00Z'),
    ], { users: [userNameRow(AGENT_B, NAME_B, 'bravo7@fixture.example.test')] });
    const { container } = await renderList({ search: '7' });
    expect(listedIds(container)).toEqual([HOUSE_57_ZIP_39]);
  });
});

