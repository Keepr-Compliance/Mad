/**
 * Brokerage billing emails — BACKLOG-3853 PR-2. Two billing_outbox kinds:
 *
 *  - notify_org_suspended: "account suspended" to the deal's billing contact. Enqueued by the
 *    org_deals trigger when a deal becomes suspended (payload carries suspended_at_epoch).
 *    At run time the deal must still be suspended with that same suspended_at; a reinstate,
 *    or a later re-suspension (which has its own row), makes this row do nothing (converge).
 *    No billing contact -> NonRetryable 'no_recipient' (parked + outbox alert).
 *  - notify_account_manager: an internal alert to the deal's account manager (overdue,
 *    payment failed, refund, dispute). Enqueued by the brokerage webhook (./brokerage.ts).
 *    No account manager, or one without a sign-in email -> alert 'brokerage_no_account_manager'
 *    and done. Overdue NEVER suspends (founder ruling): the account manager decides.
 *
 * Both check email_delivery_log for their own outboxKey first, so a run that sent and then lost
 * its lease does not send twice.
 *
 * BACKLOG-3853 PR-2B: a Non-payment "account suspended" email carries a "Pay overdue invoice"
 * button (founder 64e00066, 1e164f56 Q1: Non-payment only). The invoice is read from Stripe at
 * send time with the row's own client and mode (nothing stores invoice URLs):
 *   - reason 'other' -> no Stripe call, no button.
 *   - no org_billing_stripe row / no customer -> no button, "contact your account manager" + alert.
 *   - the oldest OVERDUE open invoice (./overdue.ts, the rule tryAutoReinstate waits on), else the
 *     oldest open one. "Now" is the customer's test clock time in TEST.
 *   - no open invoice at all -> contradictory state: alert + "contact your account manager".
 *   - a Stripe error throws (the row retries with backoff; never a buttonless send, which the
 *     alreadySent dedupe would freeze), EXCEPT on the last try or when the Stripe customer is
 *     gone: then send without the button ("pay from Stripe's invoice email") + alert, so the
 *     billing contact is never left with no email.
 */

import type { createServiceClient } from '@/lib/supabase/service';
import { sendAccountManagerAlertEmail, sendAccountSuspendedEmail } from '@/lib/email';
import type { AccountManagerAlertReason } from '@/lib/email/types';
import { billingAlert } from './alert';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxHandlerContext, type OutboxRow } from './outboxKinds';
import { OUTBOX_MAX_ATTEMPTS } from './outbox';
import { listOpenInvoices, oldestOf, overdueOf, stripeNow } from './overdue';
import type { AccountSuspendedPayment } from '@/lib/email/types';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_ORG_SUSPENDED_KIND = 'notify_org_suspended';
export const NOTIFY_ACCOUNT_MANAGER_KIND = 'notify_account_manager';
const AM_REASONS = new Set<AccountManagerAlertReason>(['overdue', 'payment_failed', 'refund', 'dispute']);

interface DealRow {
  status: string;
  suspended_at: string | null;
  suspended_reason: 'non_payment' | 'other' | null;
  billing_contact_email: string | null;
  account_manager_id: string | null;
}

function orgOf(row: OutboxRow): string {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  if (!org) throw new NonRetryableOutboxError('bad_payload');
  return org;
}

async function readDeal(service: ServiceClient, org: string): Promise<DealRow | null> {
  const { data, error } = await service
    .from('org_deals')
    .select('status, suspended_at, suspended_reason, billing_contact_email, account_manager_id')
    .eq('organization_id', org)
    .maybeSingle();
  if (error) throw new Error(`org_deals read failed: ${error.code ?? 'unknown'}`);
  return (data as DealRow | null) ?? null;
}

