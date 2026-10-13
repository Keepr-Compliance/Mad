/**
 * @jest-environment node
 *
 * BACKLOG-3849 — billing outbox drain (lib/billing/outbox.ts).
 *
 * Controls J3-J8, J10-J12 and the SR additions R4, R5, R9 (plan step 0 §3,
 * SR plan review §6). The service client is OutboxDb (every filter applied);
 * handlers are test-only fakes because no real kind exists yet. Stripe errors are
 * the SDK's own classes. No network: the Stripe constructor is a spy.
 */

import Stripe from 'stripe';
import { OutboxDb, outboxRow, type Clock } from '../../helpers/outboxDb';
import {
  backoffMinutes,
  classifyFailure,
  createDrainStripe,
  drainOnce,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RUN_BUDGET_MS,
  parseRunAfter,
  reportStaleRows,
  staleAlertDue,
} from '@/lib/billing/outbox';
import {
  NonRetryableOutboxError,
  outboxIdempotencyKey,
  type OutboxHandler,
  type OutboxRow,
} from '@/lib/billing/outboxKinds';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));

const mockStripeCtor = jest.fn();
jest.mock('stripe', () => {
  const actual = jest.requireActual('stripe');
  const Ctor = jest.fn().mockImplementation((...a: unknown[]) => {
    mockStripeCtor(...a);
    return { subscriptions: { update: jest.fn() } };
  });
  Object.assign(Ctor, { errors: actual.errors });
  return { __esModule: true, default: Ctor };
});

const T0 = new Date(Date.UTC(2026, 9, 13, 12, 0, 0));
const MIN = 60_000;

let clock: Clock;
let db: OutboxDb;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockCaptureMessage.mockReset();
  mockStripeCtor.mockReset();
  clock = { now: new Date(T0) };
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function seed(...rows: OutboxRow[]): OutboxDb {
  db = new OutboxDb(clock, rows);
  return db;
}

function run(handlers: Record<string, OutboxHandler>, budgetMs?: number) {
  return drainOnce({
    service: db as never,
    stripe: {} as Stripe,
    mode: 'test',
    handlers,
    now: () => new Date(clock.now),
    budgetMs,
  });
}

function alerts(name?: string): Record<string, unknown>[] {
  return mockCaptureMessage.mock.calls
    .filter((c) => c[1]?.tags?.billing_alert && (!name || c[1].tags.billing_alert === name))
    .map((c) => c[1]);
}

const ok: OutboxHandler = async () => {};
const fails = (err: unknown): OutboxHandler => async () => {
  throw err;
};

function stripeError(cls: string, raw: Record<string, unknown> = {}): Error {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = (Stripe as any).errors[cls];
  return new C({ message: 'card for jane@example.com declined', code: 'resource_missing', ...raw });
}

// ---------------------------------------------------------------------------

describe('claim call', () => {
  it('claims this mode with the limit of 10', async () => {
    seed(outboxRow());
    await run({ fake_kind: ok });
    expect(db.rpcCalls.filter((c) => c.fn === 'billing_outbox_claim')).toEqual([
      { fn: 'billing_outbox_claim', args: { p_mode: 'test', p_limit: 10 } },
    ]);
  });

  it('a claim error throws and writes nothing', async () => {
    seed(outboxRow());
    db.claimError = { code: '42883', message: 'function does not exist' };
    await expect(run({ fake_kind: ok })).rejects.toThrow('42883');
    expect(db.updates()).toHaveLength(0);
  });
});

describe('success', () => {
  it('marks the row processed, clears lease and error', async () => {
    const r = outboxRow({ last_error: 'handler_error', attempts: 2 });
    seed(r);
    const res = await run({ fake_kind: ok });
    expect(res).toMatchObject({ claimed: 1, done: 1, retried: 0, parked: 0 });
    expect(db.row(r.id)).toMatchObject({
      processed_at: T0.toISOString(),
      claimed_until: null,
      last_error: null,
      attempts: 3,
    });
  });
});

