/**
 * billing_outbox kind `notify_seats_added` — BACKLOG-3854 (founder d0c22cef #2).
 *
 * Enqueued by the database (broker_add_seats, migration 20261021020000) after a Broker or Admin
 * added seats on the Billing page; the account manager's alert is a separate
 * notify_account_manager row (reason seats_added). Dedupe key
 * 'notify_seats_added:<mode>:<org>:v<deal version>' (one per add).
 * Payload: {organization_id, seats_from, seats_to, version, trialing, added_by}.
 *
 * Resolved at RUN time (outboxKinds.ts contract):
 *  - Recipient: org_deals.billing_contact_email, read now. None -> nothing to send (the account
 *    manager alert still goes); never an error.
 *  - A send already in email_delivery_log for this row's key -> no second send.
 * One email, three sentences, log type 'other' (the 4001 email_type check admits no new type).
 * No Stripe call is made.
 */

import { sendSeatsAddedEmail } from '@/lib/email';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_SEATS_ADDED_KIND = 'notify_seats_added';
export const SEATS_ADDED_LOG_KIND = 'seats_added';

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', SEATS_ADDED_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export const handleNotifySeatsAddedRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const from = int(row.payload?.seats_from);
  const to = int(row.payload?.seats_to);
  if (!org || from === null || to === null) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: deal, error: dErr } = await service
    .from('org_deals')
    .select('billing_contact_email')
    .eq('organization_id', org)
    .maybeSingle();
  if (dErr) throw new Error(`org_deals read failed: ${dErr.code ?? 'unknown'}`);
  const email = ((deal as { billing_contact_email?: string | null } | null)?.billing_contact_email ?? '').trim();
  if (!email) {
    console.info(`[billing/seats-added] ${row.id}: no billing contact email; nothing to send`);
    return;
  }
  if (await alreadySent(service, row.dedupe_key)) return;

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';
  const addedBy = typeof row.payload?.added_by === 'string' && row.payload.added_by.trim() ? row.payload.added_by.trim() : 'A Broker or Admin';

  const result = await sendSeatsAddedEmail({
    recipientEmail: email,
    brokerageName,
    seatsFrom: from,
    seatsTo: to,
    trialing: row.payload?.trialing === true,
    addedBy,
    outboxKey: row.dedupe_key,
    organizationId: org,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
