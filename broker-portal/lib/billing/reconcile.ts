/**
 * Nightly Agent-subscription reconcile and billing queue check (BACKLOG-3849,
 * PR-2; plan step 0 §2h + SR R10).
 *
 * Runs from the existing payment-reconcile cron, after its PaymentIntent loop,
 * and only while billing is on. It repairs what a missed webhook leaves behind,
 * through the webhook's own rules, never by a rule of its own:
 *
 *  - Forward: a Stripe Agent subscription that is `active`/`trialing` in this
 *    key's mode, whose user has NO effective Stripe override. The only repair is
 *    `handleInvoicePaid` on the subscription's latest invoice, which grants only
 *    when that invoice is paid, not refunded or disputed, pays the current
 *    period, and the subscription is active and not paused. The status of the
 *    subscription alone never grants. A subscription with an End plan now
 *    cancel still pending in billing_outbox (BACKLOG-3848) is left alone, and a
 *    latest invoice that is not `paid` (void, uncollectible, open, draft) is
 *    reported, never granted.
 *  - Reverse: a user with an effective Stripe override and no `active`/
 *    `trialing`, unpaused subscription in Stripe. Repair: `revokeIfCurrent`
 *    (the 3846 revoke rule). The population is billing_subscriptions rows of
 *    THIS mode: the override itself carries no mode, and one database serves
 *    both modes, so a live run must never reach a test user (and the reverse).
 *    A user can have several mirror rows (a re-subscriber). The revoke is made
 *    against the user's one mirror row whose status is open (a missed webhook
 *    leaves the current row reading open); with two or more open rows it is
 *    reported and nothing is revoked. With none open, any row serves (the
 *    "other open subscription" check then finds nothing either way).
 *  - Non-Stripe overrides (support / manual): the grant RPC refuses whenever
 *    such an override exists, whatever `enabled` says (`non_stripe_override`),
 *    so forward never calls `handleInvoicePaid` for that user. Enabled = held
 *    by support, in sync. Not enabled = a paying agent blocked by a dead manual
 *    override that is disabled or expired: counted in `overrideBlocked` and alerted (separate from `mismatches`).
 *  - Never `handleSubscriptionEvent` or `syncSubscription(..., { advanceCursor:
 *    true })`: a synthetic event must not move the webhook's ordering cursor.
 *
 * "Effective Stripe override" = organization_plans.feature_overrides
 * .unlimited_transactions with source 'stripe', enabled true and paid_through
 * strictly after now.
 *
 * Suspension safety net (BACKLOG-3878, SR R7). The licences trigger swallows
 * its own failure (a WARNING never blocks a suspension), and a pause row can
 * park, so:
 *  - a suspended licence whose customer (this mode) has an open, UNPAUSED
 *    Agent subscription -> a `pause_agent_subscription` row is enqueued (unless
 *    one is already waiting) and `suspended_subscription_unpaused` fires;
 *  - a paused subscription (forward list) whose licence is active and that has
 *    no unprocessed `resume_agent_subscription` row -> alert only
 *    (`paused_subscription_licence_active`); support decides.
 *
 * Cap: each side looks at RECONCILE_MAX_ITEMS per run and sets `truncated`
 * (carried by the alert) when there were more. Stripe lists newest first, so
 * above the cap the OLDEST subscriptions are never checked, and it is the same
 * 200 every night. The reverse read has no ORDER BY, so above the cap which
 * users are skipped is unspecified but equally stable in practice.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { billingAlert } from './alert';
import { getPersonalOrganization, getStripeCustomer } from './customers';
import type { StripeMode } from './mode';
import { parseRunAfter, OUTBOX_STALE_AFTER_MS } from './outbox';
import { END_NOW_KIND } from './endPlanNow';
import { enqueueOutbox } from './outboxEnqueue';
import { licenceStatus, PAUSE_KIND, RESUME_KIND } from './suspension';
import { isNonStripeOverride, overrideEffective, type UnlimitedOverride } from './agentPlan';
import { handleInvoicePaid, listAll, OPEN_STATUSES, revokeIfCurrent, stripeId, type BillingContext } from './sync';

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Subscription statuses the forward scan lists (open AND entitled: SR R10.4). */
export const RECONCILE_LIST_STATUSES = ['active', 'trialing'] as const;
/**
 * Most subscriptions / users looked at per side per run. More sets `truncated`
 * (reported, not processed). Above it the oldest subscriptions are never
 * reconciled: see the header.
 */