describe('J3 idempotency key', () => {
  it('is <row id>:<step>, stable, and changes only with the params', async () => {
    const r = outboxRow();
    seed(r);
    const seen: string[] = [];
    const handler: OutboxHandler = async (row, { stripe }) => {
      const params = { quantity: 3, proration_behavior: 'none' };
      const key = outboxIdempotencyKey(row, 'seats', params);
      seen.push(key);
      await (stripe as unknown as { subscriptions: { update: jest.Mock } }).subscriptions.update('sub_1', params, {
        idempotencyKey: key,
      });
    };
    const update = jest.fn();
    await drainOnce({
      service: db as never,
      stripe: { subscriptions: { update } } as unknown as Stripe,
      mode: 'test',
      handlers: { fake_kind: handler },
      now: () => new Date(clock.now),
    });
    expect(update).toHaveBeenCalledTimes(1);
    const key = update.mock.calls[0][2].idempotencyKey as string;
    expect(key.startsWith(`${r.id}:seats:`)).toBe(true);
    expect(key).toMatch(new RegExp(`^${r.id}:seats:[0-9a-f]{16}$`));
    expect(outboxIdempotencyKey(r, 'seats', { proration_behavior: 'none', quantity: 3 })).toBe(key);
    expect(outboxIdempotencyKey(r, 'seats', { quantity: 4, proration_behavior: 'none' })).not.toBe(key);
    expect(outboxIdempotencyKey(r, 'resume')).toBe(`${r.id}:resume`);
    expect(outboxIdempotencyKey({ id: 'other' }, 'resume')).not.toBe(`${r.id}:resume`);
  });
});

describe('J4 backoff', () => {
  it('sweep: try n waits min(2^(n-1), 60) minutes', () => {
    const got = Array.from({ length: 10 }, (_, i) => backoffMinutes(i + 1));
    expect(got).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'failed try %i (below the cap): run_after = now + backoff, lease released, error code set',
    async (tryNo) => {
      const r = outboxRow({ attempts: tryNo - 1 });
      seed(r);
      const res = await run({ fake_kind: fails(new Error('boom')) });
      expect(res).toMatchObject({ retried: 1, parked: 0, done: 0 });
      const after = db.row(r.id);
      expect(after.attempts).toBe(tryNo);
      expect(after.run_after).toBe(new Date(T0.getTime() + backoffMinutes(tryNo) * MIN).toISOString());
      expect(after.claimed_until).toBeNull();
      expect(after.processed_at).toBeNull();
      expect(after.last_error).toBe('handler_error');
      expect(alerts()).toHaveLength(0);
    }
  );

  it('try 3 waits exactly 4 minutes', async () => {
    const r = outboxRow({ attempts: 2 });
    seed(r);
    await run({ fake_kind: fails(new Error('boom')) });
    expect(db.row(r.id).run_after).toBe(new Date(T0.getTime() + 4 * MIN).toISOString());
  });
});

describe('J5 try cap', () => {
  it('cap is 8', () => expect(OUTBOX_MAX_ATTEMPTS).toBe(8));

  it.each([
    [7, 'retried'],
    [8, 'parked'],
  ])('failed try %i -> %s', async (tryNo, outcome) => {
    const r = outboxRow({ attempts: tryNo - 1 });
    seed(r);
    const handler = jest.fn(fails(new Error('boom')));
    await run({ fake_kind: handler });
    expect(handler).toHaveBeenCalledTimes(1);
    const after = db.row(r.id);
    if (outcome === 'parked') {
      expect(after.run_after).toBe('infinity');
      expect(after.claimed_until).toBeNull();
      expect(after.processed_at).toBeNull();
      expect(alerts('outbox_dead_letter')).toHaveLength(1);
    } else {
      expect(after.run_after).not.toBe('infinity');
      expect(alerts()).toHaveLength(0);
    }
  });

  it('R4: a row claimed at try 9 (earlier try died without a result) is parked without running', async () => {
    const r = outboxRow({ attempts: 8, claimed_until: new Date(T0.getTime() - 1000).toISOString() });
    seed(r);
    const handler = jest.fn(ok);
    const res = await run({ fake_kind: handler });
    expect(handler).not.toHaveBeenCalled();
    expect(res).toMatchObject({ parked: 1, done: 0 });
    expect(db.row(r.id)).toMatchObject({
      attempts: 9,
      run_after: 'infinity',
      claimed_until: null,
      processed_at: null,
      last_error: 'parked_attempts_exhausted',
    });
    expect(alerts('outbox_dead_letter')).toHaveLength(1);
  });

  it('a parked row is never claimed again', async () => {
    const r = outboxRow({ attempts: 7 });
    seed(r);
    await run({ fake_kind: fails(new Error('boom')) });
    clock.now = new Date(T0.getTime() + 365 * 24 * 60 * MIN);
    const handler = jest.fn(ok);
    const res = await run({ fake_kind: handler });
    expect(res.claimed).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('J6 attempts guard', () => {
  it('every write is filtered on id AND attempts', async () => {
    seed(outboxRow(), outboxRow({ kind: 'nope' }), outboxRow({ attempts: 8 }));
    db.rows.push(outboxRow());
    await run({ fake_kind: ok });
    const writes = db.updates();
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const w of writes) {
      expect(w.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: 'eq', column: 'id' }),
          expect.objectContaining({ op: 'eq', column: 'attempts' }),
        ])
      );
    }
  });

  it.each([
    ['success', ok],
    ['failure', fails(new Error('boom'))],
  ])('a worker whose row was re-claimed meanwhile writes nothing (%s)', async (_label, inner) => {
    const r = outboxRow();
    seed(r);
    const handler: OutboxHandler = async (row, c) => {
      // Lease ran out while this handler was slow; a second worker claimed the row.
      db.row(row.id).attempts += 1;
      db.row(row.id).claimed_until = new Date(T0.getTime() + 5 * MIN).toISOString();
      await inner(row, c);
    };
    const res = await run({ fake_kind: handler });
    expect(res).toMatchObject({ leaseLost: 1, done: 0, retried: 0 });
    expect(db.row(r.id)).toMatchObject({ attempts: 2, processed_at: null, last_error: null, run_after: r.run_after });
  });
});