async function orgName(service: ServiceClient, org: string): Promise<string> {
  const { data, error } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (error) throw new Error(`organizations read failed: ${error.code ?? 'unknown'}`);
  return ((data as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';
}

async function alreadySent(service: ServiceClient, kind: string, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', kind)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

function epochSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function outcome(result: { outcome?: string }): void {
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
}

function pastDeadline(deadline: Date): void {
  if (Date.now() >= deadline.getTime()) throw new Error('outbox deadline reached');
}

function isMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

async function stripeCustomerOf(ctx: OutboxHandlerContext, org: string): Promise<string | null> {
  const { data, error } = await ctx.service
    .from('org_billing_stripe')
    .select('stripe_customer_id')
    .eq('organization_id', org)
    .eq('stripe_mode', ctx.mode)
    .maybeSingle();
  if (error) throw new Error(`org_billing_stripe read failed: ${error.code ?? 'unknown'}`);
  return (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
}

/** How the billing contact pays a non-payment suspension. See the header for each branch. */
async function suspendedPayment(row: OutboxRow, ctx: OutboxHandlerContext, org: string): Promise<AccountSuspendedPayment> {
  const customerId = await stripeCustomerOf(ctx, org);
  if (!customerId) {
    billingAlert('brokerage_suspended_no_invoice', ctx.mode, { organization_id: org, cause: 'no_customer' });
    return { kind: 'none' };
  }
  try {
    pastDeadline(ctx.deadline);
    const now = await stripeNow(ctx, customerId);
    pastDeadline(ctx.deadline);
    const open = await listOpenInvoices(ctx, customerId);
    const overdue = overdueOf(open, now);
    const chosen = overdue[0] ?? oldestOf(open);
    const url = chosen?.hosted_invoice_url ?? null;
    if (!chosen || !url || !url.startsWith('https://')) {
      billingAlert('brokerage_suspended_no_invoice', ctx.mode, {
        organization_id: org,
        cause: chosen ? 'no_hosted_url' : 'no_open_invoice',
      });
      return { kind: 'none' };
    }
    return { kind: 'invoice', url, overdueCount: overdue.length };
  } catch (err) {
    const missing = isMissing(err);
    if (missing || row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      billingAlert('brokerage_suspended_invoice_lookup_failed', ctx.mode, {
        organization_id: org,
        cause: missing ? 'resource_missing' : 'last_try',
        attempts: row.attempts,
      });
      return { kind: 'stripe_email' };
    }
    throw err;
  }
}

export const handleNotifyOrgSuspendedRow: OutboxHandler = async (row, ctx) => {
  const org = orgOf(row);
  const wantEpoch = typeof row.payload?.suspended_at_epoch === 'number' ? row.payload.suspended_at_epoch : null;
  const deal = await readDeal(ctx.service, org);
  if (!deal || deal.status !== 'suspended') {
    console.info(`[billing/brokerage-notify] ${row.id}: deal no longer suspended; nothing to send`);
    return;
  }
  if (wantEpoch !== null && epochSeconds(deal.suspended_at) !== wantEpoch) {
    console.info(`[billing/brokerage-notify] ${row.id}: a newer suspension has its own row; nothing to send`);
    return;
  }
  if (await alreadySent(ctx.service, 'account_suspended', row.dedupe_key)) return;
  const recipientEmail = deal.billing_contact_email?.trim();
  if (!recipientEmail) throw new NonRetryableOutboxError('no_recipient');

  const reason = deal.suspended_reason === 'non_payment' ? 'non_payment' : 'other';
  // Founder 1e164f56 Q1: the Pay button is for a Non-payment suspension only; an Other
  // suspension makes no Stripe call.
  const payment: AccountSuspendedPayment = reason === 'non_payment' ? await suspendedPayment(row, ctx, org) : { kind: 'none' };

  outcome(
    await sendAccountSuspendedEmail({
      recipientEmail,
      brokerageName: await orgName(ctx.service, org),
      reason,
      payment,
      outboxKey: row.dedupe_key,
      organizationId: org,
    })
  );
};

export const handleNotifyAccountManagerRow: OutboxHandler = async (row, ctx) => {
  const org = orgOf(row);
  const reason = row.payload?.reason as AccountManagerAlertReason;
  if (!AM_REASONS.has(reason)) throw new NonRetryableOutboxError('bad_payload');
  const objectId = typeof row.payload?.stripe_object_id === 'string' ? row.payload.stripe_object_id : null;

  const deal = await readDeal(ctx.service, org);
  if (!deal) throw new NonRetryableOutboxError('no_deal');
  if (await alreadySent(ctx.service, 'brokerage_account_manager_alert', row.dedupe_key)) return;
  if (!deal.account_manager_id) {
    billingAlert('brokerage_no_account_manager', ctx.mode, { organization_id: org, reason });
    return;
  }
  const { data, error } = await ctx.service.auth.admin.getUserById(deal.account_manager_id);
  if (error) throw new Error('account manager lookup failed');
  const recipientEmail = data?.user?.email ?? null;
  if (!recipientEmail) {
    billingAlert('brokerage_no_account_manager', ctx.mode, { organization_id: org, reason });
    return;
  }

  outcome(
    await sendAccountManagerAlertEmail({
      recipientEmail,
      brokerageName: await orgName(ctx.service, org),
      reason,
      stripeObjectId: objectId,
      outboxKey: row.dedupe_key,
      organizationId: org,
    })
  );
};
