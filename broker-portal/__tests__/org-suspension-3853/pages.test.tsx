/**
 * The pages and the layout for a suspended BROKERAGE — BACKLOG-3853 PR-2B
 * (page belt for a failed middleware read, R4; C-7 agents keep My Transactions).
 *
 * Middleware is bypassed: the pages, gates and the layout run for real against
 * the PostgREST emulator. Every licence is ACTIVE; only org_billing_suspended
 * answers true (scaffold copied from __tests__/suspended-3878/pages.test.tsx).
 */

import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  ABSENT_COLUMN_ERROR,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';
import { ORG_WITHOUT_PLAN_FEATURES } from '../fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockLicenceReadFails = false;
let mockOrgSuspended = true;
let mockOrgRpcError = false;

function mockClient() {
  return {
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      const chain = mockEmulator.from(table);
      if (mockLicenceReadFails && table === 'licenses') {
        (chain as { then: unknown }).then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 }).then(ok, ko);
      }
      return chain;
    },
    rpc: jest.fn(async (fn: string) =>
      fn === 'org_billing_suspended'
        ? mockOrgRpcError
          ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
          : { data: mockOrgSuspended, error: null }
        : fn === 'can_edit_checklist_templates'
          ? { data: true, error: null }
          : { data: ORG_WITHOUT_PLAN_FEATURES, error: null }
    ),
  };
}

jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn(async () => mockClient()) }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: jest.fn(() => mockClient()) }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
// Server-action modules the pages import for their client components; not under test here
// (the checklist actions' own refusal is C-R3 in checklist-actions-gate.test.ts).
jest.mock('@/lib/actions/checklists', () => ({}));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
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
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

import DashboardLayout from '@/app/dashboard/layout';
import DashboardPage from '@/app/dashboard/page';
import ChecklistsPage from '@/app/dashboard/checklists/page';
import OrgSettingsPage from '@/app/dashboard/settings/page';
import UsersPage from '@/app/dashboard/users/page';
import { getImpersonationSession } from '@/lib/impersonation';
import { requireFullPortalAccess } from '@/lib/auth/portalAccess';
import { getMyTransactionsGate } from '@/lib/my-transactions-access';
import { checkOrgSettingsAccess } from '@/lib/org-settings-access';

const ACTIVE: Row = { user_id: FIXTURE_USER_ID, status: 'active' };

function given(memberships: Row[], licence: Row | null, licenceReadFails = false): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: 'suspended-3878@fixture.example.test', user_metadata: {} } },
  });
  mockLicenceReadFails = licenceReadFails;
  mockEmulator.set({ columnPresent: true, rows: { organization_members: memberships, licenses: licence ? [licence] : [] } });
}

type Outcome = { redirect: string } | { notFound: true } | { element: unknown };
async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { element: await fn() };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.to };
    if (e instanceof NotFound) return { notFound: true };
    throw e;
  }
}