describe('J7 stale alert (R9)', () => {
  const line = 10 * MIN;
  const staleRow = outboxRow;

  /** A full run with no handlers; used only for rows the claim cannot take. */
  async function staleOnly(...rows: OutboxRow[]) {
    seed(...rows);
    return run({});
  }

  /** The stale check alone: a due, unleased row would be claimed by a full run. */
  function staleCheck(at: Date) {
    return reportStaleRows({ service: db as never, stripe: {} as Stripe, mode: 'test', handlers: {} }, at);
  }

  it('a row created 20 min ago but scheduled 300 days out is not stale', async () => {
    const res = await staleOnly(
      staleRow({
        created_at: new Date(T0.getTime() - 20 * MIN).toISOString(),
        run_after: new Date(T0.getTime() + 300 * 24 * 60 * MIN).toISOString(),
      })
    );
    expect(res.stale).toBe(0);
    expect(alerts('outbox_stale')).toHaveLength(0);
  });

  it('a parked row (run_after = infinity) is not stale', async () => {
    const res = await staleOnly(staleRow({ run_after: 'infinity', attempts: 8, last_error: 'x' }));
    expect(res.stale).toBe(0);
    expect(alerts()).toHaveLength(0);
  });

  it('an unleased row 10 min 30 s past run_after alerts once, at the crossing', async () => {
    // Its last lease ran out a second ago and nothing has claimed it since.
    seed(
      staleRow({
        run_after: new Date(T0.getTime() - line - 30_000).toISOString(),
        claimed_until: new Date(T0.getTime() - 1000).toISOString(),
      })
    );
    const n = await staleCheck(new Date(clock.now));
    expect(n).toBe(1);
    const a = alerts('outbox_stale');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ fingerprint: ['billing_alert', 'outbox_stale', 'test'] });
  });

  it('a leased row past run_after is not stale (handler running)', async () => {
    const r = staleRow({
      run_after: new Date(T0.getTime() - line - 30_000).toISOString(),
      claimed_until: new Date(T0.getTime() + 2 * MIN).toISOString(),
      attempts: 1,
    });
    const res = await staleOnly(r);
    expect(res.stale).toBe(0);
    expect(alerts()).toHaveLength(0);
  });

  it('another mode\'s stale row does not alert this mode', async () => {
    const r = staleRow({
      stripe_mode: 'live',
      run_after: new Date(T0.getTime() - line - 30_000).toISOString(),
    });
    const res = await staleOnly(r);
    expect(res.stale).toBe(0);
    expect(alerts()).toHaveLength(0);
  });

  it('throttle: crossing alerts, every later minute of the hour does not, the next hour does', async () => {
    const r = staleRow({
      run_after: new Date(T0.getTime() - line - 30_000).toISOString(),
      claimed_until: new Date(T0.getTime() - 1000).toISOString(),
    });
    seed(r);
    let fired = 0;
    for (let m = 0; m <= 61; m++) {
      mockCaptureMessage.mockReset();
      await staleCheck(new Date(T0.getTime() + m * MIN));
      const n = alerts('outbox_stale').length;
      fired += n;
      if (m === 0 || m === 60) expect([m, n]).toEqual([m, 1]);
      else expect([m, n]).toEqual([m, 0]);
    }
    expect(fired).toBe(2);
  });

  it('S1: the alert window is checked at the run start, not after the rows ran', async () => {
    // B crosses the line 10 s before the run starts (window [T0-10s, T0+50s)).
    // A runs first and takes 55 s, so the budget releases B and the stale check
    // happens at T0+55s, outside the window. Sampled at the start, the run alerts.
    const a = staleRow({ run_after: new Date(T0.getTime() - line - 11_000).toISOString() });
    const b = staleRow({ run_after: new Date(T0.getTime() - line - 10_000).toISOString() });
    seed(a, b);
    const handler = jest.fn(async () => {
      clock.now = new Date(clock.now.getTime() + 55_000);
    });
    const res = await run({ fake_kind: handler });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ claimed: 2, done: 1, released: 1, stale: 1 });
    const al = alerts('outbox_stale');
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ extra: { stale_rows: 1, oldest_run_after: b.run_after } });
  });

  it('staleAlertDue: before the line never, boundary sweep around the crossing', () => {
    const ra = new Date(T0.getTime() - line);
    expect(staleAlertDue(ra, new Date(T0.getTime() - 1))).toBe(false);
    expect(staleAlertDue(ra, new Date(T0.getTime()))).toBe(true);
    expect(staleAlertDue(ra, new Date(T0.getTime() + MIN - 1))).toBe(true);
    expect(staleAlertDue(ra, new Date(T0.getTime() + MIN))).toBe(false);
    expect(staleAlertDue(ra, new Date(T0.getTime() + 60 * MIN))).toBe(true);
  });

  it('parseRunAfter: infinity is null, never an Invalid Date (R8)', () => {
    expect(parseRunAfter('infinity')).toBeNull();
    expect(parseRunAfter('-infinity')).toBeNull();
    expect(parseRunAfter(null)).toBeNull();
    expect(parseRunAfter(T0.toISOString())?.getTime()).toBe(T0.getTime());
  });
});

