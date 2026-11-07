/**
 * BACKLOG-4168 PR 3 - the invite and resend routes await the email request and report its outcome.
 * Fixtures are transcribed from broker-portal/app/api/email/internal-invite/route.ts:
 *   sent:            200 {success: true, error: undefined}  (serialises to {"success":true})
 *   provider failed: 200 {success: false, error: <result.error>}
 *   wrong secret:    401 {error: 'Unauthorized'}
 *   thrown:          500 {error: 'Internal server error'}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let addResult: { data: unknown; error: unknown };

function table(name: string) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => {
    if (name === 'pending_internal_invitations')
      return { data: { id: 'inv-1', email: 'person@example.test', role_id: 'role-1' }, error: null };
    if (name === 'admin_roles') return { data: { id: 'role-1', slug: 'support-agent', name: 'Support Agent' }, error: null };
    return { data: null, error: null };
  };
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'caller-fixture' } } }) },
    rpc: async (name: string) => (name === 'has_permission' ? { data: true, error: null } : addResult),
    from: (name: string) => table(name),
  }),
}));

const SENT = () => new Response(JSON.stringify({ success: true }), { status: 200 });
const PROVIDER_FAILED = () => new Response(JSON.stringify({ success: false, error: 'provider refused' }), { status: 200 });
const WRONG_SECRET = () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
const SERVER_ERROR = () => new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });

// Not producible by the broker route itself: a gateway answering 503 with a body that reads as success.
const STATUS_ONLY_FAILURE = () => new Response(JSON.stringify({ success: true }), { status: 503 });

const fetchMock = vi.fn();
const logs: string[] = [];

function req(url: string, body: unknown) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) }) as never;
}
const resendReq = () => req('https://admin.test/api/internal-users/resend-invite', { invitationId: 'inv-1' });
const inviteReq = () => req('https://admin.test/api/internal-users/invite', { email: 'person@example.test', role: 'support-agent' });

beforeEach(() => {
  vi.stubEnv('BROKER_PORTAL_URL', 'https://broker.test');
  vi.stubEnv('INTERNAL_API_SECRET', 'secret-fixture');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  logs.length = 0;
  for (const m of ['log', 'error', 'warn'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  addResult = { data: { success: true, user_id: 'user-fixture-1', role: 'support-agent' }, error: null };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resend-invite route', () => {
  it('awaits the email request before responding', async () => {
    let finished = false;
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      return SENT();
    });
    const { POST } = await import('@/app/api/internal-users/resend-invite/route');
    const res = await POST(resendReq());
    expect(finished).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it.each([
    ['provider refused (200 success:false)', PROVIDER_FAILED],
    ['broker 401', WRONG_SECRET],
    ['broker 500', SERVER_ERROR],
    ['503 whose body claims success', STATUS_ONLY_FAILURE],
  ])('%s is a 502 with the short message', async (_n, make) => {
    fetchMock.mockResolvedValue(make());
    const { POST } = await import('@/app/api/internal-users/resend-invite/route');
    const res = await POST(resendReq());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Invite email could not be sent' });
  });

  it('a thrown request is a 502', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { POST } = await import('@/app/api/internal-users/resend-invite/route');
    expect((await POST(resendReq())).status).toBe(502);
  });

  it('missing env vars is a 502 and no request is made', async () => {
    vi.stubEnv('BROKER_PORTAL_URL', '');
    const { POST } = await import('@/app/api/internal-users/resend-invite/route');
    expect((await POST(resendReq())).status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/not configured/);
  });

  it('logs the status code and never the address', async () => {
    fetchMock.mockResolvedValue(SERVER_ERROR());
    const { POST } = await import('@/app/api/internal-users/resend-invite/route');
    await POST(resendReq());
    const out = logs.join('\n');
    expect(out).toContain('500');
    expect(out).not.toContain('person@example.test');
  });
});

describe('invite route', () => {
  it('sent: emailSent true', async () => {
    fetchMock.mockResolvedValue(SENT());
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(inviteReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, outcome: 'assigned', emailSent: true });
  });

  it.each([
    ['provider refused (200 success:false)', PROVIDER_FAILED],
    ['broker 500', SERVER_ERROR],
    ['503 whose body claims success', STATUS_ONLY_FAILURE],
  ])('%s: invite still succeeds with emailSent false', async (_n, make) => {
    fetchMock.mockResolvedValue(make());
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(inviteReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, emailSent: false });
  });

  it('pending invite with a thrown request: still invited, emailSent false', async () => {
    addResult = { data: { success: true, pending: true, email: 'person@example.test', role: 'support-agent' }, error: null };
    fetchMock.mockRejectedValue(new Error('network down'));
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(inviteReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, pending: true, outcome: 'invited', emailSent: false });
  });

  it('the refusal path sends no email', async () => {
    addResult = { data: null, error: { code: '42501', message: 'Not permitted' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    expect((await POST(inviteReq())).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
