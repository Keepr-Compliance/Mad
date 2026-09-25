/**
 * The dashboard layout and the /dashboard page on the floor — BACKLOG-3080
 * (C-layout, C-data).
 *
 * The REAL layout and page run against the PostgREST emulator, which is the
 * client behind BOTH `createClient` and `getDataClient` here, so every table
 * read either of them issues is recorded. The admitted-broker cases prove the
 * log can see a `transaction_submissions` read; without them "no submissions
 * read" would prove nothing.
 */

import { render, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  FIXTURE_OTHER_USER_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  personalMembershipOwnedBy,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockReadFails = false;

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      const chain = mockEmulator.from(table);
      if (mockReadFails && table === 'organization_members') {
        (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { code: 'PGRST000', message: 'fixture' }, status: 503 }).then(ok, ko);
      }
      return chain;
    },
  })),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: jest.fn(async () => null),
}));
jest.mock('@/lib/checklist-access', () => ({
  isChecklistEditorEnabled: jest.fn(async () => false),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import DashboardLayout from '@/app/dashboard/layout';
import DashboardPage from '@/app/dashboard/page';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { getImpersonationSession } from '@/lib/impersonation';

// Two users, each with a submission of their own. Columns are the ones the
// dashboard reads, named as in public.transaction_submissions (read from
// information_schema, 2026-09-25). Values invented.
const SUBMISSION_MINE = 'sub-3080-mine';
const SUBMISSION_THEIRS = 'sub-3080-theirs';
function submission(id: string, submittedBy: string): Row {
  return {
    id,
    organization_id: '00000000-0000-4000-8000-0000003364b0', // pii-allow-uuid: invented fixture id
    submitted_by: submittedBy,
    status: 'submitted',
    property_address: `${id} Fixture Street`,
    property_city: 'Fixture City',
    property_state: 'CA',
    created_at: '2026-09-01T00:00:00Z',
  };
}

function given(memberships: Row[], readFails = false): void {
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: FIXTURE_USER_ID,
        email: 'floor-fixture-3080@fixture.example.test',
        user_metadata: { full_name: 'Robin Fixture' },
      },
    },
  });
  mockReadFails = readFails;
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organization_members: memberships,
      transaction_submissions: [
        submission(SUBMISSION_MINE, FIXTURE_USER_ID),
        submission(SUBMISSION_THEIRS, FIXTURE_OTHER_USER_ID),
      ],
    },
  });
}

const tablesRead = () => Array.from(new Set(mockEmulator.state.selects.map((s) => s.table))).sort();