describe('J8 unknown kind', () => {
  it('parks at once, no handler called, one unknown-kind alert', async () => {
    const r = outboxRow({ kind: 'not_registered' });
    seed(r);
    const handler = jest.fn(ok);
    const res = await run({ fake_kind: handler });
    expect(handler).not.toHaveBeenCalled();
    expect(res).toMatchObject({ parked: 1 });
    expect(db.row(r.id)).toMatchObject({ attempts: 1, run_after: 'infinity', last_error: 'unknown_kind' });
    expect(alerts('outbox_unknown_kind')).toHaveLength(1);
  });

  it('a prototype key is not a handler', async () => {
    const r = outboxRow({ kind: 'toString' });
    seed(r);
    await run({});
    expect(db.row(r.id).last_error).toBe('unknown_kind');
  });
});

describe('J10 last_error carries no personal data (R14)', () => {
  it.each([
    ['plain Error', new Error('failed for jane@example.com')],
    ['Stripe error', stripeError('StripeConnectionError')],
    ['string thrown', 'jane@example.com'],
  ])('%s', async (_l, err) => {
    const r = outboxRow();
    seed(r);
    await run({ fake_kind: fails(err) });
    const e = db.row(r.id).last_error ?? '';
    expect(e.length).toBeGreaterThan(0);
    expect(e.length).toBeLessThanOrEqual(200);
    expect(e).not.toContain('@');
    expect(e).not.toContain('jane');
  });

  it('alerts carry no error message either', async () => {
    const r = outboxRow({ attempts: 7 });
    seed(r);
    await run({ fake_kind: fails(new Error('failed for jane@example.com')) });
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain('jane');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('jane');
  });
});

