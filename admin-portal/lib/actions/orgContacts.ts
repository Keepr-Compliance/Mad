'use server';

/**
 * Brokerage people on the organization page — BACKLOG-4007 PR-4.
 *
 * Staff add and change a brokerage's billing contact, IT contact, office contacts and IT
 * provider (MSP), and turn the one billing-only login on or off. Every rule is in the database:
 * org_contacts_list needs billing.view, the writes need billing.manage (has_permission on
 * auth.uid()), admin_search_users_for_contact needs billing.manage. These actions forward the
 * documented keys with the staffer's own client and send the billing-only login's invitation
 * email through the broker portal (the same proxy the Invite button uses).
 */

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import type { OrgPeopleResult, OrgPeopleSaveInput, OrgPeopleUserHit, OrgPeopleView } from '@keepr/ui';

type Rpc = { success?: boolean; error?: string } | null;

function rpcError(error: { code?: string } | null): OrgPeopleResult {
  return { ok: false, error: error?.code === '42501' ? 'not_authorized' : 'failed' };
}

function savePayload(input: OrgPeopleSaveInput): Record<string, string> {
  const t = (v: string | undefined) => (v ?? '').trim();
  const out: Record<string, string> = { role: input.role, phone: t(input.phone), company_name: t(input.company_name) };
  if (input.id) out.id = input.id;
  if (input.user_id) out.user_id = input.user_id;
  else {
    out.name = t(input.name);
    out.email = t(input.email);
  }
  return out;
}

export async function listOrgContactsAction(organizationId: string): Promise<OrgPeopleView | null> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc('org_contacts_list', { p_org: organizationId });
  if (error || !(data as { success?: boolean } | null)?.success) return null;
  const v = data as OrgPeopleView;
  return {
    can_edit: v.can_edit,
    can_edit_billing: v.can_edit_billing === true,
    deal_status: v.deal_status,
    contacts: v.contacts ?? [],
    members: v.members ?? [],
  };
}

export async function searchUsersForContactAction(organizationId: string, query: string): Promise<OrgPeopleUserHit[]> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return [];
  const { data, error } = await supabase.rpc('admin_search_users_for_contact', { p_org: organizationId, p_query: query });
  if (error) return [];
  return ((data as { users?: OrgPeopleUserHit[] } | null)?.users ?? []).slice(0, 10);
}

export async function saveOrgContactAction(organizationId: string, input: OrgPeopleSaveInput): Promise<OrgPeopleResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };
  const { data, error } = await supabase.rpc('org_contact_save', { p_org: organizationId, p_contact: savePayload(input) });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  revalidatePath(`/dashboard/organizations/${organizationId}`);
  return { ok: true };
}

export async function removeOrgContactAction(organizationId: string, contactId: string): Promise<OrgPeopleResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };
  const { data, error } = await supabase.rpc('org_contact_remove', { p_org: organizationId, p_contact_id: contactId });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  revalidatePath(`/dashboard/organizations/${organizationId}`);
  return { ok: true };
}

interface LoginCreated {
  success: true;
  token: string;
  email: string;
  name?: string | null;
  org_name?: string | null;
}

/** Sends the billing-only login's invitation through the broker portal. Never throws. */
async function sendBillingLoginEmail(created: LoginCreated, inviterName: string): Promise<boolean> {
  const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
  const apiSecret = process.env.INTERNAL_API_SECRET;
  if (!brokerPortalUrl || !apiSecret) return false;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  try {
    const response = await fetch(`${brokerPortalUrl}/api/email/send-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': apiSecret },
      body: JSON.stringify({
        recipientEmail: created.email,
        organizationName: created.org_name || 'Keepr',
        inviterName,
        role: 'Billing only',
        inviteLink: `${baseUrl}/invite/${created.token}`,
        expiresInDays: 7,
        billingOnly: true,
      }),
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch (e) {
    Sentry.captureException(e, { tags: { action: 'billing_login_invite' } });
    return false;
  }
}

export async function setOrgBillingLoginAction(organizationId: string, enable: boolean): Promise<OrgPeopleResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };
  const { data, error } = await supabase.rpc('org_billing_login_set', { p_org: organizationId, p_enable: enable });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  revalidatePath(`/dashboard/organizations/${organizationId}`);
  if (!enable) return { ok: true, note: 'The billing-only login was removed.' };
  const created = data as Partial<LoginCreated>;
  if (typeof created.token !== 'string' || typeof created.email !== 'string') return { ok: true };
  const inviterName =
    [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(' ') || user.email || 'Keepr Support';
  const sent = await sendBillingLoginEmail(created as LoginCreated, inviterName);
  return {
    ok: true,
    note: sent
      ? 'We emailed the billing contact an invitation to their billing-only login.'
      : 'The billing-only login was created, but its invitation email did not send. Resend it from Pending Invitations.',
  };
}
