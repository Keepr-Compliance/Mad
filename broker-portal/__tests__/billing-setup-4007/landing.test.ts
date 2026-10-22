/**
 * @jest-environment node
 *
 * BACKLOG-4007 PR-3 (C-L1, C-L2): a broker/admin of a brokerage that waits for the Billing step
 * lands on the setup guide, BEFORE the Microsoft consent page and before any tenant link
 * (founder 88a1f065: Billing before Connect Microsoft). accept_invitation's success shape is
 * transcribed from supabase/migrations/20261018170000_backlog_3851_invite_without_license.sql:336-343.
 */
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  pendingInvite,
  type Row,
} from '../helpers/postgrestEmulator';
import { SETUP_VIEW_ACTIVE, SETUP_VIEW_WAITING } from './fixtures';

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
import { GET as setupCallback } from '@/app/auth/setup/callback/route';

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'broker-4007@fixture.example.test';
const TENANT = 'fixture-tenant-4007';
const TOKEN = 'fixture0token0for0backlog04007';
const SB = 'sb-fixture-auth-token=abc';

type Rpcs = Partial<Record<string, { data: unknown; error: unknown }>>;
function rpcs(map: Rpcs): void {
  mockRpc.mockImplementation(async (name: string) => map[name] ?? { data: null, error: null });
}
function signedIn(provider: 'email' | 'azure' = 'azure'): void {
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: FIXTURE_USER_ID,
        email: EMAIL,
        app_metadata: { provider },
        user_metadata: provider === 'azure' ? { custom_claims: { tid: TENANT } } : {},
        identities: [{ provider, updated_at: '2026-10-20T12:00:00Z', identity_data: provider === 'azure' ? { custom_claims: { tid: TENANT } } : {} }],
      },
    },
  });
}
function given(rows: Row[], orgs: Row[] = []): void {
  mockEmulator.set({ columnPresent: true, rows: { organization_members: rows, organizations: orgs } });
}
const consentPendingOrg = (tenant: string | null) => [{ id: FIXTURE_BROKERAGE_ORG_ID, graph_admin_consent_granted: false, microsoft_tenant_id: tenant }];
const names = () => mockRpc.mock.calls.map((c) => c[0] as string);

async function go(handler: typeof callback, path: string, cookie = SB): Promise<string> {
  const res = await handler(new Request(`${ORIGIN}${path}?code=fixture-code-4007`, { headers: { cookie } }));
  return res.headers.get('location') ?? '';
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockSignOut.mockResolvedValue({ error: null });
  rpcs({});
});

describe('/auth/callback', () => {
  it('C-L1: a placed admin of a waiting brokerage goes to the guide, not the consent page', async () => {
    signedIn();
    given([brokerageMembership('admin')], consentPendingOrg(TENANT));
    rpcs({ broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null } });
    expect(await go(callback, '/auth/callback')).toBe(`${ORIGIN}/dashboard/setup`);
  });

  it('the same admin once setup is done -> the consent page as before', async () => {
    signedIn();
    given([brokerageMembership('admin')], consentPendingOrg(TENANT));
    rpcs({ broker_get_billing_setup: { data: SETUP_VIEW_ACTIVE, error: null } });
    expect(await go(callback, '/auth/callback')).toContain('/setup/consent');
  });

  it('C-L1b: the invited admin accepts the ONE invitation and lands on the guide', async () => {
    signedIn('email');
    given([pendingInvite(EMAIL, 'admin')]);
    rpcs({
      accept_invitation: {
        data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, user_id: FIXTURE_USER_ID, role: 'admin', license_status: 'active', tenant_linked: false },
        error: null,
      },
      broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null },
    });
    expect(await go(callback, '/auth/callback', `${SB}; keepr_invite=invite.${TOKEN}`)).toBe(`${ORIGIN}/dashboard/setup`);
    // The setup state is read after the acceptance, for the organization it returned.
    expect(names().indexOf('broker_get_billing_setup')).toBeGreaterThan(names().indexOf('accept_invitation'));
    expect(mockRpc).toHaveBeenCalledWith('broker_get_billing_setup', { p_org: FIXTURE_BROKERAGE_ORG_ID });
  });

  it('an invited agent is never asked and lands on next', async () => {
    signedIn('email');
    given([pendingInvite(EMAIL, 'agent')]);
    rpcs({
      accept_invitation: {
        data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, user_id: FIXTURE_USER_ID, role: 'agent', license_status: 'active', tenant_linked: false },
        error: null,
      },
      broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null },
    });
    expect(await go(callback, '/auth/callback', `${SB}; keepr_invite=invite.${TOKEN}`)).toBe(`${ORIGIN}/dashboard`);
    expect(names()).not.toContain('broker_get_billing_setup');
  });
});

describe('/auth/setup/callback', () => {
  const placedAdmin = () => given([{ ...brokerageMembership('admin'), organization_id: FIXTURE_BROKERAGE_ORG_ID }], consentPendingOrg(null));

  it('C-L2: an admin of a waiting brokerage with no tenant -> the guide; no tenant is linked', async () => {
    signedIn();
    placedAdmin();
    rpcs({ broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null } });
    expect(await go(setupCallback, '/auth/setup/callback')).toBe(`${ORIGIN}/dashboard/setup`);
    expect(names()).not.toContain('auto_provision_it_admin');
  });

  it('after setup the same sign-in links the tenant (the guide\'s Connect Microsoft step)', async () => {
    signedIn();
    placedAdmin();
    rpcs({
      broker_get_billing_setup: { data: SETUP_VIEW_ACTIVE, error: null },
      auto_provision_it_admin: { data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, role: 'admin' }, error: null },
    });
    expect(await go(setupCallback, '/auth/setup/callback')).toContain('/setup/consent');
    expect(names()).toContain('auto_provision_it_admin');
  });

  it('an invitation accepted through /setup?token= for a waiting brokerage -> the guide before consent', async () => {
    signedIn();
    given([]);
    rpcs({
      accept_invitation: {
        data: { success: true, organization_id: FIXTURE_BROKERAGE_ORG_ID, user_id: FIXTURE_USER_ID, role: 'admin', license_status: 'active', tenant_linked: true },
        error: null,
      },
      broker_get_billing_setup: { data: SETUP_VIEW_WAITING, error: null },
    });
    expect(await go(setupCallback, '/auth/setup/callback', `${SB}; keepr_invite=setup.${TOKEN}`)).toBe(`${ORIGIN}/dashboard/setup`);
  });
});