describe('J11 Stripe error classification (R6)', () => {
  it.each([
    'StripeInvalidRequestError',
    'StripeCardError',
    'StripePermissionError',
    'StripeAuthenticationError',
    'StripeIdempotencyError',
  ])('%s parks on the first try', async (cls) => {
    const r = outboxRow();
    seed(r);
    await run({ fake_kind: fails(stripeError(cls)) });
    expect(db.row(r.id)).toMatchObject({ attempts: 1, run_after: 'infinity' });
    expect(db.row(r.id).last_error).toBe(`stripe:${cls}:resource_missing`);
    expect(alerts('outbox_dead_letter')).toHaveLength(1);
  });

  it.each(['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError'])(
    '%s backs off',
    async (cls) => {
      const r = outboxRow();
      seed(r);
      await run({ fake_kind: fails(stripeError(cls)) });
      expect(db.row(r.id).run_after).toBe(new Date(T0.getTime() + MIN).toISOString());
      expect(alerts()).toHaveLength(0);
    }
  );

  it('a Stripe error type in neither list (StripeUnknownError) backs off, not parked', async () => {
    const err = stripeError('StripeUnknownError');
    // The SDK's own class: its type is outside both the final and the retryable list.
    expect((err as { type?: string }).type).toBe('StripeUnknownError');
    const r = outboxRow();
    seed(r);
    const res = await run({ fake_kind: fails(err) });
    expect(res).toMatchObject({ retried: 1, parked: 0 });
    expect(db.row(r.id)).toMatchObject({
      attempts: 1,
      run_after: new Date(T0.getTime() + MIN).toISOString(),
      claimed_until: null,
      last_error: 'stripe:StripeUnknownError:resource_missing',
    });
    expect(alerts()).toHaveLength(0);
  });

  it('NonRetryableOutboxError parks with its code', async () => {
    const r = outboxRow();
    seed(r);
    await run({ fake_kind: fails(new NonRetryableOutboxError('licence_suspended')) });
    expect(db.row(r.id)).toMatchObject({ run_after: 'infinity', last_error: 'nonretryable:licence_suspended' });
  });

  it('classifyFailure on an unknown thrown value retries', () => {
    expect(classifyFailure(undefined)).toEqual({ final: false, code: 'handler_error' });
    expect(classifyFailure(null)).toEqual({ final: false, code: 'handler_error' });
  });
});

describe('J12 time budget (R5)', () => {
  it('rows left when the budget is spent are released for the next run, not left leased', async () => {
    const a = outboxRow({ run_after: new Date(T0.getTime() - 3 * MIN).toISOString() });
    const b = outboxRow({ run_after: new Date(T0.getTime() - 2 * MIN).toISOString() });
    const c = outboxRow({ run_after: new Date(T0.getTime() - 1 * MIN).toISOString() });
    seed(a, b, c);
    const handler = jest.fn(async () => {
      clock.now = new Date(clock.now.getTime() + 41_000);
    });
    const res = await run({ fake_kind: handler }, 40_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ claimed: 3, done: 1, released: 2 });
    for (const id of [b.id, c.id]) {
      expect(db.row(id)).toMatchObject({ claimed_until: null, processed_at: null, attempts: 0 });
    }
    // The next run picks them up straight away.
    const res2 = await run({ fake_kind: jest.fn(ok) }, 40_000);
    expect(res2.claimed).toBe(2);
  });

  it('ten rows behind a handler that spends the whole budget: every row runs, none is parked unrun', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      outboxRow({ run_after: new Date(T0.getTime() - (10 - i) * MIN).toISOString() })
    );
    seed(...rows);
    const handler = jest.fn(async () => {
      clock.now = new Date(clock.now.getTime() + 41_000);
    });
    let parked = 0;
    for (let i = 0; i < 10; i++) {
      clock.now = new Date(T0.getTime() + i * MIN);
      parked += (await run({ fake_kind: handler }, 40_000)).parked;
    }
    expect(handler).toHaveBeenCalledTimes(10);
    expect(parked).toBe(0);
    expect(db.rows.every((r) => r.processed_at !== null && r.attempts === 1)).toBe(true);
    expect(alerts('outbox_dead_letter')).toHaveLength(0);
  });

  it('within the budget every row runs', async () => {
    seed(outboxRow(), outboxRow(), outboxRow());
    const handler = jest.fn(async () => {
      clock.now = new Date(clock.now.getTime() + 10_000);
    });
    const res = await run({ fake_kind: handler }, 40_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(res.done).toBe(3);
  });

  it('handlers get the run deadline: run start + budget (contract (e))', async () => {
    seed(outboxRow());
    const seen: Date[] = [];
    await run({
      fake_kind: async (_row, ctx) => {
        seen.push(ctx.deadline);
      },
    });
    expect(seen.map((d) => d.toISOString())).toEqual([new Date(T0.getTime() + OUTBOX_RUN_BUDGET_MS).toISOString()]);
  });

  it('the drain Stripe client has a 15 s timeout and one network retry', () => {
    createDrainStripe('sk_test_3849');
    expect(mockStripeCtor).toHaveBeenCalledTimes(1);
    expect(mockStripeCtor.mock.calls[0][1]).toMatchObject({
      apiVersion: '2025-02-24.acacia',
      timeout: 15_000,
      maxNetworkRetries: 1,
    });
  });
});