async function layoutOutcome(): Promise<{ redirect?: string; props?: Record<string, unknown> }> {
  try {
    const element = await DashboardLayout({ children: null });
    expect(element.type).toBe(DashboardShell);
    return { props: element.props as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}

async function pageOutcome(): Promise<{ redirect?: string; html?: string; container?: HTMLElement }> {
  try {
    const { container } = render(await DashboardPage());
    return { html: container.innerHTML, container };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    throw e;
  }
}

const second = (row: Row): Row => ({ ...row, id: `${row.id as string}-second` });

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockReadFails = false;
  (getImpersonationSession as jest.Mock).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// C-layout
// ---------------------------------------------------------------------------

describe('DashboardLayout', () => {
  it.each([
    ['[agent, broker] (two brokerage rows)', 'agent', true, [brokerageMembership('agent'), second(brokerageMembership('broker'))]],
    ['[broker, agent] (two brokerage rows)', 'broker', false, [brokerageMembership('broker'), second(brokerageMembership('agent'))]],
    ['[personal, brokerage agent]', 'agent', true, [personalMembership(), brokerageMembership('agent')]],
    ['personal-org owner', 'agent', true, [personalMembership()]],
    ['brokerage admin', 'admin', false, [brokerageMembership('admin')]],
  ] as [string, string, boolean, Row[]][])('%s -> role %s, floorOnly %s', async (_n, role, floorOnly, rows) => {
    given(rows);
    const { props, redirect } = await layoutOutcome();
    expect(redirect).toBeUndefined();
    expect({ role: props!.role, floorOnly: props!.floorOnly, displayRole: props!.displayRole }).toEqual({
      role,
      floorOnly,
      displayRole: role,
    });
  });

  it.each([
    ['no membership', [] as Row[]],
    ['member of a personal org somebody else owns', [personalMembershipOwnedBy()]],
  ])('%s -> this browser is signed out', async (_n, rows) => {
    given(rows);
    expect(await layoutOutcome()).toEqual({ redirect: '/auth/logout?error=not_authorized' });
  });

  it('a failed membership read -> floor, no role, and NOT signed out', async () => {
    given([brokerageMembership('admin')], true);
    const { props, redirect } = await layoutOutcome();
    expect(redirect).toBeUndefined();
    expect(props!.role).toBeUndefined();
    expect(props!.floorOnly).toBe(true);
  });

  it('no session -> /login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await layoutOutcome()).toEqual({ redirect: '/login' });
  });

  it('impersonation -> no membership read, support navigation', async () => {
    (getImpersonationSession as jest.Mock).mockResolvedValue({
      target_email: 'target@fixture.example.test',
      target_name: 'Target Fixture',
    });
    given([]);
    const { props } = await layoutOutcome();
    expect(props!.floorOnly).toBe(false);
    expect(props!.isImpersonating).toBe(true);
    expect(mockEmulator.state.selects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The /dashboard page, and C-data
// ---------------------------------------------------------------------------

const FLOOR_PERSONAS: [string, Row[]][] = [
  ['brokerage agent', [brokerageMembership('agent')]],
  ['personal-org owner', [personalMembership()]],
  ['[agent, broker] (two brokerage rows)', [brokerageMembership('agent'), second(brokerageMembership('broker'))]],
  ['[personal, brokerage agent]', [personalMembership(), brokerageMembership('agent')]],
];

describe('/dashboard on the floor', () => {
  it.each(FLOOR_PERSONAS)('%s: the floor view, and no submission is read', async (_n, rows) => {
    given(rows);
    const { html, redirect, container } = await pageOutcome();

    expect(redirect).toBeUndefined();
    const { getByRole, getByText } = within(container!);
    expect(getByRole('heading', { level: 1 }).textContent).toBe('Welcome back, Robin');
    expect(getByText('Your Keepr account')).toBeInTheDocument();
    expect(getByRole('link', { name: 'Open Keepr' })).toHaveAttribute('href', 'keepr://focus');
    expect(getByRole('link', { name: /Download Keepr/ })).toHaveAttribute('href', '/download');
    expect(getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/dashboard/support');
    expect(getByRole('link', { name: 'My Account' })).toHaveAttribute('href', '/dashboard/account');

    // C-data: neither user's submission appears, and none was read.
    expect(html).not.toContain(SUBMISSION_MINE);
    expect(html).not.toContain(SUBMISSION_THEIRS);
    expect(tablesRead()).toEqual(['organization_members']);
  });

  it('a failed membership read: the floor view, nothing else read', async () => {
    given([brokerageMembership('broker')], true);
    const { html } = await pageOutcome();
    expect(html).toContain('Your Keepr account');
    expect(tablesRead()).toEqual(['organization_members']);
  });
});

describe('/dashboard for the full portal (positive controls)', () => {
  it.each(['broker', 'admin'])('%s: the overview, and the read log sees the submissions read', async (role) => {
    given([brokerageMembership(role)]);
    const { html, redirect } = await pageOutcome();

    expect(redirect).toBeUndefined();
    expect(html).toContain('Overview of transaction submissions');
    expect(html).not.toContain('Your Keepr account');
    expect(tablesRead()).toEqual(['organization_members', 'transaction_submissions']);
    // The emulator has no RLS, so the render shows the exact id set it served:
    // proof the "neither id" assertion above can fail.
    expect(html).toContain(`/dashboard/submissions/${SUBMISSION_MINE}`);
    expect(html).toContain(`/dashboard/submissions/${SUBMISSION_THEIRS}`);
  });

  it('it_admin -> /dashboard/users, before any submission is read', async () => {
    given([brokerageMembership('it_admin')]);
    expect(await pageOutcome()).toEqual({ redirect: '/dashboard/users' });
    expect(tablesRead()).toEqual(['organization_members']);
  });
});
