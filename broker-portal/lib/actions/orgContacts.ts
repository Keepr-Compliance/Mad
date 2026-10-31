'use server';

/**
 * Brokerage people (the People card on /dashboard/settings) — BACKLOG-4007 PR-4, People v2.
 *
 * Every rule lives in the database: org_contacts_list / org_contact_save / org_contact_remove /
 * org_people_invite check the caller and refuse everyone else with 42501. People: an active
 * admin, IT admin or broker of THIS brokerage (staff in the admin portal). The billing contact:
 * admin or broker. The IT contact and MSP: admin or IT admin (founder R7). The same lists are in
 * lib/people-roles.ts and are checked here first. These actions only forward the documented
 * keys with the signed-in user's own client, and send the invitation email for a new person
 * (a row insert sends nothing).
 */

import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import type { OrgPeopleInviteSlot, OrgPeopleResult, OrgPeopleSaveInput, OrgPeopleView } from '@keepr/ui';
import { billingLoginInviteLink, sendBillingLoginInvite } from '@/lib/billing/billingLoginInvite';
import { sendInviteEmail } from '@/lib/email';
import { PEOPLE_BILLING_ROLES, PEOPLE_IT_ROLES, PEOPLE_ROLES } from '@/lib/people-roles';

type Rpc = { success?: boolean; error?: string; role?: string } | null;
type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The same rule as the database, checked first so a refused person causes no RPC at all.
 * The RPC checks again (42501); this is not the only gate.
 */
async function gate(
  organizationId: string,
  roles: readonly string[] = PEOPLE_ROLES
): Promise<{ supabase: ServerClient; email: string | null; name: string | null } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const ok = await requireActiveOrgRole(supabase, user.id, organizationId, roles);
  if (!ok.ok) return null;
  const meta = (user.user_metadata ?? {}) as { first_name?: string; last_name?: string; full_name?: string };
  const name = [meta.first_name, meta.last_name].filter(Boolean).join(' ') || meta.full_name || null;
  return { supabase, email: user.email ?? null, name };
}

function rolesFor(role: OrgPeopleSaveInput['role'] | OrgPeopleInviteSlot): readonly string[] {
  if (role === 'billing') return PEOPLE_BILLING_ROLES;
  if (role === 'it' || role === 'msp') return PEOPLE_IT_ROLES;
  return PEOPLE_ROLES;
}

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

export type OrgContactsListResult = { ok: true; view: OrgPeopleView } | { ok: false; error: string };

export async function listOrgContacts(organizationId: string): Promise<OrgContactsListResult> {
  const g = await gate(organizationId);
  if (!g) return { ok: false, error: 'not_authorized' };
  const { data, error } = await g.supabase.rpc('org_contacts_list', { p_org: organizationId });
  if (error) return rpcError(error) as OrgContactsListResult;
  if (!(data as { success?: boolean } | null)?.success) return { ok: false, error: 'failed' };
  const v = data as OrgPeopleView;
  return {
    ok: true,
    view: {
      can_edit: v.can_edit,
      can_edit_billing: v.can_edit_billing === true,
      can_edit_it: v.can_edit_it === true,
      can_edit_phone: v.can_edit_phone === true,
      deal_status: v.deal_status,
      contacts: v.contacts ?? [],
      members: v.members ?? [],
    },
  };
}

export async function saveOrgContact(organizationId: string, input: OrgPeopleSaveInput): Promise<OrgPeopleResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const g = await gate(organizationId, rolesFor(input.role));
  if (!g) return { ok: false, error: 'not_authorized' };
  const { data, error } = await g.supabase.rpc('org_contact_save', { p_org: organizationId, p_contact: savePayload(input) });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed', ...(r?.role ? { role: r.role } : {}) };
  return { ok: true };
}

export async function removeOrgContact(organizationId: string, contactId: string): Promise<OrgPeopleResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const g = await gate(organizationId);
  if (!g) return { ok: false, error: 'not_authorized' };
  const { data, error } = await g.supabase.rpc('org_contact_remove', { p_org: organizationId, p_contact_id: contactId });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  return { ok: true };
}

export interface InvitePersonInput {
  slot: OrgPeopleInviteSlot;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  companyName?: string;
}

export type InvitePersonResult =
  | { ok: true; emailSent: boolean; inviteLink: string | null }
  | { ok: false; error: string };

interface InviteCreated {
  success: true;
  slot: OrgPeopleInviteSlot;
  token: string;
  email: string;
  name?: string | null;
  org_name?: string | null;
}

/**
 * "Invite new person" from People (InviteUserModal in People mode). org_people_invite creates
 * the invitation (billing-only login, or an IT admin that holds a seat) and links it; this
 * sends the email.
 */
export async function invitePerson(organizationId: string, input: InvitePersonInput): Promise<InvitePersonResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const g = await gate(organizationId, rolesFor(input.slot));
  if (!g) return { ok: false, error: 'not_authorized' };
  const t = (v: string | undefined) => (v ?? '').trim();
  const person: Record<string, string> = {
    slot: input.slot,
    email: t(input.email),
    first_name: t(input.firstName),
    last_name: t(input.lastName),
  };
  if (t(input.phone)) person.phone = t(input.phone);
  if (input.slot === 'msp') person.company_name = t(input.companyName);
  const { data, error } = await g.supabase.rpc('org_people_invite', { p_org: organizationId, p_person: person });
  if (error) return { ok: false, error: error.code === '42501' ? 'not_authorized' : 'failed' };
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  const created = data as InviteCreated;
  const inviterName = g.name || g.email || 'Your administrator';
  const link = billingLoginInviteLink(created.token);
  let sent = false;
  if (created.slot === 'billing') {
    sent = await sendBillingLoginInvite(created, inviterName);
  } else {
    try {
      const res = await sendInviteEmail({
        recipientEmail: created.email,
        organizationName: created.org_name || 'your brokerage',
        inviterName,
        role: 'IT admin',
        inviteLink: link,
        expiresInDays: 7,
        recipientFirstName: t(input.firstName) || undefined,
      });
      sent = res.success || res.outcome === 'queued';
    } catch (e) {
      Sentry.captureException(e, { tags: { action: 'people_invite' } });
    }
  }
  return { ok: true, emailSent: sent, inviteLink: link };
}
