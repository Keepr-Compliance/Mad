/**
 * billing_outbox kind `sync_org_subscription` — BACKLOG-3853 PR-2.
 *
 * Makes the brokerage's Stripe subscription match its saved deal: one monthly subscription,
 * collection_method send_invoice, net 15 (days_until_due 15), no proration, one line
 * "<seats> x <seat price>" on the fixed product `keepr_team_seat`, payable by card, US bank
 * account or bank transfer. Enqueued by the org_deals trigger: one row per deal version
 * (save deal, seat change). The row carries ids only; everything is read at run time.
 *
 * Contract (outboxKinds.ts):
 *  (a) Converge: read the deal, the mirror and Stripe; change only what differs.
 *  (b) Stable keys. Keys are per organization / mode / deal version, not per row (SR R5,
 *      spike #13): two rows for one version must reach the same Stripe object. A row whose
 *      version is no longer the deal's finishes with no Stripe call ("superseded"): the
 *      trigger guarantees a row for the newer version, and sending newer parameters under an
 *      older key would be refused with idempotency_error (SR plan review item 3).
 *  (c) No step charges money directly: the subscription's invoices are sent, not charged.
 *      A crash between create and persist is recovered by subscriptions.list (adopt), never
 *      by Search, which lags ~11 s (spike #14).
 *  (d) Refusals: no deal, deal mode differs from the drain's (belt only: the claim filters by
 *      mode), live deal while brokerage billing is not live.
 *  (e) Deadline checked before every Stripe call after the first.
 *
 * Per-organization lease (_billing_org_sync_lease, 120 s >= the drain's 60 s maxDuration):
 * two overlapping drain runs never sync one organization at once. Not acquired -> an ordinary
 * throw; the row retries with backoff (a try is consumed; with the superseded rule most
 * contending rows finish without Stripe calls).
 */

import { createHash } from 'crypto';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { StripeMode } from './mode';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const SYNC_ORG_SUBSCRIPTION_KIND = 'sync_org_subscription';
export const BROKERAGE_PRODUCT_ID = 'keepr_team_seat';
export const BROKERAGE_PRODUCT_NAME = 'Keepr Team seat';
export const BROKERAGE_DAYS_UNTIL_DUE = 15;
/** Lease length; the drain function runs at most 60 s (SR plan review 7b). */
export const BROKERAGE_SYNC_LEASE_SECONDS = 120;
const ENDED = new Set(['canceled', 'incomplete_expired']);
const SYNCABLE_DEAL = new Set(['active', 'canceling', 'suspended']);

interface Deal {
  stripe_mode: StripeMode;
  version: number;
  seats: number;
  status: string;
  billing_contact_email: string | null;
}

function pastDeadline(deadline: Date): void {
  if (Date.now() >= deadline.getTime()) throw new Error('outbox deadline reached');
}

