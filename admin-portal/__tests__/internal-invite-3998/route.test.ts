/**
 * BACKLOG-3998 — POST /api/internal-users/invite assigns the role through
 * admin_add_internal_user (which matches the account's sign-in email) and falls back
 * to a pending invitation only when the RPC reports SQLSTATE P0002. The RPC error
 * shapes are the ones PostgREST returns for the migration's RAISE statements.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { kind: 'rpc' | 'from'; name: string; args?: unknown; op?: string; payload?: unknown };
const calls: Call[] = [];
let addResult: { data: unknown; error: { code?: string; message: string } | null };
let pendingInvite: unknown = null;

function table(name: string) {
  const b: Record<string, unknown> = {};
  b.select = (cols: string) => { calls.push({ kind: 'from', name, op: 'select', args: cols }); return b; };
  b.eq = () => b;
  b.maybeSingle = async () =>
    name === 'admin_roles'
      ? { data: { id: 'role-1', slug: 'support-agent' }, error: null }
      : name === 'pending_internal_invitations'
        ? { data: pendingInvite, error: null }
        : { data: null, error: null };
  b.insert = async (payload: unknown) => { calls.push({ kind: 'from', name, op: 'insert', payload }); return { error: null }; };
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'caller-1' } } }) },
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: 'rpc', name, args });
      if (name === 'has_permission') return { data: true, error: null };
      return addResult;
    },
    from: (name: string) => table(name),
  }),
}));

function req(body: unknown) {
  return new Request('https://admin.test/api/internal-users/invite', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  calls.length = 0;
  pendingInvite = null;
  addResult = { data: { success: true, user_id: 'u-1', role: 'support-agent' }, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('internal user invite route (BACKLOG-3998)', () => {
  it('assigns the role through the RPC and never looks the address up in users', async () => {
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: ' Person@Example.test ', role: 'support-agent' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, user_id: 'u-1' });
    expect(calls.find((c) => c.kind === 'rpc' && c.name === 'admin_add_internal_user')?.args)
      .toEqual({ p_email: 'person@example.test', p_role: 'support-agent' });
    expect(calls.some((c) => c.kind === 'from' && c.name === 'users')).toBe(false);
    expect(calls.some((c) => c.name === 'pending_internal_invitations')).toBe(false);
  });

  it('P0002 (no account with this sign-in email) creates a pending invitation', async () => {
    addResult = { data: null, error: { code: 'P0002', message: 'No user found with email: person@example.test' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, pending: true });
    expect(calls.find((c) => c.op === 'insert')).toMatchObject({
      name: 'pending_internal_invitations',
      payload: { email: 'person@example.test', role_id: 'role-1', invited_by: 'caller-1' },
    });
  });

  it('the not-found message without P0002 is an error, not an invitation', async () => {
    addResult = { data: null, error: { code: 'P0001', message: 'No user found with email: person@example.test' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(500);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('more than one account with the address is refused, not invited', async () => {
    addResult = { data: null, error: { code: 'P0001', message: 'More than one account has email: person@example.test' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(500);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('an existing internal role is a 409', async () => {
    addResult = { data: null, error: { code: 'P0001', message: 'User already has an internal role' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(409);
  });
});
