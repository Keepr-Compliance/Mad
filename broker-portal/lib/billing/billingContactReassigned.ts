/**
 * billing_outbox kind `notify_billing_contact_reassigned` — BACKLOG-4007 People v2
 * (founder R9 refinement, 2026-10-20).
 *
 * Enqueued by the database (_org_billing_contact_reassign, migration 20261020200000 §8) when the
 * identity provider removed the brokerage's billing contact and the brokerage's account admin
 * (the admin who completed billing setup, else the oldest active admin) became the contact.
 * Payload: {organization_id, member_id (the new contact), contact_id, reason}.
 *
 * Resolved at RUN time (outboxKinds.ts contract):
 *  - Converge: the live billing contact is no longer this member (someone changed it since) ->
 *    nothing. A send already in email_delivery_log for this row's key -> no second send.
 *  - The member has no account email -> NonRetryable 'no_recipient'.
 * One email, three sentences, log type 'other' (sendBillingContactReassignedEmail).
 * No Stripe call is made.
 */

import { sendBillingContactReassignedEmail } from '@/lib/email';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_BILLING_CONTACT_REASSIGNED_KIND = 'notify_billing_contact_reassigned';
export const PEOPLE_PATH = '/dashboard/settings';

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', 'billing_contact_reassigned')
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

export const handleNotifyBillingContactReassignedRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const memberId = typeof row.payload?.member_id === 'string' ? row.payload.member_id : null;
  if (!org || !memberId) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: contact, error: cErr } = await service
    .from('org_contacts')
    .select('member_id')
    .eq('organization_id', org)
    .eq('role', 'billing')
    .is('removed_at', null)
    .maybeSingle();
  if (cErr) throw new Error(`org_contacts read failed: ${cErr.code ?? 'unknown'}`);
  if ((contact as { member_id?: string } | null)?.member_id !== memberId) {
    console.info(`[billing/contact-reassigned] ${row.id}: the billing contact changed since; nothing to send`);
    return;
  }
  if (await alreadySent(service, row.dedupe_key)) return;

  const { data: member, error: mErr } = await service
    .from('organization_members')
    .select('user_id')
    .eq('id', memberId)
    .eq('organization_id', org)
    .maybeSingle();
  if (mErr) throw new Error(`organization_members read failed: ${mErr.code ?? 'unknown'}`);
  const userId = (member as { user_id?: string | null } | null)?.user_id ?? null;
  if (!userId) throw new NonRetryableOutboxError('no_recipient');
  const { data: u, error: uErr } = await service.auth.admin.getUserById(userId);
  if (uErr) throw new Error('member email lookup failed');
  const email = u?.user?.email?.trim();
  if (!email) throw new NonRetryableOutboxError('no_recipient');

  const { data: o, error: oErr } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const brokerageName = ((o as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';

  const result = await sendBillingContactReassignedEmail({
    recipientEmail: email,
    brokerageName,
    url: `${baseUrl()}${PEOPLE_PATH}`,
    outboxKey: row.dedupe_key,
    organizationId: org,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
