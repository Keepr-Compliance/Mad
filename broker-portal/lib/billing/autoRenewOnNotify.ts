/**
 * billing_outbox kind `notify_auto_renew_on` — BACKLOG-4045.
 *
 * Enqueued by the database (_billing_set_auto_renew, migration 20261107140000) when Keepr staff
 * turned a brokerage's auto-renew back on and the deal is active again. Dedupe key
 * 'notify_auto_renew_on:<mode>:<org>:v<deal version>'. Payload: {organization_id, version}.
 *
 * Same contract as seatsAddedNotify.ts, resolved at RUN time, with two additions:
 *  - The deal is no longer active (turned off again, suspended, ended) -> nothing to send.
 *  - Superseded: the newest auto-renew change for the org (billing_change_log action
 *    auto_renew_on / auto_renew_off, newest by detail.version) is not this row's version -> nothing
 *    to send. Off then on again before the drain runs therefore sends one email (the latest), and a
 *    deal-version bump by any other writer (seats, contacts) does not suppress it. No auto-renew
 *    change found at all -> nothing to send.
 *  - Recipient: org_deals.billing_contact_email, read now. None -> nothing to send; never an error.
 *  - A send already in email_delivery_log for this row's key -> no second send.
 * One email, three sentences, log type 'other'. No Stripe call is made.
 */

import { sendAutoRenewOnEmail } from '@/lib/email';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_AUTO_RENEW_ON_KIND = 'notify_auto_renew_on';
export const AUTO_RENEW_ON_LOG_KIND = 'auto_renew_on';

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', AUTO_RENEW_ON_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** The deal version of the newest auto-renew change for the org, or null when there is none. */
async function newestAutoRenewVersion(service: ServiceClient, org: string): Promise<number | null> {
  const { data, error } = await service
    .from('billing_change_log')
    .select('detail')
    .eq('organization_id', org)
    .in('action', ['auto_renew_on', 'auto_renew_off']);
  if (error) throw new Error(`billing_change_log read failed: ${error.code ?? 'unknown'}`);
  let newest: number | null = null;
  for (const r of (data ?? []) as { detail?: { version?: unknown } | null }[]) {
    const v = int(r.detail?.version);
    if (v !== null && (newest === null || v > newest)) newest = v;
  }
  return newest;
}

export const handleNotifyAutoRenewOnRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const version = int(row.payload?.version);
  if (!org || version === null) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: deal, error: dErr } = await service
    .from('org_deals')
    .select('status, billing_contact_email')
    .eq('organization_id', org)
    .maybeSingle();
  if (dErr) throw new Error(`org_deals read failed: ${dErr.code ?? 'unknown'}`);
  const d = deal as { status?: string | null; billing_contact_email?: string | null } | null;
  if (d?.status !== 'active') {
    console.info(`[billing/auto-renew-on] ${row.id}: deal is not active; nothing to send`);
    return;
  }
  if ((await newestAutoRenewVersion(service, org)) !== version) {
    console.info(`[billing/auto-renew-on] ${row.id}: superseded by a later auto-renew change; nothing to send`);
    return;
  }
  const email = (d.billing_contact_email ?? '').trim();
  if (!email) {
    console.info(`[billing/auto-renew-on] ${row.id}: no billing contact email; nothing to send`);
    return;
  }
  if (await alreadySent(service, row.dedupe_key)) return;

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';

  const result = await sendAutoRenewOnEmail({
    recipientEmail: email,
    brokerageName,
    outboxKey: row.dedupe_key,
    organizationId: org,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
