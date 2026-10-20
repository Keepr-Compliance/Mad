/**
 * billing_outbox kind `notify_setup_reminder` — BACKLOG-4007 PR-3.
 *
 * Enqueued by the database (_billing_enqueue_setup_reminders, migration 20261020100000 §12): an
 * unclaimed broker/admin invite into a brokerage whose deal is 'draft' ("Waiting for customer
 * setup") gets two rows, run_after +3 d and +7 d from that send; a resend marks the earlier pair
 * processed (superseded_by_resend), so only rows for the live invite ever run.
 *
 * Contract (outboxKinds.ts), resolved at RUN time (SR 2c75ace8 change 9):
 *  (a) Converge. The deal is no longer 'draft' (the broker finished, or staff changed it) ->
 *      nothing. A send already in email_delivery_log for this key -> no second send.
 *  Recipient:
 *   1. a broker/admin of the brokerage with an account and an active license -> "finish setup"
 *      (the setup guide). One finish email per brokerage per day number, whatever the number of
 *      invites (the key is per organization, not per row).
 *   2. else this row's invite, still unclaimed and not expired -> "accept your invitation" with
 *      its link.
 *   3. else nobody -> no broker email; the account manager gets 'setup_no_recipient'.
 *  Day 7 with a recipient also alerts the account manager ('setup_not_completed'). Account-manager
 *  rows are separate notify_account_manager outbox rows keyed on this row (at most one each).
 *  No Stripe call is made.
 */

import { sendSetupReminderEmail } from '@/lib/email';
import { enqueueOutbox } from './outboxEnqueue';
import { NOTIFY_ACCOUNT_MANAGER_KIND } from './brokerageNotify';
import { NonRetryableOutboxError, type OutboxHandler, type OutboxRow } from './outboxKinds';
import type { createServiceClient } from '@/lib/supabase/service';
import { SETUP_GUIDE_PATH } from './setupState';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const NOTIFY_SETUP_REMINDER_KIND = 'notify_setup_reminder';

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

interface InviteRow {
  id: string;
  user_id: string | null;
  invited_email: string | null;
  invitation_token: string | null;
  invitation_expires_at: string | null;
}

export type SetupRecipient =
  | { variant: 'finish'; email: string }
  | { variant: 'accept'; email: string; token: string }
  | null;

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', 'setup_reminder')
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

/** Who this reminder goes to, decided now. See the header. */
export async function resolveSetupRecipient(
  service: ServiceClient,
  org: string,
  memberId: string,
  nowMs: number
): Promise<SetupRecipient> {
  const { data: claimed, error: cErr } = await service
    .from('organization_members')
    .select('user_id, created_at')
    .eq('organization_id', org)
    .in('role', ['broker', 'admin'])
    .eq('license_status', 'active')
    .not('user_id', 'is', null)
    .order('created_at', { ascending: true });
  if (cErr) throw new Error(`organization_members read failed: ${cErr.code ?? 'unknown'}`);
  for (const m of (claimed as Array<{ user_id: string }> | null) ?? []) {
    const { data: u, error: uErr } = await service.auth.admin.getUserById(m.user_id);
    if (uErr) throw new Error('member email lookup failed');
    const email = u?.user?.email?.trim();
    if (email) return { variant: 'finish', email };
  }

  const { data: inv, error: iErr } = await service
    .from('organization_members')
    .select('id, user_id, invited_email, invitation_token, invitation_expires_at')
    .eq('id', memberId)
    .eq('organization_id', org)
    .maybeSingle();
  if (iErr) throw new Error(`organization_members read failed: ${iErr.code ?? 'unknown'}`);
  const invite = inv as InviteRow | null;
  const expires = invite?.invitation_expires_at ? Date.parse(invite.invitation_expires_at) : NaN;
  if (
    invite &&
    !invite.user_id &&
    invite.invitation_token &&
    invite.invited_email?.trim() &&
    Number.isFinite(expires) &&
    expires > nowMs
  ) {
    return { variant: 'accept', email: invite.invited_email.trim(), token: invite.invitation_token };
  }
  return null;
}

async function orgName(service: ServiceClient, org: string): Promise<string> {
  const { data, error } = await service.from('organizations').select('name').eq('id', org).maybeSingle();
  if (error) throw new Error(`organizations read failed: ${error.code ?? 'unknown'}`);
  return ((data as { name?: string | null } | null)?.name ?? '').trim() || 'your brokerage';
}

export const handleNotifySetupReminderRow: OutboxHandler = async (row: OutboxRow, ctx) => {
  const org = row.organization_id ?? (typeof row.payload?.organization_id === 'string' ? row.payload.organization_id : null);
  const memberId = typeof row.payload?.member_id === 'string' ? row.payload.member_id : null;
  const day = typeof row.payload?.day === 'number' ? row.payload.day : null;
  if (!org || !memberId || day === null) throw new NonRetryableOutboxError('bad_payload');
  const { service } = ctx;

  const { data: dealData, error: dealErr } = await service
    .from('org_deals')
    .select('status')
    .eq('organization_id', org)
    .maybeSingle();
  if (dealErr) throw new Error(`org_deals read failed: ${dealErr.code ?? 'unknown'}`);
  const status = (dealData as { status?: string } | null)?.status ?? null;
  if (status !== 'draft') {
    console.info(`[billing/setup-reminder] ${row.id}: deal is ${status ?? 'missing'}; nothing to send`);
    return;
  }

  const recipient = await resolveSetupRecipient(service, org, memberId, Date.now());

  if (!recipient || day >= 7) {
    const reason = recipient ? 'setup_not_completed' : 'setup_no_recipient';
    const res = await enqueueOutbox(service, {
      mode: ctx.mode,
      kind: NOTIFY_ACCOUNT_MANAGER_KIND,
      organizationId: org,
      dedupeKey: `${row.dedupe_key}:am`,
      payload: { organization_id: org, reason, stripe_object_id: null },
      runAfter: new Date(),
    });
    console.info(`[billing/setup-reminder] ${row.id}: account-manager ${reason} ${res}`);
  }
  if (!recipient) return;

  const outboxKey =
    recipient.variant === 'finish' ? `${NOTIFY_SETUP_REMINDER_KIND}:${ctx.mode}:${org}:finish:d${day}` : row.dedupe_key;
  if (await alreadySent(service, outboxKey)) return;

  const url =
    recipient.variant === 'finish'
      ? `${baseUrl()}${SETUP_GUIDE_PATH}`
      : `${baseUrl()}/invite/${encodeURIComponent(recipient.token)}`;
  const result = await sendSetupReminderEmail({
    recipientEmail: recipient.email,
    brokerageName: await orgName(service, org),
    variant: recipient.variant,
    url,
    outboxKey,
    organizationId: org,
    day,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
