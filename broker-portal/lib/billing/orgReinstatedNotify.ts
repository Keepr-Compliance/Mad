/**
 * billing_outbox kind `notify_org_reinstated` — BACKLOG-4209.
 *
 * Enqueued by the database (_billing_reinstate_org, migration 20261108180000) when a suspended
 * brokerage is reinstated, by Keepr staff ("Email the billing contact" ticked) or automatically
 * after an overdue invoice is paid, and the deal has a billing contact email. One row per lifted
 * suspension: dedupe key 'notify_org_reinstated:<mode>:<org>:<epoch of suspended_at>'.
 * Payload: {organization_id, suspended_at_epoch, via: 'staff' | 'auto'}; via picks the email.
 *
 * Same contract as autoRenewOnNotify.ts, resolved at RUN time:
 *  - The deal is not active or canceling (suspended again, ended) -> nothing to send.
 *  - Superseded: find the 'reinstated' change-log row whose detail.suspended_at_epoch is this row's
 *    epoch. None -> nothing. Any 'suspended' or other 'reinstated' row for the org with a strictly
 *    later created_at -> nothing. Rows of one transaction share created_at, and equal is not later.
 *  - Recipient: org_deals.billing_contact_email, read now. None -> nothing to send; never an error.
 *  - A send already in email_delivery_log for this row's key -> no second send.
 *  - The billing line never states anything false (SR RC1, D1): no subscription row, or it is
 *    canceled -> the line is left out; deal active -> renews; deal canceling -> ends on the period
 *    end while it is still ahead, else "at the end of the billing period".
 * One email, log type 'other'. No Stripe call is made.
 */

import { sendOrgAutoReinstatedEmail, sendOrgReinstatedEmail } from '@/lib/email';
import type { BillingLine } from '@/lib/email/types';
import { futurePlanDate } from './autoRenewOffNotify';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_ORG_REINSTATED_KIND = 'notify_org_reinstated';
export const ORG_REINSTATED_LOG_KIND = 'org_reinstated';

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', ORG_REINSTATED_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

type LogRow = { action?: string | null; created_at?: string | null; detail?: { suspended_at_epoch?: unknown } | null };

/** True when this reinstatement is still the newest suspend/reinstate event for the org. */
async function isLatestReinstatement(service: ServiceClient, org: string, epoch: number): Promise<boolean> {
  const { data, error } = await service
    .from('billing_change_log')
    .select('action, created_at, detail')
    .eq('organization_id', org)
    .in('action', ['suspended', 'reinstated']);
  if (error) throw new Error(`billing_change_log read failed: ${error.code ?? 'unknown'}`);
  const rows = (data ?? []) as LogRow[];
  const mine = rows.find((r) => r.action === 'reinstated' && r.detail?.suspended_at_epoch === epoch);
  if (!mine) return false;
  const at = Date.parse(mine.created_at ?? '');
  return !rows.some((r) => r !== mine && Date.parse(r.created_at ?? '') > at);
}

export const handleNotifyOrgReinstatedRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const e = row.payload?.suspended_at_epoch;
  const epoch = typeof e === 'number' && Number.isInteger(e) ? e : null;
  const via = row.payload?.via;
  if (!org || epoch === null || (via !== 'staff' && via !== 'auto')) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: deal, error: dErr } = await service
    .from('org_deals')
    .select('status, billing_contact_email, stripe_mode')
    .eq('organization_id', org)
    .maybeSingle();
  if (dErr) throw new Error(`org_deals read failed: ${dErr.code ?? 'unknown'}`);
  const d = deal as { status?: string | null; billing_contact_email?: string | null; stripe_mode?: string | null } | null;
  if (d?.status !== 'active' && d?.status !== 'canceling') {
    console.info(`[billing/org-reinstated] ${row.id}: deal is not active or canceling; nothing to send`);
    return;
  }
  if (!(await isLatestReinstatement(service, org, epoch))) {
    console.info(`[billing/org-reinstated] ${row.id}: superseded by a later suspension or reinstatement; nothing to send`);
    return;
  }
  const email = (d.billing_contact_email ?? '').trim();
  if (!email) {
    console.info(`[billing/org-reinstated] ${row.id}: no billing contact email; nothing to send`);
    return;
  }
  if (await alreadySent(service, row.dedupe_key)) return;

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';

  const { data: sub, error: sErr } = await service
    .from('org_billing_stripe')
    .select('status, stripe_subscription_id, current_period_end')
    .eq('organization_id', org)
    .eq('stripe_mode', d.stripe_mode ?? row.stripe_mode)
    .maybeSingle();
  if (sErr) throw new Error(`org_billing_stripe read failed: ${sErr.code ?? 'unknown'}`);
  const s = sub as { status?: string | null; stripe_subscription_id?: string | null; current_period_end?: unknown } | null;
  let billing: BillingLine;
  if (!s || !s.stripe_subscription_id || !s.status || s.status === 'canceled') {
    console.info(`[billing/org-reinstated] ${row.id}: no live subscription; sending without the billing line`);
    billing = { kind: 'none' };
  } else if (d.status === 'active') {
    billing = { kind: 'renews' };
  } else {
    billing = { kind: 'ends', endsOn: futurePlanDate(s.current_period_end) };
  }

  const params = { recipientEmail: email, brokerageName, billing, outboxKey: row.dedupe_key, organizationId: org };
  const result = via === 'auto' ? await sendOrgAutoReinstatedEmail(params) : await sendOrgReinstatedEmail(params);
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
