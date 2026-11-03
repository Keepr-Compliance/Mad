/**
 * BACKLOG-4107 — POST /api/users/resend-invite: the not-found reply carries only `error`,
 * the lookup is the only organization_members read, the not-found log line carries only the
 * membership id, and the 401/403 guards are unchanged.
 * Mock shape transcribed from __tests__/people-v2-4007/cancelInviteBillingContact.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Op = [string, ...unknown[]];
const queries: { table: string; ops: Op[] }[] = [];
let user: { id: string } | null;
let hasPerm: boolean;
let lookup: { data: unknown; error: { message: string } | null };
const serviceOpts: unknown[] = [];

function table(name: string) {
  const ops: Op[] = [];
  queries.push({ table: name, ops });
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit', 'update']) {
    b[m] = (...args: unknown[]) => { ops.push([m, ...args]); return b; };
  }
  b.maybeSingle = async () => (name === 'organization_members' ? lookup : { data: { name: 'Org' }, error: null });
  b.then = (ok: (_v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'x' }], error: null }).then(ok);
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async () => ({ data: hasPerm, error: null }),
  }),
  createServiceClient: (opts: unknown) => {
    serviceOpts.push(opts);
    return { from: (name: string) => table(name) };
  },
}));

function req(body: unknown) {
  return new Request('https://admin.test/api/users/resend-invite', { method: 'POST', body: JSON.stringify(body) }) as never;
}
const memberQueries = () => queries.filter((q) => q.table === 'organization_members');
const FAKE_CONFIG_VALUE = 'fakeprefix-0123456789abcdef';

beforeEach(() => {
  queries.length = 0;
  serviceOpts.length = 0;
  user = { id: 'staff-1' };
  hasPerm = true;
  lookup = { data: null, error: null };
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_CONFIG_VALUE;
  delete process.env.BROKER_PORTAL_URL;
  delete process.env.INTERNAL_API_SECRET;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resend-invite route (BACKLOG-4107)', () => {
  it('(a) not found: the reply is exactly { error }', async () => {
    const { POST } = await import('@/app/api/users/resend-invite/route');
    const res = await POST(req({ membershipId: 'm-missing' }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body).toEqual({ error: 'Invitation not found' });
  });

  it('(b) not found: organization_members is queried once, by id, with no limit query', async () => {
    const { POST } = await import('@/app/api/users/resend-invite/route');
    await POST(req({ membershipId: 'm-missing' }));
    expect(memberQueries()).toHaveLength(1);
    expect(memberQueries()[0].ops).toContainEqual(['eq', 'id', 'm-missing']);
    expect(queries.some((q) => q.ops.some((o) => o[0] === 'limit'))).toBe(false);
    expect(serviceOpts).toEqual([{ actorId: 'staff-1' }]);
  });

  it('(b2) success path: lookup + update only (two organization_members queries)', async () => {
    lookup = { data: { id: 'm-1', invited_email: 'p@example.test', role: 'agent', organization_id: 'o-1', user_id: null }, error: null };
    const { POST } = await import('@/app/api/users/resend-invite/route');
    const res = await POST(req({ membershipId: 'm-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, emailSent: false });
    expect(memberQueries()).toHaveLength(2);
    expect(memberQueries()[1].ops[0][0]).toBe('update');
    expect(serviceOpts.at(-1)).toEqual({ actorId: 'staff-1' });
  });

  it('(d) not-found logging omits configuration values', async () => {
    const { POST } = await import('@/app/api/users/resend-invite/route');
    await POST(req({ membershipId: 'm-missing' }));
    const logged = JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain(FAKE_CONFIG_VALUE.slice(0, 10));
  });

  it('(f) not-found log line carries exactly the membership id', async () => {
    vi.mocked(console.warn).mockClear();
    vi.mocked(console.log).mockClear();
    const { POST } = await import('@/app/api/users/resend-invite/route');
    await POST(req({ membershipId: 'm-missing' }));
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[resend-invite] Invitation not found:', { membershipId: 'm-missing' }],
    ]);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it('(e) lookup error: 500 with the fixed message only', async () => {
    lookup = { data: null, error: { message: 'permission denied for table organization_members' } };
    const { POST } = await import('@/app/api/users/resend-invite/route');
    const res = await POST(req({ membershipId: 'm-1' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to look up invitation' });
  });

  it('(c1) no session: 401, no service client', async () => {
    user = null;
    const { POST } = await import('@/app/api/users/resend-invite/route');
    const res = await POST(req({ membershipId: 'm-1' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(serviceOpts).toHaveLength(0);
  });

  it('(c2) without users.edit: 403, no service client', async () => {
    hasPerm = false;
    const { POST } = await import('@/app/api/users/resend-invite/route');
    const res = await POST(req({ membershipId: 'm-1' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(serviceOpts).toHaveLength(0);
  });
});
