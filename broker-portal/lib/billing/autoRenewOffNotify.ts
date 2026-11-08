/**
 * billing_outbox kind `notify_auto_renew_off` — BACKLOG-4200.
 *
 * Enqueued by the database (_billing_set_auto_renew, migration 20261108170000) when Keepr staff
 * turned a brokerage's auto-renew off, the deal is canceling (not suspended), staff left "Email the
 * billing contact" ticked and the deal has a billing contact email. Dedupe key
 * 'notify_auto_renew_off:<mode>:<org>:v<deal version>'. Payload: {organization_id, version}.
 *
 * Same contract as autoRenewOnNotify.ts, resolved at RUN time:
 *  - The deal is no longer canceling (turned back on, suspended, ended) -> nothing to send.
 *  - Superseded: the newest auto-renew change for the org (by detail.version) is not this row's
 *    version -> nothing to send. Off then on again before the drain sends only the "on" email.
 *  - Recipient: org_deals.billing_contact_email, read now. None -> nothing to send; never an error.
 *  - A send already in email_delivery_log for this row's key -> no second send.
 *  - The end date is org_billing_stripe.current_period_end for the deal's mode, only while it is
 *    still in the future (SR C3); otherwise the email says "at the end of the billing period".
 * One email, three sentences, log type 'other'. No Stripe call is made.
 */

import { sendAutoRenewOffEmail } from '@/lib/email';
import { formatPlanDate } from './planEnd';
import { newestAutoRenewVersion } from './autoRenewOnNotify';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_AUTO_RENEW_OFF_KIND = 'notify_auto_renew_off';
export const AUTO_RENEW_OFF_LOG_KIND = 'auto_renew_off';

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', AUTO_RENEW_OFF_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

/** The period end as "Nov 27, 2026" while it is still ahead of `now`; otherwise null. */
export function futurePlanDate(iso: unknown, now: number = Date.now()): string | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= now) return null;
  return formatPlanDate(iso);
}

export const handleNotifyAutoRenewOffRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const v = row.payload?.version;
  const version = typeof v === 'number' && Number.isInteger(v) ? v : null;
  if (!org || version === null) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: deal, error: dErr } = await service
    .from('org_deals')
    .select('status, billing_contact_email, stripe_mode')
    .eq('organization_id', org)
    .maybeSingle();
  if (dErr) throw new Error(`org_deals read failed: ${dErr.code ?? 'unknown'}`);
  const d = deal as { status?: string | null; billing_contact_email?: string | null; stripe_mode?: string | null } | null;
  if (d?.status !== 'canceling') {
    console.info(`[billing/auto-renew-off] ${row.id}: deal is not canceling; nothing to send`);
    return;
  }
  if ((await newestAutoRenewVersion(service, org)) !== version) {
    console.info(`[billing/auto-renew-off] ${row.id}: superseded by a later auto-renew change; nothing to send`);
    return;
  }
  const email = (d.billing_contact_email ?? '').trim();
  if (!email) {
    console.info(`[billing/auto-renew-off] ${row.id}: no billing contact email; nothing to send`);
    return;
  }
  if (await alreadySent(service, row.dedupe_key)) return;

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';

  const { data: sub, error: sErr } = await service
    .from('org_billing_stripe')
    .select('current_period_end')
    .eq('organization_id', org)
    .eq('stripe_mode', d.stripe_mode ?? row.stripe_mode)
    .maybeSingle();
  if (sErr) throw new Error(`org_billing_stripe read failed: ${sErr.code ?? 'unknown'}`);
  const endsOn = futurePlanDate((sub as { current_period_end?: unknown } | null)?.current_period_end);

  const result = await sendAutoRenewOffEmail({
    recipientEmail: email,
    brokerageName,
    endsOn,
    outboxKey: row.dedupe_key,
    organizationId: org,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