function digest(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

function isMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

async function rpc<T>(service: ServiceClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await service.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.code ?? 'unknown'}`);
  return data as T;
}

export function brokerageKey(org: string, mode: StripeMode, step: string): string {
  return `brokerage:${org}:${mode}:${step}`;
}

/** Subscription create parameters: a pure function of the deal at this version. */
export function subscriptionCreateParams(
  customer: string,
  org: string,
  deal: Pick<Deal, 'seats' | 'version'>,
  unitAmount: number
): Stripe.SubscriptionCreateParams {
  return {
    customer,
    collection_method: 'send_invoice',
    days_until_due: BROKERAGE_DAYS_UNTIL_DUE,
    proration_behavior: 'none',
    items: [
      {
        price_data: { currency: 'usd', product: BROKERAGE_PRODUCT_ID, unit_amount: unitAmount, recurring: { interval: 'month' } },
        quantity: deal.seats,
      },
    ],
    payment_settings: {
      payment_method_types: ['us_bank_account', 'card', 'customer_balance'],
      payment_method_options: {
        customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } },
      },
    },
    metadata: { kind: 'brokerage', organization_id: org, deal_version: String(deal.version) },
  };
}

async function ensureProduct(ctx: Parameters<OutboxHandler>[1]): Promise<void> {
  try {
    await ctx.stripe.products.retrieve(BROKERAGE_PRODUCT_ID);
    return;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  pastDeadline(ctx.deadline);
  await ctx.stripe.products.create(
    { id: BROKERAGE_PRODUCT_ID, name: BROKERAGE_PRODUCT_NAME },
    { idempotencyKey: `brokerage:product:${ctx.mode}` }
  );
}

export const handleSyncOrgSubscriptionRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id;
  const wantVersion = typeof row.payload?.deal_version === 'number' ? row.payload.deal_version : null;
  if (!org || wantVersion === null) throw new NonRetryableOutboxError('bad_payload');
  const { service, stripe, mode } = ctx;

  const { data: dealData, error: dealErr } = await service
    .from('org_deals')
    .select('stripe_mode, version, seats, status, billing_contact_email')
    .eq('organization_id', org)
    .maybeSingle();
  if (dealErr) throw new Error(`org_deals read failed: ${dealErr.code ?? 'unknown'}`);
  const deal = dealData as Deal | null;
  if (!deal) throw new NonRetryableOutboxError('no_deal');
  if (deal.stripe_mode !== mode) throw new NonRetryableOutboxError('mode_mismatch');
  if (deal.stripe_mode === 'live' && !(await rpc<boolean>(service, '_billing_brokerage_live', {}))) {
    throw new NonRetryableOutboxError('billing_not_live');
  }
  if (deal.version !== wantVersion) {
    console.info(`[billing/brokerage-sync] ${row.id}: deal is at v${deal.version}, row is v${wantVersion}; superseded`);
    return;
  }
  if (!SYNCABLE_DEAL.has(deal.status)) {
    console.info(`[billing/brokerage-sync] ${row.id}: deal is ${deal.status}; nothing to sync`);
    return;
  }

  const { data: lineData, error: lineErr } = await service
    .from('org_deal_lines')
    .select('unit_price_cents')
    .eq('organization_id', org)
    .eq('item_key', 'brokerage_seat')
    .maybeSingle();
  if (lineErr) throw new Error(`org_deal_lines read failed: ${lineErr.code ?? 'unknown'}`);
  const unitAmount = (lineData as { unit_price_cents?: number } | null)?.unit_price_cents;
  if (typeof unitAmount !== 'number') throw new NonRetryableOutboxError('no_price');

  const { data: orgData, error: orgErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (orgErr) throw new Error(`organizations read failed: ${orgErr.code ?? 'unknown'}`);
  const orgName = ((orgData as { name?: string | null } | null)?.name ?? '').trim() || null;

  const leased = await rpc<boolean>(service, '_billing_org_sync_lease', {
    p_org: org,
    p_mode: mode,
    p_holder: row.id,
    p_seconds: BROKERAGE_SYNC_LEASE_SECONDS,
  });
  if (!leased) throw new Error('brokerage sync lease busy');

  try {
    const { data: mirrorData, error: mirrorErr } = await service
      .from('org_billing_stripe')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('organization_id', org)
      .eq('stripe_mode', mode)
      .maybeSingle();
    if (mirrorErr) throw new Error(`org_billing_stripe read failed: ${mirrorErr.code ?? 'unknown'}`);
    const mirror = (mirrorData ?? {}) as { stripe_customer_id?: string | null; stripe_subscription_id?: string | null };

    await ensureProduct(ctx);

    // ---- customer ----
    let customer: Stripe.Customer;
    if (mirror.stripe_customer_id) {
      pastDeadline(ctx.deadline);
      const c = await stripe.customers.retrieve(mirror.stripe_customer_id);
      if ((c as Stripe.DeletedCustomer).deleted) throw new NonRetryableOutboxError('customer_deleted');
      customer = c as Stripe.Customer;
    } else {
      pastDeadline(ctx.deadline);
      // Metadata only: the parameters never change between tries (SR plan review 7a).
      customer = await stripe.customers.create(
        { metadata: { kind: 'brokerage', organization_id: org } },
        { idempotencyKey: brokerageKey(org, mode, 'customer') }
      );
      await rpc(service, '_billing_apply_org_subscription', {
        p_org: org,
        p_mode: mode,
        p_fields: { stripe_customer_id: customer.id },
        p_event_created: null,
      });
    }
    const want = { email: deal.billing_contact_email?.trim() || null, name: orgName };
    const patch: Stripe.CustomerUpdateParams = {};
    if (want.email && customer.email !== want.email) patch.email = want.email;
    if (want.name && customer.name !== want.name) patch.name = want.name;
    if (Object.keys(patch).length > 0) {
      pastDeadline(ctx.deadline);
      await stripe.customers.update(customer.id, patch, {
        idempotencyKey: brokerageKey(org, mode, `customer_update:v${deal.version}:${digest(patch)}`),
      });
    }

    // ---- subscription ----
    let sub: Stripe.Subscription | null = null;
    if (mirror.stripe_subscription_id) {
      pastDeadline(ctx.deadline);
      sub = await stripe.subscriptions.retrieve(mirror.stripe_subscription_id);
      if (ENDED.has(sub.status)) sub = null;
    }
    if (!sub) {
      pastDeadline(ctx.deadline);
      const list = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });
      sub = list.data.find((s) => s.metadata?.kind === 'brokerage' && !ENDED.has(s.status)) ?? null;
    }
    if (!sub) {
      pastDeadline(ctx.deadline);
      sub = await stripe.subscriptions.create(subscriptionCreateParams(customer.id, org, deal, unitAmount), {
        idempotencyKey: brokerageKey(org, mode, `subscription:v${deal.version}`),
      });
    }
    if (sub.id !== mirror.stripe_subscription_id) {
      await rpc(service, '_billing_apply_org_subscription', {
        p_org: org,
        p_mode: mode,
        p_fields: { stripe_customer_id: customer.id, stripe_subscription_id: sub.id },
        p_event_created: null,
      });
    }

    const item = sub.items?.data?.[0];
    if (!item) throw new NonRetryableOutboxError('subscription_has_no_item');
    const qtyDiffers = item.quantity !== deal.seats;
    const priceDiffers = item.price?.unit_amount !== unitAmount;
    if (qtyDiffers || priceDiffers) {
      const itemPatch: Stripe.SubscriptionUpdateParams.Item = { id: item.id, quantity: deal.seats };
      if (priceDiffers) {
        itemPatch.price_data = {
          currency: 'usd',
          product: BROKERAGE_PRODUCT_ID,
          unit_amount: unitAmount,
          recurring: { interval: 'month' },
        };
      }
      const params: Stripe.SubscriptionUpdateParams = { items: [itemPatch], proration_behavior: 'none' };
      pastDeadline(ctx.deadline);
      await stripe.subscriptions.update(sub.id, params, {
        idempotencyKey: brokerageKey(org, mode, `subscription_update:v${deal.version}:${digest(params)}`),
      });
    }
  } finally {
    await service
      .rpc('_billing_org_sync_release', { p_org: org, p_mode: mode, p_holder: row.id })
      .then(
        () => undefined,
        () => undefined
      );
  }
};
