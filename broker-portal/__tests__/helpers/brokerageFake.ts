/**
 * BACKLOG-3853 PR-2 — a service-client stand-in for the brokerage billing tests.
 *
 * `from()` is BillingDb (filters applied and recorded). `rpc()` models the SQL functions the
 * brokerage code calls, transcribed from
 * supabase/migrations/20261019090000_backlog_3853_subscription_engine.sql (and PR-1's
 * _billing_reinstate_org). The SQL itself is proven on keepr-test by
 * supabase/tests/backlog-3853/pr2-controls.sql; this model only lets the TypeScript flow run.
 * Every rpc call is recorded in `rpcCalls`.
 */

import { BillingDb, type Row } from './billingDb';

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface BrokerageFake {
  db: BillingDb;
  service: {
    from: BillingDb['from'];
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { code: string; message: string } | null }>;
    auth: { admin: { getUserById: jest.Mock } };
  };
  rpcCalls: RpcCall[];
  /** Force the next call to `fn` to return an error. */
  failRpc: Set<string>;
  brokerageLive: { value: boolean };
  callsTo: (fn: string) => Record<string, unknown>[];
}

const epoch = (iso: unknown): number | null => (typeof iso === 'string' ? Math.floor(Date.parse(iso) / 1000) : null);

export function createBrokerageFake(seed: Record<string, Row[]> = {}): BrokerageFake {
  const db = new BillingDb(seed);
  const rpcCalls: RpcCall[] = [];
  const failRpc = new Set<string>();
  const brokerageLive = { value: false };

  const mirror = (org: unknown, mode: unknown): Row => {
    const rows = db.rows('org_billing_stripe');
    let r = rows.find((x) => x.organization_id === org && x.stripe_mode === mode);
    if (!r) {
      r = { organization_id: org, stripe_mode: mode, cancel_at_period_end: false };
      rows.push(r);
    }
    return r;
  };
  const deal = (org: unknown): Row | undefined => db.rows('org_deals').find((d) => d.organization_id === org);

  const impl: Record<string, (a: Record<string, unknown>) => unknown> = {
    _billing_brokerage_live: () => brokerageLive.value,
    _billing_apply_org_subscription: (a) => {
      const f = (a.p_fields ?? {}) as Record<string, unknown>;
      const r = mirror(a.p_org, a.p_mode);
      if (f.stripe_customer_id) r.stripe_customer_id = f.stripe_customer_id;
      if (f.stripe_subscription_id) r.stripe_subscription_id = f.stripe_subscription_id;
      if (a.p_event_created === null || a.p_event_created === undefined) return { success: true, applied: true };
      const cur = r.last_event_created as number | null | undefined;
      if (cur !== null && cur !== undefined && (a.p_event_created as number) < cur) return { success: true, applied: false };
      if (f.status) r.status = f.status;
      if (f.current_period_end) r.current_period_end = f.current_period_end;
      if ('cancel_at_period_end' in f) r.cancel_at_period_end = f.cancel_at_period_end;
      if (f.collection_method) r.collection_method = f.collection_method;
      r.last_event_created = Math.max(cur ?? 0, a.p_event_created as number);
      return { success: true, applied: true };
    },
    _billing_record_invoice_paid: (a) => {
      const r = mirror(a.p_org, a.p_mode);
      r.last_invoice_paid_event_created = Math.max((r.last_invoice_paid_event_created as number) ?? 0, a.p_event_created as number);
      return { success: true };
    },
    _billing_auto_reinstate: (a) => {
      const d = deal(a.p_org);
      if (!d || d.status !== 'suspended' || d.stripe_mode !== a.p_mode) return { success: false, error: 'not_suspended' };
      if (d.suspended_reason !== 'non_payment') return { success: false, error: 'reason_not_non_payment' };
      const m = db.rows('org_billing_stripe').find((x) => x.organization_id === a.p_org && x.stripe_mode === a.p_mode);
      if (m?.status !== 'active') return { success: false, error: 'subscription_not_active', status: m?.status ?? null };
      const paid = m.last_invoice_paid_event_created as number | undefined;
      const since = epoch(d.suspended_at);
      if (paid === undefined || paid === null || since === null || paid <= since) {
        return { success: false, error: 'no_payment_since_suspension' };
      }
      Object.assign(d, { status: 'active', suspended_reason: null, suspended_at: null });
      return { success: true };
    },
    // BACKLOG-4007 People v2 (migration 20261020200000 §6): the live billing contact's member ->
    // the account's phone (user_phones.user_id) or the invitation's (pending_member_id).
    _org_billing_contact_phone: (a) => {
      const c = db.rows('org_contacts').find((x) => x.organization_id === a.p_org && x.role === 'billing' && !x.removed_at);
      if (!c) return null;
      const m = db.rows('organization_members').find((x) => x.id === c.member_id);
      if (!m) return null;
      const p = db
        .rows('user_phones')
        .find((x) => (m.user_id ? x.user_id === m.user_id : x.pending_member_id === m.id));
      return p ? p.phone : null;
    },
    // BACKLOG-4019 (migration 20261020220000 §6): ends a deal that is effectively canceling,
    // only for the stored subscription. Outcomes as the SQL returns them.
    _billing_end_org_deal: (a) => {
      const d = deal(a.p_org);
      if (!d) return { success: false, error: 'no_deal' };
      if (d.stripe_mode !== a.p_mode) return { success: false, error: 'mode_mismatch' };
      const m = db.rows('org_billing_stripe').find((x) => x.organization_id === a.p_org && x.stripe_mode === a.p_mode);
      if (!m?.stripe_subscription_id || m.stripe_subscription_id !== a.p_subscription_id) return { success: true, outcome: 'not_stored' };
      if (d.status === 'canceled') return { success: true, outcome: 'already_canceled' };
      const eff = d.status === 'suspended' ? d.status_before_suspension : d.status;
      if (eff !== 'canceling') {
        return { success: true, outcome: 'not_canceling', status: d.status, status_before_suspension: d.status_before_suspension ?? null };
      }
      Object.assign(d, {
        status: 'canceled',
        status_before_suspension: null,
        suspended_reason: null,
        suspended_at: null,
        version: (d.version as number) + 1,
      });
      return { success: true, outcome: 'ended', ended_on: m.current_period_end ?? null };
    },
    _billing_org_sync_lease: (a) => {
      const r = mirror(a.p_org, a.p_mode);
      const now = Date.now();
      const free = !r.sync_lease_until || (r.sync_lease_until as number) < now || r.sync_lease_holder === a.p_holder;
      if (!free) return false;
      r.sync_lease_holder = a.p_holder;
      r.sync_lease_until = now + (a.p_seconds as number) * 1000;
      return true;
    },
    _billing_org_sync_release: (a) => {
      const r = db.rows('org_billing_stripe').find((x) => x.organization_id === a.p_org && x.stripe_mode === a.p_mode);
      if (!r || r.sync_lease_holder !== a.p_holder) return false;
      r.sync_lease_holder = null;
      r.sync_lease_until = null;
      return true;
    },
  };

  const fake: BrokerageFake = {
    db,
    rpcCalls,
    failRpc,
    brokerageLive,
    callsTo: (fn) => rpcCalls.filter((c) => c.fn === fn).map((c) => c.args),
    service: {
      from: db.from,
      rpc: async (fn, args = {}) => {
        rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
        if (failRpc.has(fn)) {
          failRpc.delete(fn);
          return { data: null, error: { code: 'PGRST000', message: 'fixture: rpc failed' } };
        }
        const f = impl[fn];
        return { data: f ? f(args) : null, error: null };
      },
      auth: { admin: { getUserById: jest.fn() } },
    },
  };
  return fake;
}

/** A brokerage deal row as _billing_save_deal writes it (columns from 20261018230000). */
export function dealRow(org: string, over: Row = {}): Row {
  return {
    organization_id: org,
    stripe_mode: 'test',
    seats: 5,
    status: 'active',
    version: 1,
    billing_contact_email: 'billing-3853@example.test',
    account_manager_id: 'AM-3853',
    suspended_at: null,
    suspended_reason: null,
    ...over,
  };
}
