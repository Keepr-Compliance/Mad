/**
 * BACKLOG-3848 — a recording stand-in for the Stripe client in unit tests.
 *
 * Every method the 3848 write paths call is present and RECORDED (op name +
 * arguments, in call order), so a control can assert order ("void before
 * cancel") and absence ("zero cancel calls"), and a mutation reds on an
 * assertion instead of on `x is not a function`. An op with no implementation
 * throws "unexpected Stripe call <op>", so a path that reaches Stripe where it
 * must not fails loudly.
 *
 * Objects are served from the TEST fixtures (fixtures/stripe/p3848, see its
 * README); a test that edits one says so next to it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Impl = (...args: any[]) => unknown;

export interface StripeStub {
  client: any;
  calls: { op: string; args: any[] }[];
  impl: Record<string, Impl>;
  ops: () => string[];
  callsTo: (op: string) => any[][];
}

const OPS = [
  'checkout.sessions.retrieve',
  'checkout.sessions.create',
  'checkout.sessions.list',
  'checkout.sessions.expire',
  'setupIntents.retrieve',
  'customers.retrieve',
  'customers.update',
  'customers.create',
  'customers.list',
  'customers.search',
  'subscriptions.retrieve',
  'subscriptions.list',
  'subscriptions.update',
  'subscriptions.cancel',
  'invoices.retrieve',
  'invoices.list',
  'invoices.pay',
  'invoices.voidInvoice',
  'charges.retrieve',
  'charges.list',
  'paymentMethods.retrieve',
  // BACKLOG-3853 PR-2 (brokerage subscription sync)
  'products.retrieve',
  'products.create',
  'subscriptions.create',
  'paymentIntents.retrieve',
  'testHelpers.testClocks.retrieve',
] as const;

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

/** A Stripe error as stripe-node raises it: `type` is the class name (e.g. StripeCardError), `code` from the body. */
export function stripeError(body: { error: { type?: string; code?: string | null; message?: string } }): Error {
  const typeMap: Record<string, string> = {
    card_error: 'StripeCardError',
    invalid_request_error: 'StripeInvalidRequestError',
    api_error: 'StripeAPIError',
  };
  const e = new Error(body.error.message ?? 'stripe error') as Error & { type: string; code?: string; rawType?: string };
  e.type = typeMap[body.error.type ?? 'api_error'] ?? 'StripeAPIError';
  e.rawType = body.error.type;
  if (body.error.code) e.code = body.error.code;
  return e;
}

export function createStripeStub(impl: Record<string, Impl> = {}): StripeStub {
  const stub: StripeStub = {
    client: {},
    calls: [],
    impl: { ...impl },
    ops: () => stub.calls.map((c) => c.op),
    callsTo: (op) => stub.calls.filter((c) => c.op === op).map((c) => c.args),
  };
  for (const op of OPS) {
    const parts = op.split('.');
    let node = stub.client;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts[parts.length - 1]] = async (...args: any[]) => {
      stub.calls.push({ op, args: clone(args) });
      const f = stub.impl[op];
      if (!f) throw new Error(`test: unexpected Stripe call ${op}`);
      const v = await f(...args);
      return v === undefined ? v : clone(v);
    };
  }
  return stub;
}
