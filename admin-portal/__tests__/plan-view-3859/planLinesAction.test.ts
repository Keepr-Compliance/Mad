/**
 * BACKLOG-3859 — the users-list plan action (lib/actions/planLines.ts) and its
 * batched reader (lib/planLines.ts).
 *
 * Covers the most likely WRONG builds:
 *   - the permission check run through the service client (C6);
 *   - the check skipped (R4 a-c, gate order);
 *   - a price-like field reaching the client (C3);
 *   - a per-user query loop (C4);
 *   - a reversed membership order (C8), mode ignored (C9), the personal org
 *     taken from member rows instead of organizations.personal_owner_user_id (R5).
 *
 * Why the service client at all (C10, cited — not a live read, SR R8): prod
 * pg_policies has exactly one policy on billing_subscriptions,
 * billing_subscriptions_select_own (authenticated, SELECT,
 * `(SELECT auth.uid()) = user_id`); authenticated holds SELECT only. A staff
 * session therefore reads 0 rows of another user.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClient, type CallLog } from './emulator';
import {
  ALL_USERS,
  BASE_TABLES,
  BROKERAGE_ORG,
  NOW,
  STAFF,
  U_AGENT,
  U_BROKER,
  U_GRANT,
  U_NOBODY,
  U_NOMEMBER,
  U_SOLO_LIVE,
  U_SOLO_PAID,
  U_STALE,
  type Row,
} from './fixtures';

// ---- mocks: the session client and the service client are DIFFERENT objects ----
const state: {
  user: { id: string } | null;
  sessionPerm: { data: unknown; error: unknown };
  servicePerm: { data: unknown; error: unknown };
  sessionLog: CallLog | null;
  serviceLog: CallLog | null;
  events: string[];
  permArgs: unknown[];
  tables: Record<string, Row[]>;
} = {
  user: null,
  sessionPerm: { data: true, error: null },
  servicePerm: { data: false, error: null },
  sessionLog: null,
  serviceLog: null,
  events: [],
  permArgs: [],
  tables: BASE_TABLES,
};

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: vi.fn(async () => {
    state.events.push('getAuthenticatedUser');
    const { client, log } = makeClient({}, {
      rpc: (name, args) => {
        state.events.push(`session.rpc:${name}`);
        state.permArgs.push(args);
        return state.sessionPerm as { data: unknown; error: unknown };
      },
    });
    state.sessionLog = log;
    return { supabase: client, user: state.user };
  }),
  createServiceClient: vi.fn(() => {
    state.events.push('createServiceClient');
    const { client, log } = makeClient(state.tables, {
      rpc: (name) => {
        state.events.push(`service.rpc:${name}`);
        return state.servicePerm as { data: unknown; error: unknown };
      },
    });
    state.serviceLog = log;
    return client;
  }),
}));

import { getPlanLines } from '@/lib/actions/planLines';
import { readPlanLines } from '@/lib/planLines';

beforeEach(() => {
  state.user = { id: STAFF };
  state.sessionPerm = { data: true, error: null };
  state.servicePerm = { data: false, error: null };
  state.sessionLog = null;
  state.serviceLog = null;
  state.events = [];
  state.permArgs = [];
  state.tables = BASE_TABLES;
});

function serviceCalls(): number {
  return (state.serviceLog?.from.length ?? 0) + (state.serviceLog?.rpc.length ?? 0);
}

// ---------------------------------------------------------------------------
describe('R4 refusals: nothing is read without a permitted staff session', () => {
  it('(a) no signed-in user -> refused, no service client, zero service reads', async () => {
    state.user = null;
    await expect(getPlanLines([U_BROKER])).resolves.toEqual({ ok: false, error: 'not_authorized' });
    expect(state.events).not.toContain('createServiceClient');
    expect(serviceCalls()).toBe(0);
  });

  it('(b) has_permission false -> refused, no service client', async () => {
    state.sessionPerm = { data: false, error: null };
    await expect(getPlanLines([U_BROKER])).resolves.toEqual({ ok: false, error: 'not_authorized' });
    expect(state.events).not.toContain('createServiceClient');
    expect(serviceCalls()).toBe(0);
  });

  it('(c) has_permission errors -> refused (fail closed), no service client', async () => {
    state.sessionPerm = { data: null, error: { message: 'boom' } };
    await expect(getPlanLines([U_BROKER])).resolves.toEqual({ ok: false, error: 'not_authorized' });
    expect(state.events).not.toContain('createServiceClient');
  });

  it('(c2) has_permission returns a truthy non-true value -> refused', async () => {
    state.sessionPerm = { data: 'true', error: null };
    await expect(getPlanLines([U_BROKER])).resolves.toEqual({ ok: false, error: 'not_authorized' });
    expect(state.events).not.toContain('createServiceClient');
  });

  it.each([
    ['not an array', 'abc'],
    ['empty list', []],
    ['a non-uuid', [U_BROKER, 'not-a-uuid']],
    ['a number', [42]],
    ['101 ids', Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)],
  ])('(d) bad ids (%s) -> refused, no service client', async (_label, ids) => {
    await expect(getPlanLines(ids)).resolves.toEqual({ ok: false, error: 'invalid_ids' });
    expect(state.events).not.toContain('createServiceClient');
    expect(serviceCalls()).toBe(0);
  });

  it('the gate runs before the service client exists', async () => {
    const res = await getPlanLines([U_BROKER]);
    expect(res.ok).toBe(true);
    const gate = state.events.indexOf('session.rpc:has_permission');
    const service = state.events.indexOf('createServiceClient');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(service).toBeGreaterThan(gate);
  });
});

describe('C6: the permission check uses the staff session, never the service client', () => {
  it('session says yes, service would say no (3946: auth.uid() is NULL there) -> succeeds', async () => {
    const res = await getPlanLines([U_BROKER]);
    expect(res.ok).toBe(true);
    expect(state.serviceLog?.rpc).toEqual([]);
    expect(state.permArgs).toEqual([{ check_user_id: STAFF, required_permission: 'users.view' }]);
  });
});

// ---------------------------------------------------------------------------
describe('the lines (shared rule, batched facts)', () => {
  async function lines() {
    const res = await getPlanLines(ALL_USERS);
    if (!res.ok) throw new Error(`refused: ${res.error}`);
    return res.lines;
  }

  it('one line per requested user', async () => {
    expect(Object.keys(await lines()).sort()).toEqual([...ALL_USERS].sort());
  });

  it('C8: the FIRST brokerage row by created_at, id decides', async () => {
    expect((await lines())[U_BROKER]).toMatchObject({ kind: 'brokerage', text: 'Brokerage Demo Realty, license assigned' });
  });

  it('C8: brokerage wins over the member\'s own paid personal plan', async () => {
    expect((await lines())[U_AGENT]).toMatchObject({ kind: 'brokerage', text: 'Brokerage Demo Realty, license assigned', test: false });
  });

  it('test-org user with a TEST-mode active row -> Agent Unlimited, TEST tag, renews date', async () => {
    expect((await lines())[U_SOLO_PAID]).toEqual({
      kind: 'agent_unlimited',
      text: 'Agent Unlimited, paid by Stripe, renews Nov 12, 2026',
      test: true,
      warning: null,
    });
  });

  it('C9: live-org user with only a TEST-mode row -> Pay as you go, not Unlimited', async () => {
    expect((await lines())[U_SOLO_LIVE]).toEqual({ kind: 'pay_as_you_go', text: 'Solo Pay as you go', test: false, warning: null });
  });

  it('support grant ({ enabled }, no source)', async () => {
    expect((await lines())[U_GRANT]).toMatchObject({ kind: 'support_grant', text: 'Unlimited support grant' });
  });

  it('Q4: Unlimited on from Stripe with no open row -> Pay as you go WITH a warning', async () => {
    expect((await lines())[U_STALE]).toEqual({
      kind: 'pay_as_you_go',
      text: 'Solo Pay as you go',
      test: false,
      warning: 'Unlimited is on, but no open subscription was found',
    });
  });

  it('R5: personal org found by personal_owner_user_id even with no member row', async () => {
    expect((await lines())[U_NOMEMBER]).toMatchObject({
      kind: 'agent_ending',
      text: 'Agent Unlimited, paid by Stripe, ends Nov 12, 2026',
      test: true,
    });
  });

  it('no brokerage and no personal org -> No plan', async () => {
    expect((await lines())[U_NOBODY]).toMatchObject({ kind: 'no_organization', text: 'No plan (no organization)' });
  });

  it('suspended (SYNTHETIC licenses row) prefixes the line', async () => {
    state.tables = { ...BASE_TABLES, licenses: [{ user_id: U_SOLO_PAID, status: 'suspended' }] };
    expect((await lines())[U_SOLO_PAID].text).toBe('Suspended — Agent Unlimited, paid by Stripe, renews Nov 12, 2026');
  });

  it('a read error -> unavailable, never a guessed plan', async () => {
    state.tables = BASE_TABLES;
    const { createServiceClient } = await import('@/lib/supabase/server');
    vi.mocked(createServiceClient).mockImplementationOnce(() => {
      const { client, log } = makeClient(BASE_TABLES, { failTable: 'billing_subscriptions' });
      state.serviceLog = log;
      return client as never;
    });
    await expect(getPlanLines([U_SOLO_PAID])).resolves.toEqual({ ok: false, error: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------
describe('C3: nothing price-like leaves the server', () => {
  const PRICE_KEY = /price|amount|cents|currency|charge/i;

  function keysDeep(v: unknown, out: string[] = []): string[] {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysDeep(x, out);
      }
    }
    return out;
  }

  it('the action result has no price-like key, no currency sign', async () => {
    const res = await getPlanLines(ALL_USERS);
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res);
    expect(json.length).toBeGreaterThan(200);
    expect(keysDeep(res).filter((k) => PRICE_KEY.test(k))).toEqual([]);
    expect(json).not.toMatch(/[$€£]/);
  });

  it('each line carries exactly kind, text, test, warning', async () => {
    const res = await getPlanLines(ALL_USERS);
    if (!res.ok) throw new Error('refused');
    for (const line of Object.values(res.lines)) {
      expect(Object.keys(line).sort()).toEqual(['kind', 'test', 'text', 'warning']);
    }
  });
});

// ---------------------------------------------------------------------------
describe('C4: reads are batched — the count does not grow with the number of users', () => {
  function manyUsers(n: number): { ids: string[]; tables: Record<string, Row[]> } {
    const ids = Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-1${String(i).padStart(11, '0')}`);
    return {
      ids,
      tables: {
        ...BASE_TABLES,
        organizations: ids.map((u, i) => ({ id: `p-${i}`, personal_owner_user_id: u, is_test: true })),
        organization_plans: [],
        // One row of each kind per user, so a loop over ROWS (not only over ids)
        // adds calls at 100 users. Shapes copied from BASE_TABLES rows.
        organization_members: ids.map((u, i) => ({ id: `m-${i}`, user_id: u, role: 'agent', organization_id: BROKERAGE_ORG, license_status: 'active', created_at: '2026-10-10T16:27:11.72815+00:00', organizations: { name: null, personal_owner_user_id: null } })),
        billing_subscriptions: ids.map((u) => ({ user_id: u, stripe_mode: 'test', stripe_subscription_id: 'sub_fx_many', status: 'active', interval: 'month', current_period_end: '2026-11-12T19:45:47+00:00', cancel_at_period_end: false, canceled_at: null })),
        licenses: ids.map((u) => ({ user_id: u, status: 'suspended' })),
      },
    };
  }

  it('1 user and 100 users make the same number of service calls (5)', async () => {
    const one = manyUsers(1);
    state.tables = one.tables;
    expect((await getPlanLines(one.ids)).ok).toBe(true);
    const calls1 = serviceCalls();

    const hundred = manyUsers(100);
    state.tables = hundred.tables;
    const res = await getPlanLines(hundred.ids);
    expect(res.ok && Object.keys(res.lines).length).toBe(100);
    const calls100 = serviceCalls();

    expect(calls1).toBe(5);
    expect(calls100).toBe(calls1);
  });

  it('readPlanLines with credits adds the count and no further read', async () => {
    const { client, log } = makeClient(BASE_TABLES);
    const out = await readPlanLines(client as never, [U_STALE], NOW, { [U_STALE]: 7 });
    expect(out[U_STALE].text).toBe('Solo Pay as you go, 7 credits');
    expect(log.from.length).toBe(5);
  });
});
