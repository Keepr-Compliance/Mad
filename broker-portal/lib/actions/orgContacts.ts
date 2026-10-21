'use server';

/**
 * Brokerage people (the People card on /dashboard/settings) — BACKLOG-4007 PR-4.
 *
 * Every rule lives in the database: org_contacts_list / org_contact_save / org_contact_remove /
 * org_billing_login_set check the caller and refuse everyone else with 42501. People: an active
 * admin, IT admin or broker of THIS brokerage (staff in the admin portal). The billing contact
 * and the billing-only login: admin or broker only (founder e8571c1f). The same two lists are in
 * lib/people-roles.ts and are checked here first. These actions only forward the documented
 * keys with the signed-in user's own client, and send the billing-only login's invitation email
 * (a row insert sends nothing).
 */

import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import type { OrgPeopleResult, OrgPeopleSaveInput, OrgPeopleView } from '@keepr/ui';
import { isBillingLoginCreated, sendBillingLoginInvite } from '@/lib/billing/billingLoginInvite';
import { PEOPLE_BILLING_ROLES, PEOPLE_ROLES } from '@/lib/people-roles';

type Rpc = { success?: boolean; error?: string } | null;
type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The same rule as the database, checked first so a refused person causes no RPC at all.
 * The RPC checks again (42501); this is not the only gate. `roles`: PEOPLE_ROLES, or
 * PEOPLE_BILLING_ROLES for the billing contact and the billing-only login.
 */
async function gate(
  organizationId: string,
  roles: readonly string[] = PEOPLE_ROLES
): Promise<{ supabase: ServerClient; email: string | null } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const ok = await requireActiveOrgRole(supabase, user.id, organizationId, roles);
  return ok.ok ? { supabase, email: user.email ?? null } : null;
}

function rpcError(error: { code?: string } | null): OrgPeopleResult {
  return { ok: false, error: error?.code === '42501' ? 'not_authorized' : 'failed' };
}

/** Only the documented keys travel. */
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
      deal_status: v.deal_status,
      contacts: v.contacts ?? [],
      members: v.members ?? [],
    },
  };
}

export async function saveOrgContact(organizationId: string, input: OrgPeopleSaveInput): Promise<OrgPeopleResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const g = await gate(organizationId, input.role === 'billing' ? PEOPLE_BILLING_ROLES : PEOPLE_ROLES);
  if (!g) return { ok: false, error: 'not_authorized' };
  const { data, error } = await g.supabase.rpc('org_contact_save', { p_org: organizationId, p_contact: savePayload(input) });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
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

export async function setOrgBillingLogin(organizationId: string, enable: boolean): Promise<OrgPeopleResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: 'not_authorized' };
  const g = await gate(organizationId, PEOPLE_BILLING_ROLES);
  if (!g) return { ok: false, error: 'not_authorized' };
  const { data, error } = await g.supabase.rpc('org_billing_login_set', { p_org: organizationId, p_enable: enable });
  if (error) return rpcError(error);
  const r = data as Rpc;
  if (!r?.success) return { ok: false, error: r?.error ?? 'failed' };
  if (!enable) return { ok: true, note: 'The billing-only login was removed.' };
  if (!isBillingLoginCreated(data)) return { ok: true };
  const sent = await sendBillingLoginInvite(data, g.email ?? 'Your administrator');
  return {
    ok: true,
    note: sent
      ? 'We emailed the billing contact an invitation to their billing-only login.'
      : 'The billing-only login was created, but its invitation email did not send. Resend it from the Users page.',
  };
}
