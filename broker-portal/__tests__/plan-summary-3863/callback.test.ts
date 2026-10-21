/**
 * @jest-environment node
 *
 * BACKLOG-3863 PR-2 (SR R7): /auth/callback lands on the post-login path cookie that
 * middleware set, re-validated, and clears it on every exit. It replaces only the
 * /dashboard default: the setup guide and the consent page still decide first.
 * Harness and fixtures as __tests__/billing-setup-4007/landing.test.ts.
 */
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  type Row,
} from '../helpers/postgrestEmulator';
import { SETUP_VIEW_ACTIVE, SETUP_VIEW_WAITING } from '../billing-setup-4007/fixtures';
import { NEXT_PATH_COOKIE_NAME } from '@/lib/auth/safeNextPath';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSignOut = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession, getUser: mockGetUser, signOut: mockSignOut },
    rpc: mockRpc,
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { GET as callback } from '@/app/auth/callback/route';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'agent-3863@fixture.example.test';
const SB = 'sb-fixture-auth-token=abc';
const nextCookie = (v: string) => `${SB}; ${NEXT_PATH_COOKIE_NAME}=${encodeURIComponent(v)}`;

function rpcs(map: Partial<Record<string, { data: unknown; error: unknown }>>): void {
  mockRpc.mockImplementation(async (name: string) => map[name] ?? { data: null, error: null });
}
function signedIn(): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: { user: { id: FIXTURE_USER_ID, email: EMAIL, app_metadata: { provider: 'email' }, user_metadata: {}, identities: [] } },
  });
}
function given(rows: Row[], orgs: Row[] = []): void {
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows, organizations: orgs } });
}

async function go(cookie: string, query = '?code=fixture-code-3863'): Promise<Response> {
  return callback(new Request(`${ORIGIN}/auth/callback${query}`, { headers: { cookie } }));
}
const loc = (r: Response) => r.headers.get('location') ?? '';
function clearsCookie(r: Response): boolean {
  const c = r.headers.getSetCookie().find((h) => h.startsWith(`${NEXT_PATH_COOKIE_NAME}=`));
  return !!c && /path=\/auth/i.test(c) && /expires=thu, 01 jan 1970|max-age=0/i.test(c);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockSignOut.mockResolvedValue({ error: null });
  rpcs({});
});

describe('the cookie replaces the /dashboard default', () => {
  it('placed agent with /dashboard/billing -> /dashboard/billing, cookie cleared', async () => {
    signedIn();
    given([{ ...brokerageMembership('agent'), license_status: 'active' }]);
    const r = await go(nextCookie('/dashboard/billing'));
    expect(loc(r)).toBe(`${ORIGIN}/dashboard/billing`);
    expect(clearsCookie(r)).toBe(true);
  });

  it('no cookie -> /dashboard', async () => {
    signedIn();
    given([{ ...brokerageMembership('agent'), license_status: 'active' }]);
    expect(loc(await go(SB))).toBe(`${ORIGIN}/dashboard`);
  });

  it.each(['//evil.test', '/\\evil.test', '/settings', '/dashboard/../admin'])(
    'an unsafe cookie value %s -> /dashboard on this origin, cookie cleared',
    async (raw) => {
      signedIn();
      given([{ ...brokerageMembership('agent'), license_status: 'active' }]);
      const r = await go(nextCookie(raw));
      expect(loc(r)).toBe(`${ORIGIN}/dashboard`);
      expect(clearsCookie(r)).toBe(true);
    }
  );

  it('a ?next= query parameter is not read', async () => {
    signedIn();
    given([{ ...brokerageMembership('agent'), license_status: 'active' }]);
    expect(loc(await go(SB, '?code=fixture-code-3863&next=%2Fdashboard%2Fbilling'))).toBe(`${ORIGIN}/dashboard`);
  });
});

describe('earlier branches keep precedence', () => {
  it('admin of a waiting brokerage -> setup guide, not the cookie', async () => {
    signedIn();
    given([brokerageMembership('admin')]);
    rpcs({ broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null } });
    const r = await go(nextCookie('/dashboard/billing'));
    expect(loc(r)).toBe(`${ORIGIN}/dashboard/setup`);
    expect(clearsCookie(r)).toBe(true);
  });

  it('admin with consent pending -> consent page, not the cookie', async () => {
    signedIn();
    given([brokerageMembership('admin')], [
      { id: FIXTURE_BROKERAGE_ORG_ID, graph_admin_consent_granted: false, microsoft_tenant_id: 'fixture-tenant-3863' },
    ]);
    rpcs({ broker_get_billing_setup: { data: SETUP_VIEW_ACTIVE, error: null } });
    expect(loc(await go(nextCookie('/dashboard/billing')))).toContain('/setup/consent');
  });

  it('a failed exchange -> /login error, cookie cleared', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: 'bad code' } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await go(nextCookie('/dashboard/billing'));
    expect(loc(r)).toBe(`${ORIGIN}/login?error=auth_failed`);
    expect(clearsCookie(r)).toBe(true);
  });
});
