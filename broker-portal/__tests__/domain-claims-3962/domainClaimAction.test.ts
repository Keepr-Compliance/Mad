/**
 * @jest-environment node
 */
/**
 * BACKLOG-3962 R2 and task control (b) at the portal: who reaches the domain claim functions,
 * on which client, and with which organization.
 *
 * The real requireDomainClaimAccess and requireActiveOrgRole run; only the session read
 * (getPortalAccess), the two Supabase clients and fetch are faked. The fake server-role client
 * answers _domain_claim_begin_check the way the SQL does (supabase/migrations/
 * 20261112100000_backlog_3962_domain_claims.sql): a claim not in p_org -> claim_not_found.
 * Reply shapes are transcribed from that function's RETURN jsonb_build_object lines.
 */

const mockBlock = jest.fn();
const mockGetPortalAccess = jest.fn();
const mockCreateServiceClient = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a) }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: () => mockGetPortalAccess() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: (o: unknown) => mockCreateServiceClient(o) }));

import { checkDomainClaim, createDomainClaim, withdrawDomainClaim } from '@/lib/actions/domainClaim';
import { DOMAIN_CLAIM_NOT_AUTHORIZED, DOMAIN_CLAIM_NOT_FOUND, DOMAIN_CLAIM_TOO_SOON, DOMAIN_CLAIM_UNAVAILABLE } from '@/lib/domain/claims';

const USER = 'user-a';
const ORG_A = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const ORG_B = '00000000-0000-4000-8000-00000000000b'; // pii-allow-uuid: invented fixture id
const CLAIM_A = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id
const CLAIM_B = '00000000-0000-4000-8000-0000000000c2'; // pii-allow-uuid: invented fixture id
const TOKEN_A = 'keepr-domain-verification=' + 'a'.repeat(48);

const CLAIMS: Record<string, { org: string; domain: string }> = {
  [CLAIM_A]: { org: ORG_A, domain: 'a-brokerage.example' },
  [CLAIM_B]: { org: ORG_B, domain: 'b-brokerage.example' },
};

interface World {
  role?: string;
  kind?: string;
  rowRole?: string | null;
  licence?: string;
  suspended?: boolean;
  beginReply?: { data: unknown; error: unknown };
}

let sessionRpc: jest.Mock;
let serviceRpc: jest.Mock;
let fetchMock: jest.Mock;

function given(w: World = {}) {
  const role = w.role ?? 'admin';
  sessionRpc = jest.fn(async (fn: string) => {
    if (fn === 'domain_claim_create') {
      return { data: { success: true, existing: false, claim_id: CLAIM_A, status: 'pending' }, error: null };
    }
    if (fn === 'domain_claim_withdraw') return { data: { success: true, status: 'withdrawn' }, error: null };
    return { data: null, error: { code: 'PGRST202' } };
  });
  const session = {
    rpc: sessionRpc,
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'licenses') return { data: { status: w.licence ?? 'active' }, error: null };
        if (table === 'organization_members') {
          const rowRole = w.rowRole === undefined ? role : w.rowRole;
          return rowRole && eqs.organization_id === ORG_A && eqs.user_id === USER
            ? { data: { role: rowRole, license_status: 'active' }, error: null }
            : { data: null, error: null };
        }
        return { data: null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          eqs[c] = v;
          return b;
        },
        maybeSingle: async () => answer(),
        single: async () => answer(),
      };
      return b;
    },
  };
  mockGetPortalAccess.mockResolvedValue({
    supabase: session,
    user: { id: USER },
    access: { kind: w.kind ?? 'full', role, organizationId: ORG_A },
    suspended: w.suspended ?? false,
    orgSuspended: false,
  });

  serviceRpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === '_domain_claim_begin_check') {
      if (w.beginReply) return w.beginReply;
      const c = CLAIMS[args.p_claim as string];
      if (!c || c.org !== args.p_org) return { data: { success: false, error: 'claim_not_found' }, error: null };
      return { data: { success: true, domain: c.domain }, error: null };
    }
    if (fn === '_domain_claim_record_check') {
      const hit = (args.p_answers as string[]).includes(TOKEN_A) && args.p_claim === CLAIM_A;
      return { data: { success: true, result: hit ? 'verified' : 'not_found', status: hit ? 'verified' : 'pending' }, error: null };
    }
    return { data: null, error: { code: 'PGRST202' } };
  });
  mockCreateServiceClient.mockReturnValue({ rpc: serviceRpc });

  fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.startsWith('https://cloudflare-dns.com')
        ? { Status: 0, Answer: [{ name: '_keepr.a-brokerage.example', type: 16, data: `"${TOKEN_A}"` }] }
        : { Status: 0, Answer: [{ name: '_keepr.a-brokerage.example.', type: 16, data: TOKEN_A }] },
  }));
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
}

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockGetPortalAccess.mockReset();
  mockCreateServiceClient.mockReset();
  mockCaptureMessage.mockReset();
});

