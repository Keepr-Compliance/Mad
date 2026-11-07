/**
 * BACKLOG-4168 — /auth/callback accepts an internal invitation only through
 * admin_accept_internal_invitation (service role), called after the public.users row exists.
 * Result shapes transcribed from migration 20261107100000 (admin_accept_internal_invitation):
 *   RETURN jsonb_build_object('success', true, 'assigned', false);
 *   RETURN jsonb_build_object('success', true, 'assigned', true, 'user_id', p_user_id, 'role', v_slug);
 * and its refusal: RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  log: [] as string[],
  invitation: { id: 'inv-fixture-1' } as unknown,
  existingUser: null as unknown,
  accept: { data: null as unknown, error: null as unknown },
  roleRows: new Set<string>(),
  signedOut: 0,
}));

function serviceTable(name: string) {
  const b: Record<string, unknown> = {};
  b.select = () => { s.log.push(`svc.from(${name}).select`); return b; };
  b.eq = () => b;
  b.maybeSingle = async () => ({
    data: name === 'pending_internal_invitations' ? s.invitation : name === 'users' ? s.existingUser : null,
    error: null,
  });
  b.single = b.maybeSingle;
  b.insert = async () => { s.log.push(`svc.from(${name}).insert`); return { error: null }; };
  b.delete = () => { s.log.push(`svc.from(${name}).delete`); return b; };
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      signOut: async () => { s.signedOut++; return { error: null }; },
      getUser: async () => ({
        data: { user: { id: 'user-fixture-1', email: 'Person@Example.test', app_metadata: { provider: 'azure' } } },
      }),
    },
    rpc: async (fn: string, args: { p_action?: string; p_metadata?: Record<string, unknown> }) => {
      if (fn === 'log_admin_action') s.log.push(`audit:${args.p_action}:${String(args.p_metadata?.reason ?? '')}`);
      return { data: null, error: null };
    },
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () => ({ data: s.roleRows.has('user-fixture-1') ? { role_id: 'r-1' } : null, error: null });
      return b;
    },
  }),
  createServiceClient: () => ({
    from: (name: string) => serviceTable(name),
    rpc: async (fn: string, args: unknown) => {
      s.log.push(`svc.rpc:${fn}:${JSON.stringify(args)}`);
      const res = s.accept as { data: { assigned?: boolean } | null; error: unknown };
      if (fn === 'admin_accept_internal_invitation' && !res.error && res.data?.assigned) s.roleRows.add('user-fixture-1');
      return res;
    },
  }),
}));

import { GET } from '@/app/auth/callback/route';

const call = () => GET(new Request('https://admin.test/auth/callback?code=fixture-code'));

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  s.log = [];
  s.invitation = { id: 'inv-fixture-1' };
  s.existingUser = null;
  s.accept = { data: { success: true, assigned: true, user_id: 'user-fixture-1', role: 'support-agent' }, error: null };
  s.roleRows = new Set();
  s.signedOut = 0;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

const ACCEPT = 'svc.rpc:admin_accept_internal_invitation:{"p_user_id":"user-fixture-1","p_email":"person@example.test"}';

describe('auth callback invitation accept (BACKLOG-4168)', () => {
  it('calls the accept RPC with the user id and lowercased email, after the users insert', async () => {
    const res = await call();
    const usersInsert = s.log.indexOf('svc.from(users).insert');
    const accept = s.log.indexOf(ACCEPT);
    expect(usersInsert).toBeGreaterThanOrEqual(0);
    expect(accept).toBeGreaterThan(usersInsert);
    expect(res.headers.get('location')).toBe('https://admin.test/dashboard');
  });

  it('never writes internal_roles or the invitation table itself', async () => {
    await call();
    expect(s.log.filter((l) => /svc\.from\((internal_roles|admin_roles)\)/.test(l))).toEqual([]);
    expect(s.log).not.toContain('svc.from(pending_internal_invitations).delete');
  });

  it('a refusal assigns no role, is logged, and the user is signed out', async () => {
    s.accept = { data: null, error: { code: '42501', message: 'Not permitted' } };
    const res = await call();
    expect(s.roleRows.size).toBe(0);
    expect(res.headers.get('location')).toBe('https://admin.test/login?error=not_authorized');
    expect(s.signedOut).toBe(1);
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Invitation not accepted') && c[1] === '42501')).toBe(true);
    expect(s.log).toContain('audit:auth.login_denied:invitation_not_accepted');
  });

  it('an existing internal user with a stale invitation: refusal keeps the role and the login', async () => {
    s.roleRows.add('user-fixture-1');
    s.existingUser = { id: 'user-fixture-1' };
    s.accept = { data: null, error: { code: '42501', message: 'Not permitted' } };
    const res = await call();
    expect(s.log).toContain(ACCEPT);
    expect(s.roleRows.has('user-fixture-1')).toBe(true);
    expect(s.signedOut).toBe(0);
    expect(res.headers.get('location')).toBe('https://admin.test/dashboard');
  });

  it('no invitation: no users insert, no RPC, denied as before', async () => {
    s.invitation = null;
    const res = await call();
    expect(s.log.some((l) => l.startsWith('svc.rpc:'))).toBe(false);
    expect(s.log).not.toContain('svc.from(users).insert');
    expect(res.headers.get('location')).toBe('https://admin.test/login?error=not_authorized');
    expect(s.log).toContain('audit:auth.login_denied:no_internal_role');
  });

  it('{assigned:false} keeps the no-invitation behaviour', async () => {
    s.accept = { data: { success: true, assigned: false }, error: null };
    const res = await call();
    expect(res.headers.get('location')).toBe('https://admin.test/login?error=not_authorized');
    expect(s.log).toContain('audit:auth.login_denied:no_internal_role');
  });

  it('an existing users row is not inserted again', async () => {
    s.existingUser = { id: 'user-fixture-1' };
    await call();
    expect(s.log).not.toContain('svc.from(users).insert');
    expect(s.log).toContain(ACCEPT);
  });
});
