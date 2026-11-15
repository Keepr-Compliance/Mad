/**
 * BACKLOG-3962 PR2 — revokeDomainClaimAction.
 * The discriminator is the number of admin_revoke_domain_claim calls and which client made them.
 * Reply shapes are transcribed from admin_revoke_domain_claim's RETURN jsonb_build_object lines in
 * supabase/migrations/20261112100000_backlog_3962_domain_claims.sql.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { client: 'session' | 'service'; kind: 'rpc' | 'from'; name: string; args?: Record<string, unknown> };
const calls: Call[] = [];
const state: {
  user: { id: string } | null;
  perms: string[];
  permError: unknown;
  revokeReply: { data: unknown; error: unknown };
  serviceClients: number;
} = { user: { id: 'u1' }, perms: [], permError: null, revokeReply: { data: null, error: null }, serviceClients: 0 };

function fakeClient(client: 'session' | 'service') {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ client, kind: 'rpc', name, args });
      if (name === 'has_permission') {
        if (state.permError) return { data: null, error: state.permError };
        return { data: state.perms.includes(String(args.required_permission)), error: null };
      }
      if (name === 'admin_revoke_domain_claim') return state.revokeReply;
      return { data: null, error: { code: 'XX000', message: 'unexpected rpc ' + name } };
    },
    from: (name: string) => {
      calls.push({ client, kind: 'from', name });
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'insert', 'delete', 'upsert', 'eq', 'single']) chain[m] = () => chain;
      return chain;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: state.user, supabase: fakeClient('session') }),
  createClient: async () => fakeClient('session'),
  createServiceClient: () => {
    state.serviceClients += 1;
    return fakeClient('service');
  },
}));

const ORG = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id
const CLAIM = '00000000-0000-4000-8000-0000000000c1'; // pii-allow-uuid: invented fixture id

const revokes = () => calls.filter((c) => c.kind === 'rpc' && c.name === 'admin_revoke_domain_claim');

describe('revokeDomainClaimAction', () => {
  beforeEach(() => {
    calls.length = 0;
    state.user = { id: 'u1' };
    state.perms = ['organizations.view', 'organizations.edit'];
    state.permError = null;
    state.revokeReply = { data: { success: true, claim_id: CLAIM, status: 'revoked' }, error: null };
    state.serviceClients = 0;
  });

  it('refuses a view-only staff member (organizations.view, not .edit) and makes no revoke call', async () => {
    state.perms = ['organizations.view'];
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    const res = await revokeDomainClaimAction(ORG, CLAIM, 'support request');
    expect(res).toEqual({ ok: false, error: 'You need permission to edit organizations to revoke a domain.' });
    expect(revokes()).toHaveLength(0);
    expect(calls.find((c) => c.name === 'has_permission')?.args).toEqual({
      check_user_id: 'u1',
      required_permission: 'organizations.edit',
    });
  });

  it('refuses and makes no revoke call when the permission check fails', async () => {
    state.permError = { code: 'XX000', message: 'raw' };
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    expect((await revokeDomainClaimAction(ORG, CLAIM, 'support request')).ok).toBe(false);
    expect(revokes()).toHaveLength(0);
  });

  it('refuses a signed-out caller with no database call', async () => {
    state.user = null;
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    expect((await revokeDomainClaimAction(ORG, CLAIM, 'support request')).ok).toBe(false);
    expect(calls.filter((c) => c.kind === 'rpc')).toHaveLength(0);
  });

  it('requires a reason: blank or whitespace makes no call', async () => {
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    for (const r of ['', '   ', '\n\t']) {
      expect(await revokeDomainClaimAction(ORG, CLAIM, r)).toEqual({ ok: false, error: 'Enter a reason.' });
    }
    expect(await revokeDomainClaimAction(ORG, CLAIM, 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('refuses ids that are not uuids with no call', async () => {
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    expect((await revokeDomainClaimAction(ORG, 'not-a-uuid', 'reason')).ok).toBe(false);
    expect((await revokeDomainClaimAction('nope', CLAIM, 'reason')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('an editor revokes with one admin_revoke_domain_claim call on the SESSION client, trimmed reason', async () => {
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    const res = await revokeDomainClaimAction(ORG, CLAIM, '  support request 3962  ');
    expect(res).toEqual({ ok: true, error: null });
    expect(revokes()).toEqual([
      { client: 'session', kind: 'rpc', name: 'admin_revoke_domain_claim', args: { p_claim: CLAIM, p_reason: 'support request 3962' } },
    ]);
    expect(state.serviceClients).toBe(0);
    expect(calls.filter((c) => c.client === 'service')).toHaveLength(0);
  });

  it('never writes domain_claims (or any table) through .from() on either client', async () => {
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    await revokeDomainClaimAction(ORG, CLAIM, 'support request');
    state.perms = ['organizations.view'];
    await revokeDomainClaimAction(ORG, CLAIM, 'support request');
    expect(calls.filter((c) => c.kind === 'from')).toHaveLength(0);
  });

  it('maps a refusal from the database to a message and reports not ok', async () => {
    const { revokeDomainClaimAction } = await import('@/lib/actions/domainClaims');
    state.revokeReply = { data: { success: false, error: 'not_revocable' }, error: null };
    expect(await revokeDomainClaimAction(ORG, CLAIM, 'r')).toEqual({
      ok: false,
      error: 'This domain claim is already withdrawn or revoked.',
    });
    state.revokeReply = { data: { success: false, error: 'insufficient_permissions' }, error: null };
    expect((await revokeDomainClaimAction(ORG, CLAIM, 'r')).ok).toBe(false);
    state.revokeReply = { data: null, error: { code: '42501', message: 'raw' } };
    expect(await revokeDomainClaimAction(ORG, CLAIM, 'r')).toEqual({ ok: false, error: 'The domain could not be revoked. Try again.' });
  });
});