describe('checkDomainClaim', () => {
  it.each(['admin', 'it_admin'])('%s: begin_check gets the SESSION org, DoH is queried, record_check is manual', async (role) => {
    given({ role });
    const res = await checkDomainClaim(CLAIM_A);
    expect(res).toMatchObject({ success: true, result: 'verified', status: 'verified' });
    expect(serviceRpc).toHaveBeenCalledWith('_domain_claim_begin_check', { p_claim: CLAIM_A, p_org: ORG_A });
    expect(serviceRpc).toHaveBeenCalledWith('_domain_claim_record_check', {
      p_claim: CLAIM_A,
      p_org: ORG_A,
      p_answers: [TOKEN_A],
      p_resolver_ok: true,
      p_source: 'manual',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockCreateServiceClient).toHaveBeenCalledWith({ actorId: USER });
  });

  it("R2: an admin of org A checking org B's claim is refused and no DNS lookup runs", async () => {
    given();
    const res = await checkDomainClaim(CLAIM_B);
    expect(res).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_FOUND });
    expect(serviceRpc).toHaveBeenCalledWith('_domain_claim_begin_check', { p_claim: CLAIM_B, p_org: ORG_A });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(serviceRpc).not.toHaveBeenCalledWith('_domain_claim_record_check', expect.anything());
  });

  it('C8: too_soon from the database stops before any DNS lookup', async () => {
    given({ beginReply: { data: { success: false, error: 'too_soon' }, error: null } });
    expect(await checkDomainClaim(CLAIM_A)).toEqual({ success: false, message: DOMAIN_CLAIM_TOO_SOON });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['agent', {}],
    ['broker', {}],
    ['admin on a floor session', { kind: 'floor' }],
    ['admin whose row in the org is gone', { rowRole: null }],
    ['admin with a suspended licence', { licence: 'suspended' }],
    ['admin with a suspended account', { suspended: true }],
  ])('(b) %s is refused before the server-role client exists', async (label, extra) => {
    const role = label === 'agent' || label === 'broker' ? label : 'admin';
    given({ role, ...(extra as World) });
    expect(await checkDomainClaim(CLAIM_A)).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_AUTHORIZED });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed out is refused', async () => {
    given();
    mockGetPortalAccess.mockResolvedValue(null);
    expect(await checkDomainClaim(CLAIM_A)).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_AUTHORIZED });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('a support session is refused before anything is read', async () => {
    given();
    mockBlock.mockResolvedValue({ error: 'Read-only' });
    expect(await checkDomainClaim(CLAIM_A)).toEqual({ success: false, message: 'Read-only' });
    expect(mockGetPortalAccess).not.toHaveBeenCalled();
  });

  it('a claim id that is not a uuid never reaches the database', async () => {
    given();
    expect(await checkDomainClaim("x' or 1=1")).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_FOUND });
    expect(mockGetPortalAccess).not.toHaveBeenCalled();
  });

  it('the function not deployed yet reads as unavailable', async () => {
    given({ beginReply: { data: null, error: { code: 'PGRST202' } } });
    expect(await checkDomainClaim(CLAIM_A)).toEqual({ success: false, message: DOMAIN_CLAIM_UNAVAILABLE });
  });
});

describe('createDomainClaim', () => {
  it('normalises, then calls domain_claim_create on the SESSION client with the session org', async () => {
    given();
    const res = await createDomainClaim('  A-Brokerage.Example. ');
    expect(res.success).toBe(true);
    expect(sessionRpc).toHaveBeenCalledWith('domain_claim_create', { p_org: ORG_A, p_domain: 'a-brokerage.example' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('an invalid domain never reaches the database', async () => {
    given();
    const res = await createDomainClaim('https://a-brokerage.example/x');
    expect(res.success).toBe(false);
    expect(mockGetPortalAccess).not.toHaveBeenCalled();
  });

  it.each(['agent', 'broker'])('(b) %s is refused', async (role) => {
    given({ role });
    expect(await createDomainClaim('a-brokerage.example')).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_AUTHORIZED });
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});

describe('withdrawDomainClaim', () => {
  it('admin: domain_claim_withdraw on the session client', async () => {
    given();
    expect((await withdrawDomainClaim(CLAIM_A)).success).toBe(true);
    expect(sessionRpc).toHaveBeenCalledWith('domain_claim_withdraw', { p_claim: CLAIM_A });
  });

  it('(b) agent is refused', async () => {
    given({ role: 'agent' });
    expect(await withdrawDomainClaim(CLAIM_A)).toEqual({ success: false, message: DOMAIN_CLAIM_NOT_AUTHORIZED });
    expect(sessionRpc).not.toHaveBeenCalled();
  });
});
