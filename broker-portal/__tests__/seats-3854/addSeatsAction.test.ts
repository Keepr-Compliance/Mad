/**
 * @jest-environment node
 *
 * BACKLOG-3854 — the addSeats server action (lib/actions/seats.ts).
 *
 * S7 (W1, W6): the organization is the session's own, never an argument; the action sends how many
 * to ADD (p_add), never a total; IT admin, the billing-only login, impersonation and bad shapes are
 * refused before the database. S8 (W4, W11): the LIVE overdue check — an open invoice whose due
 * date has passed at the customer's test-clock time refuses before the RPC; due exactly now is
 * allowed (boundary); a Stripe error or hang refuses (fail closed).
 *
 * Stripe objects transcribed from __tests__/fixtures/stripe/p3853 (TEST captures): inv-list-open.json
 * (open send_invoice invoices), customer.json (test_clock), clock.json (frozen_time). Edited
 * fields are marked [EDITED].
 */

import fs from 'fs';
import path from 'path';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../fixtures/stripe/p3853');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const OPEN = fx('inv-list-open');
const CUSTOMER = fx('customer');
const CLOCK = fx('clock');

const ORG_A = '00000000-0000-0000-0000-000000000000';
const ORG_B = '00000000-0000-0000-0000-00000000000b'; // pii-allow-uuid: invented, not from any live row; must differ from ORG_A, and the nil UUID is the only other accepted value

const mockRpc = jest.fn();
const mockBlocked = jest.fn(async () => null as { error: string } | null);
let mockAccess: Obj | null;
let mockDeal: Obj | null;
let mockMirror: Obj | null;
const mockServiceReads: Array<[string, Obj]> = [];
const mockStripe = {
  customers: { retrieve: jest.fn() },
  testHelpers: { testClocks: { retrieve: jest.fn() } },
  invoices: { list: jest.fn() },
};

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlocked() }));
jest.mock('@/lib/billing/flag', () => ({ billingEnabled: () => true }));
jest.mock('@/lib/billing/mode', () => ({ currentStripeMode: () => 'test' }));
jest.mock('@/lib/stripe', () => ({ getStripe: () => mockStripe }));
jest.mock('@/lib/auth/orgSuspension', () => ({ readOrgBillingSuspendedFor: async () => false }));
jest.mock('@/lib/auth/portalAccess', () => ({
  getPortalAccess: async () =>
    mockAccess && { supabase: { rpc: (...a: unknown[]) => mockRpc(...a) }, user: { id: 'U' }, suspended: false, orgSuspended: false, billingContact: false, ...mockAccess },
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const filters: Obj = {};
      const q: Obj = {
        select: () => q,
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        maybeSingle: async () => {
          mockServiceReads.push([table, { ...filters }]);
          if (filters.organization_id !== ORG_A) return { data: null, error: null };
          return { data: table === 'org_deals' ? mockDeal : mockMirror, error: null };
        },
      };
      return q;
    },
  }),
}));

import { addSeats } from '@/lib/actions/seats';
import { SEAT_OVERDUE_TIMEOUT_MS } from '@/lib/billing/seats';

