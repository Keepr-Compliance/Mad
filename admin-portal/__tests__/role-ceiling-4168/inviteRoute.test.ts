/**
 * BACKLOG-4168 — POST /api/internal-users/invite goes through admin_add_internal_user only.
 * The RPC assigns the role or records the invitation itself; the route never touches
 * pending_internal_invitations. Result shapes are transcribed from the RETURN statements of
 * migration 20261107100000 (admin_add_internal_user):
 *   RETURN jsonb_build_object('success', true, 'pending', true, 'email', v_email, 'role', p_role);
 *   RETURN jsonb_build_object('success', true, 'user_id', v_target_user_id, 'role', p_role);
 * and its single refusal: RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501'.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { kind: 'rpc' | 'from'; name: string; args?: unknown; op?: string };
const calls: Call[] = [];
let addResult: { data: unknown; error: { code?: string; message: string } | null };

function table(name: string) {
  const b: Record<string, unknown> = {};
  const record = (op: string) => () => { calls.push({ kind: 'from', name, op }); return b; };
  b.select = record('select');
  b.insert = record('insert');
  b.upsert = record('upsert');
  b.update = record('update');
  b.delete = record('delete');
  b.eq = () => b;
  b.maybeSingle = async () =>
    name === 'admin_roles'
      ? { data: { id: 'role-fixture-1', slug: 'support-agent' }, error: null }
      : { data: null, error: null };
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'caller-fixture' } } }) },
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

const PENDING = { success: true, pending: true, email: 'person@example.test', role: 'support-agent' };
const ASSIGNED = { success: true, user_id: 'user-fixture-1', role: 'support-agent' };
const REFUSED = { code: '42501', message: 'Not permitted' };

beforeEach(() => {
  calls.length = 0;
  addResult = { data: ASSIGNED, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const invitationCalls = () => calls.filter((c) => c.kind === 'from' && c.name === 'pending_internal_invitations');

describe('internal user invite route (BACKLOG-4168)', () => {
  it('assigned: 200 with the user and role, one RPC call with the normalised email', async () => {
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: ' Person@Example.test ', role: 'support-agent' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, outcome: 'assigned', user_id: 'user-fixture-1' });
    expect(calls.filter((c) => c.name === 'admin_add_internal_user').map((c) => c.args))
      .toEqual([{ p_email: 'person@example.test', p_role: 'support-agent' }]);
    expect(invitationCalls()).toEqual([]);
  });

  it('pending: 200 with an invited outcome and no table write from the route', async () => {
    addResult = { data: PENDING, error: null };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, pending: true, outcome: 'invited' });
    expect(invitationCalls()).toEqual([]);
  });

  it('42501 is a 403 with the one generic message', async () => {
    addResult = { data: null, error: REFUSED };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/^Not permitted/);
    expect(body.error).not.toContain('person@example.test');
    expect(invitationCalls()).toEqual([]);
  });

  it('a P0002 error is a plain failure, never an invitation written by the route', async () => {
    addResult = { data: null, error: { code: 'P0002', message: 'No user found' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(500);
    expect(invitationCalls()).toEqual([]);
  });

  it('any other RPC error is a 500 that does not echo the database message', async () => {
    addResult = { data: null, error: { code: 'XX000', message: 'internal detail' } };
    const { POST } = await import('@/app/api/internal-users/invite/route');
    const res = await POST(req({ email: 'person@example.test', role: 'support-agent' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain('internal detail');
  });

  it('the route source names no invitation table (static check)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/api/internal-users/invite/route.ts'), 'utf8');
    expect(src).not.toMatch(/pending_internal_invitations/);
    expect(src).not.toMatch(/P0002/);
  });
});