export const RECONCILE_MAX_ITEMS = 200;
/** Unprocessed outbox rows read per run for the queue check. */
export const OUTBOX_HEALTH_READ_LIMIT = 1000;

export interface ReconcileDeps {
  service: ServiceClient;
  stripe: Stripe;
  mode: StripeMode;
  now?: () => Date;
}

export interface ReconcileResult {
  forwardScanned: number;
  regrantAttempted: number;
  reverseScanned: number;
  revokeAttempted: number;
  mismatches: number;
  /** Forward: paying agents whose non-Stripe override is present but not enabled (grant RPC would refuse). */
  overrideBlocked: number;
  truncated: boolean;
  /** BACKLOG-3878 R7: suspended licences with an unpaused Agent plan (a pause is enqueued for each). */
  suspendedUnpaused: number;
  /** BACKLOG-3878 R7: paused plans whose licence is active with no resume waiting (alert only). */
  pausedLicenceActive: number;
}

/** The R10.1 definition. Anything else (absent, non-stripe, disabled, expired, malformed) is not effective. */
export function stripeOverrideEffective(override: unknown, now: Date): boolean {
  if (!override || typeof override !== 'object') return false;
  const o = override as Record<string, unknown>;
  if (o.source !== 'stripe') return false;
  if (o.enabled !== true) return false;
  if (typeof o.paid_through !== 'string') return false;
  const t = Date.parse(o.paid_through);
  return Number.isFinite(t) && t > now.getTime();
}

async function readOverride(service: ServiceClient, userId: string): Promise<unknown> {
  const org = await getPersonalOrganization(service, userId);
  if (!org) return undefined;
  const { data, error } = await service
    .from('organization_plans')
    .select('feature_overrides')
    .eq('organization_id', org.id)
    .maybeSingle();
  if (error) throw new Error(`organization_plans read failed: ${error.message}`);
  const fo = (data as { feature_overrides?: Record<string, unknown> | null } | null)?.feature_overrides;
  return fo?.unlimited_transactions;
}

function reconcileContext(deps: ReconcileDeps, subId: string, now: Date): BillingContext {
  return {
    service: deps.service,
    stripe: deps.stripe,
    mode: deps.mode,
    event: {
      id: `reconcile:${subId}`,
      type: 'reconcile',
      livemode: deps.mode === 'live',
      created: Math.floor(now.getTime() / 1000),
    },
  };
}

