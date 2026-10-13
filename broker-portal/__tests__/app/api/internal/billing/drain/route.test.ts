/**
 * @jest-environment node
 *
 * BACKLOG-3849 — POST /api/internal/billing/drain.
 *
 * J1 (mode from the key only), J2 (auth, SR R2), J9 (billing flag, SR R3).
 * Service client = OutboxDb; `billing_drain_secret()` is its configurable RPC
 * answer. The secret and the presented headers are synthetic 64-hex strings.
 * No network: Supabase and the Stripe constructor are mocked.
 */

import { OutboxDb, outboxRow, type Clock } from '../../../../../helpers/outboxDb';

let db: OutboxDb;
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: db.rpc, from: db.from }),
}));

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

const mockStripeCtor = jest.fn();
jest.mock('stripe', () => {
  const actual = jest.requireActual('stripe');
  const Ctor = jest.fn().mockImplementation((...a: unknown[]) => {
    mockStripeCtor(...a);
    return {};
  });
  Object.assign(Ctor, { errors: actual.errors });
  return { __esModule: true, default: Ctor };
});

import * as route from '@/app/api/internal/billing/drain/route';

const SECRET = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const WRONG = 'b'.repeat(64);
const ENV = { ...process.env };

let clock: Clock;
let logs: jest.SpyInstance[];

beforeEach(() => {
  process.env = { ...ENV, BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_3849' };
  clock = { now: new Date() };
  db = new OutboxDb(clock);
  db.secret = { data: SECRET, error: null };
  mockStripeCtor.mockReset();
  logs = (['error', 'warn', 'info', 'log'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = ENV;
});

function post(headers: Record<string, string> = { 'x-billing-drain-secret': SECRET }, body = '{}') {
  return route.POST(
    new Request('http://localhost/api/internal/billing/drain', { method: 'POST', headers, body })
  );
}
const rpcNames = () => db.rpcCalls.map((c) => c.fn);
const claims = () => db.rpcCalls.filter((c) => c.fn === 'billing_outbox_claim');

describe('J1 mode comes from the deployment key only', () => {
  it.each([
    ['sk_live_x', 'live'],
    ['rk_live_x', 'live'],
    ['sk_test_x', 'test'],
  ])('%s -> claims %s', async (key, mode) => {
    process.env.STRIPE_SECRET_KEY = key;
    const res = await post();
    expect(res.status).toBe(200);
    expect(claims()).toEqual([{ fn: 'billing_outbox_claim', args: { p_mode: mode, p_limit: 10 } }]);
  });

  it('a body asking for test on a live key still claims live', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    await post({ 'x-billing-drain-secret': SECRET, 'content-type': 'application/json' }, '{"mode":"test","p_mode":"test"}');
    expect(claims()[0].args).toEqual({ p_mode: 'live', p_limit: 10 });
  });

  it.each([['sk_abc_x'], ['']])('unknown or missing key %p -> 500, nothing claimed', async (key) => {
    process.env.STRIPE_SECRET_KEY = key;
    const res = await post();
    expect(res.status).toBe(500);
    expect(claims()).toHaveLength(0);
  });

  it('only claims rows of its own mode', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    db.rows.push(outboxRow({ stripe_mode: 'test', run_after: new Date(clock.now.getTime() - 60_000).toISOString() }));
    const res = await post();
    expect(await res.json()).toMatchObject({ mode: 'live', claimed: 0 });
    expect(db.rows[0].attempts).toBe(0);
  });
});

describe('J2 auth (R2)', () => {
  it.each([
    ['no header', {}],
    ['empty', { 'x-billing-drain-secret': '' }],
    ['short', { 'x-billing-drain-secret': 'abc' }],
    ['65 chars', { 'x-billing-drain-secret': SECRET + 'a' }],
    ['upper-case hex', { 'x-billing-drain-secret': SECRET.toUpperCase() }],
    ['not hex', { 'x-billing-drain-secret': 'z'.repeat(64) }],
    ['bearer form', { authorization: `Bearer ${SECRET}` }],
  ])('%s -> 401 before any database call', async (_l, headers) => {
    const res = await post(headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('well-formed wrong value -> 401, secret read, nothing claimed', async () => {
    const res = await post({ 'x-billing-drain-secret': WRONG });
    expect(res.status).toBe(401);
    expect(rpcNames()).toEqual(['billing_drain_secret']);
  });

  it.each([
    ['RPC error (function missing)', { data: null, error: { code: '42883', message: 'function does not exist' } }],
    ['RPC error with a value', { data: SECRET, error: { code: 'PGRST301', message: 'x' } }],
    ['NULL secret', { data: null, error: null }],
    ['empty secret', { data: '', error: null }],
    ['non-string secret', { data: { s: SECRET }, error: null }],
  ])('%s -> 401, nothing claimed', async (_l, answer) => {
    db.secret = answer as never;
    const res = await post();
    expect(res.status).toBe(401);
    expect(claims()).toHaveLength(0);
  });

  it('a stored secret of another length is a 401, not a 500', async () => {
    db.secret = { data: 'abc', error: null };
    const res = await post();
    expect(res.status).toBe(401);
  });

  it('right value -> 200 and one claim', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(rpcNames()).toEqual(['billing_drain_secret', 'billing_outbox_claim']);
  });

  it('never logs or echoes the presented header or the secret', async () => {
    const bodies: string[] = [];
    for (const h of [SECRET, WRONG, 'short']) {
      const res = await post({ 'x-billing-drain-secret': h });
      bodies.push(await res.text());
    }
    db.secret = { data: null, error: { code: '42883', message: 'x' } };
    bodies.push(await (await post()).text());
    const logged = JSON.stringify(logs.map((s) => s.mock.calls));
    for (const s of [SECRET, WRONG]) {
      expect(logged).not.toContain(s);
      expect(bodies.join('\n')).not.toContain(s);
    }
  });

  it('POST is the only method', () => {
    const exported = route as unknown as Record<string, unknown>;
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(exported[m]).toBeUndefined();
    expect(route.maxDuration).toBe(60);
    expect(route.runtime).toBe('nodejs');
  });

  it('a claim failure is a 500', async () => {
    db.claimError = { code: '42883', message: 'x' };
    const res = await post();
    expect(res.status).toBe(500);
  });
});

describe('J9 billing flag (R3)', () => {
  it.each([[undefined], ['false'], ['1'], ['TRUE']])(
    'BILLING_ENABLED=%p -> 200 disabled, zero RPC, no Stripe client',
    async (flag) => {
      if (flag === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = flag;
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ disabled: true });
      expect(db.rpcCalls).toHaveLength(0);
      expect(db.calls).toHaveLength(0);
      expect(mockStripeCtor).not.toHaveBeenCalled();
    }
  );

  it('flag on -> the drain Stripe client is built with the short timeout', async () => {
    await post();
    expect(mockStripeCtor).toHaveBeenCalledTimes(1);
    expect(mockStripeCtor.mock.calls[0][1]).toMatchObject({ timeout: 15_000, maxNetworkRetries: 1 });
  });
});
