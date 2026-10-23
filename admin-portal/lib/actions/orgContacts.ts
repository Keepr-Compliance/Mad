'use server';

/**
 * Brokerage people on the organization page — BACKLOG-4007 PR-4, People v2.
 *
 * Staff add and change a brokerage's billing contact, IT contact, office contacts and IT
 * provider (MSP), and invite a new person for a slot. Every rule is in the database:
 * org_contacts_list needs billing.view, the writes need billing.manage (has_permission on
 * auth.uid()). Every contact is a member of the brokerage, so staff pick from its member list
 * (no Keepr-wide search, PM c7c276be item 6). These actions forward the documented keys with
 * the staffer's own client and send the invitation email through the broker portal (the same
 * proxy the Invite button uses).
 */

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import type { OrgPeopleInviteSlot, OrgPeopleResult, OrgPeopleSaveInput, OrgPeopleView } from '@keepr/ui';

type Rpc = { success?: boolean; error?: string; role?: string } | null;

function rpcError(error: { code?: string } | null): OrgPeopleResult {
  return { ok: false, error: error?.code === '42501' ? 'not_authorized' : 'failed' };
}

/** Only the documented keys travel. */
function savePayload(input: OrgPeopleSaveInput): Record<string, string | boolean> {
  const t = (v: string | undefined) => (v ?? '').trim();
  const out: Record<string, string | boolean> = { role: input.role, member_id: input.member_id };
  if (input.id) out.id = input.id;
  if (t(input.phone)) out.phone = t(input.phone);
  if (input.role === 'msp') out.company_name = t(input.company_name);
  if (input.confirm_role_change === true) out.confirm_role_change = true;
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
    can_edit_it: v.can_edit_it === true,
    can_edit_phone: v.can_edit_phone === true,
    deal_status: v.deal_status,
    contacts: v.contacts ?? [],
    members: v.members ?? [],
  };
}

export async function saveOrgContactAction(organizationId: string, input: OrgPeopleSaveInput): Promise<OrgPeopleResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };
  const { data, error } = await supabase.rpc('org_contact_save', { p_org: organizationId, p_contact: savePayload(input) });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed', ...(r?.role ? { role: r.role } : {}) };
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

export interface InvitePersonActionInput {
  slot: OrgPeopleInviteSlot;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  companyName?: string;
}

export type InvitePersonActionResult =
  | { ok: true; emailSent: boolean; inviteLink: string | null }
  | { ok: false; error: string };

interface InviteCreated {
  success: true;
  slot: OrgPeopleInviteSlot;
  token: string;
  email: string;
  org_name?: string | null;
}

function inviteLinkFor(token: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  return `${baseUrl}/invite/${token}`;
}

/** Sends the invitation through the broker portal. Never throws. */
async function sendPeopleInviteEmail(created: InviteCreated, inviterName: string): Promise<boolean> {
  const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
  const apiSecret = process.env.INTERNAL_API_SECRET;
  if (!brokerPortalUrl || !apiSecret) return false;
  const billingOnly = created.slot === 'billing';
  try {
    const response = await fetch(`${brokerPortalUrl}/api/email/send-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': apiSecret },
      body: JSON.stringify({
        recipientEmail: created.email,
        organizationName: created.org_name || 'Keepr',
        inviterName,
        role: billingOnly ? 'Billing only' : 'IT admin',
        inviteLink: inviteLinkFor(created.token),
        expiresInDays: 7,
        ...(billingOnly ? { billingOnly: true } : {}),
      }),
    });
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch (e) {
    Sentry.captureException(e, { tags: { action: 'people_invite' } });
    return false;
  }
}

/** "Invite new person" from People (InviteUserDialog in People mode). */
export async function invitePersonAction(organizationId: string, input: InvitePersonActionInput): Promise<InvitePersonActionResult> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: 'not_authorized' };
  const t = (v: string | undefined) => (v ?? '').trim();
  const person: Record<string, string> = {
    slot: input.slot,
    email: t(input.email),
    first_name: t(input.firstName),
    last_name: t(input.lastName),
  };
  if (t(input.phone)) person.phone = t(input.phone);
  if (input.slot === 'msp') person.company_name = t(input.companyName);
  const { data, error } = await supabase.rpc('org_people_invite', { p_org: organizationId, p_person: person });
  if (error) return { ok: false, error: error.code === '42501' ? 'not_authorized' : 'failed' };
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  revalidatePath(`/dashboard/organizations/${organizationId}`);
  const created = data as InviteCreated;
  const inviterName =
    [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(' ') || user.email || 'Keepr Support';
  const sent = await sendPeopleInviteEmail(created, inviterName);
  return { ok: true, emailSent: sent, inviteLink: inviteLinkFor(created.token) };
}