/** True when End plan now left a cancel for this subscription in the queue (3848). */
async function endNowPending(service: ServiceClient, mode: StripeMode, subId: string): Promise<boolean> {
  const { data, error } = await service
    .from('billing_outbox')
    .select('id')
    .eq('stripe_mode', mode)
    .eq('kind', END_NOW_KIND)
    .eq('dedupe_key', `end-now:${mode}:${subId}`)
    .is('processed_at', null)
    .limit(1);
  if (error) throw new Error(`billing_outbox read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

/** The Agent user of a listed subscription, or null. Same identity rule as the webhook (stored customer row). */
async function agentUserOf(deps: ReconcileDeps, sub: Stripe.Subscription): Promise<string | null> {
  const kind = sub.metadata?.kind;
  if (kind && kind !== 'agent') return null;
  const customerId = stripeId(sub.customer);
  if (!customerId) return null;
  const { data, error } = await deps.service
    .from('stripe_customers')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .eq('stripe_mode', deps.mode)
    .maybeSingle();
  if (error) throw new Error(`stripe_customers read failed: ${error.message}`);
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

function entitledInStripe(sub: Pick<Stripe.Subscription, 'status' | 'pause_collection'>): boolean {
  return (sub.status === 'active' || sub.status === 'trialing') && !sub.pause_collection;
}

export async function reconcileAgentSubscriptions(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: ReconcileResult = {
    forwardScanned: 0,
    regrantAttempted: 0,
    reverseScanned: 0,
    revokeAttempted: 0,
    mismatches: 0,
    overrideBlocked: 0,
    truncated: false,
    suspendedUnpaused: 0,
    pausedLicenceActive: 0,
  };
  const mismatchIds: string[] = [];
  const pausedActiveIds: string[] = [];

  // ---- forward: open in Stripe, not entitled in DB
  const listed: Stripe.Subscription[] = [];
  for (const status of RECONCILE_LIST_STATUSES) {
    listed.push(
      ...(await listAll((after) =>
        deps.stripe.subscriptions.list({ status, limit: 100, ...(after ? { starting_after: after } : {}) })
      ))
    );
  }
  if (listed.length > RECONCILE_MAX_ITEMS) result.truncated = true;

  for (const sub of listed.slice(0, RECONCILE_MAX_ITEMS)) {
    try {
      const userId = await agentUserOf(deps, sub);
      if (!userId) continue;
      result.forwardScanned++;
      if (sub.pause_collection && (await pausedWithLicenceActive(deps, userId))) {
        result.pausedLicenceActive++;
        pausedActiveIds.push(sub.id);
      }
      if (!entitledInStripe(sub)) continue; // paused: no access is the right state
      const override = await readOverride(deps.service, userId);
      if (stripeOverrideEffective(override, now)) continue;
      if (isNonStripeOverride(override as UnlimitedOverride | undefined)) {
        // The grant RPC refuses non_stripe_override whatever `enabled` says.
        // Held by support (in sync) only while the override is effective and not disabled; an absent
        // `enabled` counts as enabled, matching COALESCE(enabled, true) in check_feature_access.
        const held = overrideEffective(override as UnlimitedOverride, now) && (override as { enabled?: unknown } | null)?.enabled !== false;
        if (held) continue;
        result.overrideBlocked++;
        mismatchIds.push(sub.id);
        console.warn(`[billing/reconcile] forward ${sub.id}: open subscription blocked by a non-Stripe override that is not enabled`);
        continue;
      }

      // Not entitled although Stripe lists the plan as open.
      result.mismatches++;
      mismatchIds.push(sub.id);
      if (await endNowPending(deps.service, deps.mode, sub.id)) continue;
      const invoiceId = stripeId(sub.latest_invoice);
      if (!invoiceId) continue;
      const latest = await deps.stripe.invoices.retrieve(invoiceId);
      if (latest.status !== 'paid') continue;
      result.regrantAttempted++;
      await handleInvoicePaid(reconcileContext(deps, sub.id, now), invoiceId);
    } catch (err) {
      console.error(`[billing/reconcile] forward ${sub.id} failed: ${(err as { code?: string }).code ?? 'error'}`);
    }
  }

  // ---- reverse: entitled in DB, nothing open in Stripe (this mode's users only)
  const { data: rows, error } = await deps.service
    .from('billing_subscriptions')
    .select('user_id, stripe_subscription_id, status')
    .eq('stripe_mode', deps.mode)
    .limit(RECONCILE_MAX_ITEMS * 5);
  if (error) throw new Error(`billing_subscriptions read failed: ${error.message}`);
  type MirrorRow = { user_id: string; stripe_subscription_id: string; status: string };
  const byUser = new Map<string, MirrorRow[]>();
  for (const r of (rows as MirrorRow[] | null) ?? []) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }
  const users = [...byUser.entries()];
  if (users.length > RECONCILE_MAX_ITEMS) result.truncated = true;
  const openStatus = new Set<string>(OPEN_STATUSES);

  for (const [userId, mirrorRows] of users.slice(0, RECONCILE_MAX_ITEMS)) {
    const mirrorSubId = mirrorRows[0].stripe_subscription_id; // for log/report lines only
    try {
      result.reverseScanned++;
      if (!stripeOverrideEffective(await readOverride(deps.service, userId), now)) continue;
      const customer = await getStripeCustomer(deps.service, userId, deps.mode);
      const customerId = customer?.stripe_customer_id;
      if (!customerId) {
        // A mirror row without a customer row in this mode: report, never revoke on a guess.
        result.mismatches++;
        mismatchIds.push(mirrorSubId);
        continue;
      }
      const subs = await listAll((after) =>
        deps.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(after ? { starting_after: after } : {}) })
      );
      const open = subs.find((s) => (!s.metadata?.kind || s.metadata.kind === 'agent') && entitledInStripe(s));
      if (open) continue;
      result.mismatches++;
      const openRows = mirrorRows.filter((r) => openStatus.has(r.status));
      if (openRows.length > 1) {
        // More than one mirror row reads open: report, never revoke on a guess.
        mismatchIds.push(...openRows.map((r) => r.stripe_subscription_id));
        continue;
      }
      const target = (openRows[0] ?? mirrorRows[0]).stripe_subscription_id;
      mismatchIds.push(target);
      if (await revokeIfCurrent(reconcileContext(deps, target, now), userId, target, 'reconcile')) result.revokeAttempted++;
    } catch (err) {
      console.error(`[billing/reconcile] reverse ${mirrorSubId} failed: ${(err as { code?: string }).code ?? 'error'}`);
    }
  }

  // ---- BACKLOG-3878 R7: suspended licence, plan still collecting
  const unpausedIds = await suspendedSafetyNet(deps, result);

  if (pausedActiveIds.length > 0) {
    billingAlert('paused_subscription_licence_active', deps.mode, {
      count: pausedActiveIds.length,
      subscription_ids: pausedActiveIds.slice(0, 20).join(','),
    });
  }
  if (unpausedIds.length > 0) {
    billingAlert('suspended_subscription_unpaused', deps.mode, {
      count: unpausedIds.length,
      subscription_ids: unpausedIds.slice(0, 20).join(','),
    });
  }

  if (result.mismatches > 0 || result.overrideBlocked > 0 || result.truncated) {
    billingAlert('reconcile_mismatch', deps.mode, {
      mismatches: result.mismatches,
      regrant_attempted: result.regrantAttempted,
      revoke_attempted: result.revokeAttempted,
      override_blocked: result.overrideBlocked,
      truncated: result.truncated,
      subscription_ids: mismatchIds.slice(0, 20).join(','),
    });
  }
  return result;
}

/** True when an unprocessed row of `kind` waits for this user in this mode. */
async function outboxPending(deps: ReconcileDeps, kind: string, userId: string): Promise<boolean> {
  const { data, error } = await deps.service
    .from('billing_outbox')
    .select('id')
    .eq('stripe_mode', deps.mode)
    .eq('kind', kind)
    .eq('user_id', userId)
    .is('processed_at', null)
    .limit(1);
  if (error) throw new Error(`billing_outbox read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

/** R7 second branch: a paused plan, licence active, and no resume waiting. */
async function pausedWithLicenceActive(deps: ReconcileDeps, userId: string): Promise<boolean> {
  if ((await licenceStatus(deps.service, userId)) !== 'active') return false;
  return !(await outboxPending(deps, RESUME_KIND, userId));
}

/** Statuses in which Stripe still collects (an unpaused one charges). */
const COLLECTING = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * R7 first branch: every suspended licence whose customer in this mode has an
 * open, unpaused Agent subscription gets a pause row (unless one is waiting).
 * The dedupe key carries the licence's updated_at, so the nightly run adds at
 * most one row per suspension. Returns the subscription ids found.
 */
async function suspendedSafetyNet(deps: ReconcileDeps, result: ReconcileResult): Promise<string[]> {
  const found: string[] = [];
  const { data, error } = await deps.service
    .from('licenses')
    .select('user_id, updated_at')
    .eq('status', 'suspended')
    .limit(RECONCILE_MAX_ITEMS + 1);
  if (error) {
    console.error(`[billing/reconcile] suspended licences read failed: ${error.code ?? 'error'}`);
    return found;
  }
  const rows = (data as { user_id: string; updated_at: string | null }[] | null) ?? [];
  if (rows.length > RECONCILE_MAX_ITEMS) result.truncated = true;
  for (const lic of rows.slice(0, RECONCILE_MAX_ITEMS)) {
    try {
      const customer = await getStripeCustomer(deps.service, lic.user_id, deps.mode);
      if (!customer?.stripe_customer_id) continue;
      const subs = await listAll((after) =>
        deps.stripe.subscriptions.list({ customer: customer.stripe_customer_id, status: 'all', limit: 100, ...(after ? { starting_after: after } : {}) })
      );
      const unpaused = subs.filter((s) => (!s.metadata?.kind || s.metadata.kind === 'agent') && COLLECTING.has(s.status) && !s.pause_collection);
      if (unpaused.length === 0) continue;
      result.suspendedUnpaused++;
      found.push(...unpaused.map((s) => s.id));
      if (await outboxPending(deps, PAUSE_KIND, lic.user_id)) continue;
      await enqueueOutbox(deps.service, {
        mode: deps.mode,
        kind: PAUSE_KIND,
        userId: lic.user_id,
        dedupeKey: `pause:${deps.mode}:${lic.user_id}:reconcile:${lic.updated_at ?? 'none'}`,
        payload: { source: 'reconcile' },
        runAfter: new Date(),
      });
    } catch (err) {
      console.error(`[billing/reconcile] suspended safety net failed: ${(err as { code?: string }).code ?? 'error'}`);
    }
  }
  return found;
}

export interface OutboxHealth {
  stale: number;
  parked: number;
}

/**
 * Daily queue check (plan §2f, SR R9 predicate): one alert per category per
 * run, whatever the number of rows. Catches "the drain is not running at all",
 * which the drain cannot report about itself.
 *  - stale: unprocessed, run_after more than ten minutes past, not parked, no
 *    live lease;
 *  - parked: unprocessed with run_after 'infinity' (waiting for a person).
 */
export async function reportOutboxHealth(deps: ReconcileDeps): Promise<OutboxHealth> {
  const now = (deps.now ?? (() => new Date()))();
  const { data, error } = await deps.service
    .from('billing_outbox')
    .select('id, kind, run_after, claimed_until')
    .eq('stripe_mode', deps.mode)
    .is('processed_at', null)
    .limit(OUTBOX_HEALTH_READ_LIMIT);
  if (error) throw new Error(`billing_outbox read failed: ${error.code ?? 'unknown'}`);
  const rows = (data as { id: string; kind: string; run_after: string; claimed_until: string | null }[] | null) ?? [];

  const line = now.getTime() - OUTBOX_STALE_AFTER_MS;
  const stale: typeof rows = [];
  const parked: typeof rows = [];
  for (const r of rows) {
    const runAfter = parseRunAfter(r.run_after);
    if (runAfter === null) {
      if (/^infinity$/i.test(r.run_after)) parked.push(r);
      continue;
    }
    const lease = r.claimed_until ? Date.parse(r.claimed_until) : NaN;
    const leased = Number.isFinite(lease) && lease >= now.getTime();
    if (runAfter.getTime() < line && !leased) stale.push(r);
  }

  if (stale.length > 0) {
    const oldest = stale.map((r) => parseRunAfter(r.run_after) as Date).sort((a, b) => a.getTime() - b.getTime())[0];
    billingAlert('outbox_stale_daily', deps.mode, {
      stale_rows: stale.length,
      oldest_run_after: oldest.toISOString(),
      kinds: [...new Set(stale.map((r) => r.kind))].sort().join(','),
    });
  }
  if (parked.length > 0) {
    billingAlert('outbox_parked', deps.mode, {
      parked_rows: parked.length,
      kinds: [...new Set(parked.map((r) => r.kind))].sort().join(','),
      outbox_ids: parked.slice(0, 20).map((r) => r.id).join(','),
    });
  }
  return { stale: stale.length, parked: parked.length };
}