const OLD_FLAG = process.env.BILLING_ENABLED;
afterAll(() => {
  if (OLD_FLAG === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = OLD_FLAG;
});
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockLicenceReadFails = false;
  mockOrgSuspended = true;
  mockOrgRpcError = false;
  process.env.BILLING_ENABLED = 'true';
  (getImpersonationSession as jest.Mock).mockResolvedValue(null);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe('/dashboard (home)', () => {
  it.each([
    ['broker, billing on', 'broker', 'true', '/dashboard/billing'],
    ['admin, billing on', 'admin', 'true', '/dashboard/billing'],
    ['it_admin, billing on', 'it_admin', 'true', '/dashboard/billing'],
    ['broker, billing off', 'broker', 'false', '/dashboard/account'],
  ])('%s -> %s, before any submission is read', async (_n, role, flag, to) => {
    process.env.BILLING_ENABLED = flag;
    given([brokerageMembership(role)], ACTIVE);
    expect(await run(() => DashboardPage())).toEqual({ redirect: to });
    expect(mockEmulator.state.selects.map((s) => s.table)).not.toContain('transaction_submissions');
  });

  it('C-7: an agent keeps the dashboard home', async () => {
    given([brokerageMembership('agent')], ACTIVE);
    const out = await run(() => DashboardPage());
    expect('element' in out).toBe(true);
  });

  it('control: the same broker in an active brokerage is not redirected', async () => {
    mockOrgSuspended = false;
    given([brokerageMembership('broker')], ACTIVE);
    expect('element' in (await run(() => DashboardPage()))).toBe(true);
  });

  it('R4: a failed brokerage read -> not redirected, static code logged', async () => {
    mockOrgRpcError = true;
    given([brokerageMembership('broker')], ACTIVE);
    expect('element' in (await run(() => DashboardPage()))).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith('[portalAccess] brokerage suspension check skipped', { code: 'org_suspension_read_failed' });
  });
});

describe('page gates (belt for a failed middleware read)', () => {
  it('requireFullPortalAccess: suspended brokerage -> null; active -> admitted; failed read -> admitted', async () => {
    given([brokerageMembership('broker')], ACTIVE);
    expect(await requireFullPortalAccess()).toBeNull();
    mockOrgSuspended = false;
    given([brokerageMembership('broker')], ACTIVE);
    expect(await requireFullPortalAccess()).not.toBeNull();
    mockOrgRpcError = true;
    given([brokerageMembership('broker')], ACTIVE);
    expect(await requireFullPortalAccess()).not.toBeNull();
  });

  it('checkOrgSettingsAccess: suspended brokerage admin -> unauthorized; active -> allowed', async () => {
    given([brokerageMembership('admin')], ACTIVE);
    expect(await checkOrgSettingsAccess()).toEqual({ allowed: false, reason: 'unauthorized' });
    mockOrgSuspended = false;
    given([brokerageMembership('admin')], ACTIVE);
    expect(await checkOrgSettingsAccess()).toMatchObject({ allowed: true });
  });

  it('Users page: suspended brokerage admin -> /dashboard', async () => {
    given([brokerageMembership('admin')], ACTIVE);
    expect(await run(() => UsersPage())).toEqual({ redirect: '/dashboard' });
  });

  it.each(['broker', 'agent'])('Checklists page: %s in a suspended brokerage -> 404', async (role) => {
    given([brokerageMembership(role)], ACTIVE);
    expect(await run(() => ChecklistsPage())).toEqual({ notFound: true });
  });

  it('C-7: My Transactions stays admitted for an agent', async () => {
    given([brokerageMembership('agent')], ACTIVE);
    expect(await getMyTransactionsGate()).not.toBeNull();
  });
});

describe('the layout', () => {
  async function props(): Promise<Record<string, unknown>> {
    const el = (await DashboardLayout({ children: null })) as { props: Record<string, unknown> };
    return el.props;
  }

  it('broker in a suspended brokerage: orgSuspended, Billing shown, Checklists hidden', async () => {
    given([brokerageMembership('broker')], ACTIVE);
    const p = await props();
    expect({ orgSuspended: p.orgSuspended, suspended: p.suspended, showBilling: p.showBilling, showChecklists: p.showChecklists }).toEqual({
      orgSuspended: true,
      suspended: false,
      showBilling: true,
      showChecklists: false,
    });
  });

  it('C-7 agent: no brokerage nav cut (floor kept), Checklists hidden, My Transactions shown', async () => {
    given([brokerageMembership('agent')], ACTIVE);
    const p = await props();
    expect({ orgSuspended: p.orgSuspended, showChecklists: p.showChecklists, showMyTransactions: p.showMyTransactions }).toEqual({
      orgSuspended: false,
      showChecklists: false,
      showMyTransactions: true,
    });
  });

  it('control: active brokerage -> orgSuspended false, Checklists shown', async () => {
    mockOrgSuspended = false;
    given([brokerageMembership('broker')], ACTIVE);
    const p = await props();
    expect({ orgSuspended: p.orgSuspended, showChecklists: p.showChecklists }).toEqual({ orgSuspended: false, showChecklists: true });
  });
});
