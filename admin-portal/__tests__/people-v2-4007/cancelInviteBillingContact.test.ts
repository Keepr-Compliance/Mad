/**
 * BACKLOG-4007 People v2 (PM 6a68d0a2, F3): staff "Cancel invitation" on the live billing
 * contact's invitation (a billing-only login not yet claimed) is refused with the founder's
 * sentence and deletes nothing. Any other pending invitation is still cancelled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Op = [string, ...unknown[]];
const queries: { table: string; ops: Op[] }[] = [];
let member: { id: string; user_id: string | null; invited_email: string } | null;
let liveBillingContactFor: string | null;

function table(name: string) {
  const ops: Op[] = [];
  queries.push({ table: name, ops });
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'delete']) {
    b[m] = (...args: unknown[]) => { ops.push([m, ...args]); return b; };
  }
  b.maybeSingle = async () => {
    if (name === 'organization_members') return { data: member, error: null };
    if (name === 'org_contacts') {
      const eq = (k: string) => ops.find((o) => o[0] === 'eq' && o[1] === k)?.[2];
      const live = ops.some((o) => o[0] === 'is' && o[1] === 'removed_at' && o[2] === null);
      const hit = live && eq('role') === 'billing' && eq('member_id') === liveBillingContactFor;
      return { data: hit ? { id: 'contact-1' } : null, error: null };
    }
    return { data: null, error: null };
  };
  b.then = (ok: (_v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } } }) },
    rpc: async () => ({ data: true, error: null }),
  }),
  createServiceClient: (opts?: { actorId?: string }) => {
    serviceOpts.push(opts);
    return { from: (name: string) => table(name) };
  },
}));

const serviceOpts: Array<{ actorId?: string } | undefined> = [];

function req(body: unknown) {
  return new Request('https://admin.test/api/users/cancel-invite', { method: 'POST', body: JSON.stringify(body) }) as never;
}
const deletes = () => queries.filter((q) => q.table === 'organization_members' && q.ops.some((o) => o[0] === 'delete'));

beforeEach(() => {
  queries.length = 0;
  member = { id: 'm-pay', user_id: null, invited_email: 'pay@example.test' };
  liveBillingContactFor = 'm-pay';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('cancel-invite and the live billing contact (BACKLOG-4007 F3)', () => {
  it('refuses the billing contact\'s invitation with "Pick another billing contact first." and deletes nothing', async () => {
    const { POST } = await import('@/app/api/users/cancel-invite/route');
    const res = await POST(req({ membershipId: 'm-pay' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Pick another billing contact first.' });
    expect(deletes()).toHaveLength(0);
  });

  it('cancels a pending invitation that is not the billing contact', async () => {
    liveBillingContactFor = 'someone-else';
    const { POST } = await import('@/app/api/users/cancel-invite/route');
    const res = await POST(req({ membershipId: 'm-pay' }));
    expect(res.status).toBe(200);
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].ops).toContainEqual(['eq', 'id', 'm-pay']);
    // BACKLOG-4036: the removal names the signed-in staff user as the actor (x-keepr-actor)
    expect(serviceOpts.at(-1)).toEqual({ actorId: 'staff-1' });
  });
});