const full = (role: string) => ({ access: { kind: 'full', role, organizationId: ORG_A } });
/** One open invoice due at `due` [EDITED due_date], the customer on its test clock at CLOCK.frozen_time. */
function openInvoiceDue(due: number) {
  const inv = { ...OPEN.data[0], due_date: due };
  mockStripe.invoices.list.mockResolvedValue({ object: 'list', data: [inv], has_more: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceReads.length = 0;
  mockAccess = full('admin');
  mockDeal = { status: 'active' };
  mockMirror = { stripe_customer_id: CUSTOMER.id };
  mockStripe.customers.retrieve.mockResolvedValue(CUSTOMER);
  mockStripe.testHelpers.testClocks.retrieve.mockResolvedValue(CLOCK);
  mockStripe.invoices.list.mockResolvedValue({ object: 'list', data: [], has_more: false });
  mockRpc.mockResolvedValue({ data: { success: true, version: 3, seats_from: 7, seats_to: 9 }, error: null });
});

describe('addSeats — S7 who and what', () => {
  it('Broker and Admin: one RPC on the session client with the session org, p_add = count, the read version', async () => {
    for (const role of ['broker', 'admin']) {
      mockRpc.mockClear();
      mockAccess = full(role);
      await expect(addSeats(2, 2)).resolves.toEqual({ ok: true, error: null, seatsTo: 9 });
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('broker_add_seats', { p_org: ORG_A, p_add: 2, p_expected_version: 2 });
    }
  });

  it('W6: an extra organization argument (another brokerage) is ignored; the session org is used', async () => {
    const call = addSeats as unknown as (...a: unknown[]) => Promise<unknown>;
    await call(1, 2, ORG_B, { organizationId: ORG_B });
    expect(mockRpc.mock.calls[0][1].p_org).toBe(ORG_A);
    expect(mockServiceReads.every(([, f]) => f.organization_id === ORG_A)).toBe(true);
  });

  it('IT admin, an agent, the billing-only login, no session: refused before the database and Stripe', async () => {
    for (const a of [
      full('it_admin'),
      { access: { kind: 'floor', via: 'brokerage', role: 'agent', organizationId: ORG_A } },
      { access: { kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: ORG_A }, billingContact: true },
      null,
    ]) {
      mockAccess = a as Obj | null;
      const r = await addSeats(1, 2);
      expect(r.ok).toBe(false);
    }
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockStripe.invoices.list).not.toHaveBeenCalled();
  });

  it('impersonation: refused, nothing read', async () => {
    mockBlocked.mockResolvedValueOnce({ error: 'blocked' });
    expect((await addSeats(1, 2)).ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockServiceReads).toEqual([]);
  });

  it('billing not set up (draft deal) -> refused before the RPC', async () => {
    mockDeal = { status: 'draft' };
    expect((await addSeats(1, 2)).ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a suspended brokerage -> refused before the RPC', async () => {
    mockAccess = { ...full('admin'), orgSuspended: true };
    expect((await addSeats(1, 2)).ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5], [10001], [Number.NaN], ['2'], [null]])('count %p -> refused before Stripe and the RPC', async (count) => {
    const r = await addSeats(count as number, 2);
    expect(r).toEqual({ ok: false, error: 'Enter a number of seats from 1 to 10,000.' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockStripe.invoices.list).not.toHaveBeenCalled();
  });

  it('a non-integer version -> refused', async () => {
    expect((await addSeats(1, 'x' as unknown as number)).ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['seats_below_assigned', 'More people hold seats than your plan has. Contact your Keepr account manager.'],
    ['version_conflict', 'Your plan changed. Reload the page and try again.'],
    ['deal_canceling', 'Your plan is ending, so seats cannot be added.'],
    ['invoice_overdue', 'Pay the overdue invoice to add seats.'],
  ])('database refusal %s -> a sentence', async (code, sentence) => {
    mockRpc.mockResolvedValue({ data: { success: false, error: code }, error: null });
    expect(await addSeats(1, 2)).toEqual({ ok: false, error: sentence });
  });

  it('42501 -> the permission sentence', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await addSeats(1, 2)).error).toBe('Only a Broker or Admin can add seats.');
  });
});

describe('addSeats — S8 live overdue check', () => {
  const now = CLOCK.frozen_time as number;

  it('an open invoice due one second before the test clock -> refused, RPC not called (mirror still active)', async () => {
    openInvoiceDue(now - 1);
    expect(await addSeats(1, 2)).toEqual({ ok: false, error: 'Pay the overdue invoice to add seats.' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockStripe.invoices.list).toHaveBeenCalledWith({ customer: CUSTOMER.id, status: 'open', limit: 100 });
  });

  it('due exactly at the test clock -> not overdue, allowed (boundary)', async () => {
    openInvoiceDue(now);
    expect((await addSeats(1, 2)).ok).toBe(true);
  });

  it('W11: overdue by the test clock but not by the wall clock -> refused (the clock is read)', async () => {
    // The fixture clock is in 2026-11; the wall clock in this test is earlier [EDITED due_date].
    jest.useFakeTimers({ now: (now - 30 * 86400) * 1000, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    try {
      openInvoiceDue(now - 3600);
      expect((await addSeats(1, 2)).ok).toBe(false);
      expect(mockStripe.testHelpers.testClocks.retrieve).toHaveBeenCalledWith(CLOCK.id);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Stripe error -> refused (fail closed), RPC not called', async () => {
    mockStripe.invoices.list.mockRejectedValue(new Error('stripe down'));
    expect(await addSeats(1, 2)).toEqual({ ok: false, error: 'Stripe is unavailable right now. Try again in a minute.' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Stripe hangs -> refused after the timeout, RPC not called', async () => {
    jest.useFakeTimers();
    try {
      mockStripe.invoices.list.mockReturnValue(new Promise(() => undefined));
      const p = addSeats(1, 2);
      await jest.advanceTimersByTimeAsync(SEAT_OVERDUE_TIMEOUT_MS + 10);
      expect(await p).toEqual({ ok: false, error: 'Stripe is unavailable right now. Try again in a minute.' });
      expect(mockRpc).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
