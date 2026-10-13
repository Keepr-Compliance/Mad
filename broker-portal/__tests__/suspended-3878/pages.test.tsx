/**
 * The pages refuse a suspended account on their own — BACKLOG-3878 (C1 page
 * side, R1 "each gate red on its own", R11, R12).
 *
 * Middleware is bypassed: every page, gate and the layout run for real against
 * the PostgREST emulator, so removing the middleware check leaves these red
 * and removing a page check leaves __tests__/suspended-3878/middleware.test.ts
 * red. Suspended is the caller's own `licenses` row with
 * `status = 'suspended'` (both suspension writers, prod catalog 2026-10-13).
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
      fn === 'can_edit_checklist_templates' ? { data: true, error: null } : { data: ORG_WITHOUT_PLAN_FEATURES, error: null }
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

const SUSPENDED: Row = { user_id: FIXTURE_USER_ID, status: 'suspended' };
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
  process.env.BILLING_ENABLED = 'true';
  (getImpersonationSession as jest.Mock).mockResolvedValue(null);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe('/dashboard (home) refuses a suspended account on its own', () => {
  it.each([
    ['personal owner, billing on', [personalMembership()], 'true', '/dashboard/billing'],
    ['personal owner, billing off', [personalMembership()], 'false', '/dashboard/account'],
    ['brokerage agent', [brokerageMembership('agent')], 'true', '/dashboard/account'],
    ['brokerage broker', [brokerageMembership('broker')], 'true', '/dashboard/account'],
    ['brokerage it_admin', [brokerageMembership('it_admin')], 'true', '/dashboard/account'],
  ] as [string, Row[], string, string][])('%s -> %s, before any submission is read', async (_n, rows, flag, to) => {
    process.env.BILLING_ENABLED = flag;
    given(rows, SUSPENDED);
    expect(await run(() => DashboardPage())).toEqual({ redirect: to });
    expect(mockEmulator.state.selects.map((s) => s.table)).not.toContain('transaction_submissions');
  });

  it('control: the same personal owner with an active licence gets the floor view', async () => {
    given([personalMembership()], ACTIVE);
    const out = await run(() => DashboardPage());
    expect('element' in out).toBe(true);
    const { container } = render((out as { element: React.ReactElement }).element);
    expect(container.textContent).toContain('Your Keepr account');
  });

  it('C1b: licence read fails -> the floor view (fail open), static code logged', async () => {
    given([personalMembership()], SUSPENDED, true);
    const out = await run(() => DashboardPage());
    expect('element' in out).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith('[portalAccess] suspended check skipped', { code: 'licence_read_failed' });
  });

  it('R11: a support session whose target is suspended is not redirected and reads no licence', async () => {
    (getImpersonationSession as jest.Mock).mockResolvedValue({
      session_id: 's-3878',
      target_user_id: FIXTURE_USER_ID,
      admin_user_id: 'admin-3878',
      target_email: 'suspended-3878@fixture.example.test',
    });
    given([brokerageMembership('broker')], SUSPENDED);
    const out = await run(() => DashboardPage());
    expect('element' in out).toBe(true);
    expect(mockEmulator.state.selects.map((s) => s.table)).not.toContain('licenses');
  });
});

describe('the layout', () => {
  async function props(): Promise<Record<string, unknown>> {
    const el = (await DashboardLayout({ children: null })) as { props: Record<string, unknown> };
    return el.props;
  }

  it.each([
    ['suspended personal owner', [personalMembership()], SUSPENDED, { suspended: true, showBilling: true }],
    ['suspended brokerage broker (the brokerage bill is not theirs)', [brokerageMembership('broker')], SUSPENDED, { suspended: true, showBilling: false }],
    ['active brokerage broker (control)', [brokerageMembership('broker')], ACTIVE, { suspended: false, showBilling: true }],
  ] as [string, Row[], Row, Record<string, boolean>][])('%s', async (_n, rows, licence, want) => {
    given(rows, licence);
    const p = await props();
    expect({ suspended: p.suspended, showBilling: p.showBilling }).toEqual(want);
  });

  it('R11: impersonating -> suspended false, no redirect, no licence read', async () => {
    (getImpersonationSession as jest.Mock).mockResolvedValue({ session_id: 's', target_user_id: FIXTURE_USER_ID, admin_user_id: 'a' });
    given([brokerageMembership('broker')], SUSPENDED);
    const p = await props();
    expect(p.suspended).toBe(false);
    expect(mockEmulator.state.selects.map((s) => s.table)).not.toContain('licenses');
  });
});

describe('full-portal gates refuse a suspended account', () => {
  it('requireFullPortalAccess: suspended broker -> null; active broker -> admitted', async () => {
    given([brokerageMembership('broker')], SUSPENDED);
    expect(await requireFullPortalAccess()).toBeNull();
    given([brokerageMembership('broker')], ACTIVE);
    expect(await requireFullPortalAccess()).not.toBeNull();
  });

  it('requireFullPortalAccess: licence read fails -> admitted (fail open)', async () => {
    given([brokerageMembership('broker')], SUSPENDED, true);
    expect(await requireFullPortalAccess()).not.toBeNull();
  });

  it('checkOrgSettingsAccess: suspended admin -> unauthorized; active admin -> allowed', async () => {
    given([brokerageMembership('admin')], SUSPENDED);
    expect(await checkOrgSettingsAccess()).toEqual({ allowed: false, reason: 'unauthorized' });
    given([brokerageMembership('admin')], ACTIVE);
    expect((await checkOrgSettingsAccess()).allowed).toBe(true);
  });

  it('Org Settings page: suspended admin -> /dashboard (which forwards: R12 2 hops)', async () => {
    given([brokerageMembership('admin')], SUSPENDED);
    expect(await run(() => OrgSettingsPage())).toEqual({ redirect: '/dashboard' });
    given([brokerageMembership('admin')], SUSPENDED);
    expect(await run(() => DashboardPage())).toEqual({ redirect: '/dashboard/account' });
  });

  it('Users page: suspended admin -> /dashboard; it reads no member list', async () => {
    given([brokerageMembership('admin')], SUSPENDED);
    expect(await run(() => UsersPage())).toEqual({ redirect: '/dashboard' });
    expect(mockEmulator.state.selects.filter((s) => s.table === 'organization_members').length).toBe(1);
  });

  it('My Transactions gate: suspended agent -> null; active agent -> the plan message (upsell)', async () => {
    given([brokerageMembership('agent')], SUSPENDED);
    expect(await getMyTransactionsGate()).toBeNull();
    given([brokerageMembership('agent')], ACTIVE);
    expect(await getMyTransactionsGate()).toEqual({ kind: 'upsell' });
  });
});

describe('Checklists page (R3, fail closed)', () => {
  it('active personal owner -> the page renders (control)', async () => {
    given([personalMembership()], ACTIVE);
    expect('element' in (await run(() => ChecklistsPage()))).toBe(true);
  });

  it.each([
    ['suspended personal owner', SUSPENDED, false],
    ['licence read fails', ACTIVE, true],
  ] as [string, Row, boolean][])('%s -> notFound, no template read', async (_n, licence, fails) => {
    given([personalMembership()], licence, fails);
    expect(await run(() => ChecklistsPage())).toEqual({ notFound: true });
    expect(mockEmulator.state.selects.map((s) => s.table)).not.toContain('checklist_templates');
  });
});
