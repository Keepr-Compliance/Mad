/**
 * Checklists page access gate — BACKLOG-3474, BACKLOG-3535, BACKLOG-3618.
 *
 * One place decides whether the Checklists surfaces exist for the caller: the
 * sidebar entry (via app/dashboard/layout.tsx), the /dashboard/checklists route
 * and every checklist server action route through here, so the link, the page
 * and the writes cannot disagree.
 *
 * The portal picks WHICH organization; the database decides WHETHER.
 *
 * - Impersonation is checked explicitly. A staff member can hold their own
 *   portal session in the same browser as a support session, so "no auth user
 *   while impersonating" is not something to rely on.
 * - Which organization: a brokerage row wins whatever its role
 *   (pickBrokerageMembership, lib/auth/membership.ts). Only a user with no
 *   brokerage row is routed on their personal organization — and, BACKLOG-3851,
 *   a DEACTIVATED (suspended / expired) member who owns a personal row, whom
 *   classifyPortalAccess routes there (pay-as-you-go, like any solo user). Any
 *   other non-granting status has no fall-through.
 * - Whether, in two questions to the database, in this order:
 *   1. can_edit_checklist_templates(org): may edit the organization's own
 *      templates (broker / admin / it_admin, or a personal organization's
 *      owner; feature on). Yes → `canEditOrg`.
 *   2. Only when 1 says no and the organization is a brokerage:
 *      can_create_own_checklist_templates(org) (BACKLOG-3618): any member,
 *      feature on. Yes → admitted with `canEditOrg: false`: the caller keeps
 *      their own checklists and reads the brokerage's.
 *   The role list, the personal-owner rule and the feature check live in the
 *   database only. FAIL-CLOSED: an RPC error or anything other than a literal
 *   `true` refuses.
 * - BACKLOG-3878: a suspended licence refuses, and so does a failed licence
 *   read (fail closed), before the organization is picked.
 * - BACKLOG-3853 PR-2B: a suspended BROKERAGE refuses too (ruling a43c3e85:
 *   Checklists are hidden while the brokerage is suspended). Checklists have no
 *   database gate for this, so this one is FAIL-CLOSED like the licence read: a
 *   failed org_billing_suspended read refuses. Asked for a brokerage row only.
 */

import { createClient } from '@/lib/supabase/server';
import { getImpersonationSession } from '@/lib/impersonation';
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  isPersonalMembership,
  memberStatusGrantsAccess,
  pickBrokerageMembership,
  type PortalMembershipRow,
} from '@/lib/auth/membership';
import { readOwnLicenceSuspended } from '@/lib/auth/suspension';

/** feature_definitions.key seeded by 20260921101757_backlog_3473_transaction_checklists.sql */
export const CHECKLIST_FEATURE_KEY = 'transaction_checklists';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface ChecklistAccess {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  role: string;
  /** May edit the organization's templates (can_edit_checklist_templates). */
  canEditOrg: boolean;
  /** The organization is the caller's personal organization (solo user: one list). */
  personalOrg: boolean;
}

/**
 * The membership a user edits checklists through. A brokerage row wins
 * whatever its role, except for a deactivated member the classifier routes on
 * their own personal row (BACKLOG-3851); only a user with no brokerage row is
 * otherwise routed on their personal organization.
 */
export function pickChecklistMembership(
  rows: PortalMembershipRow[] | null | undefined,
  userId: string
): PortalMembershipRow | null {
  const brokerage = pickBrokerageMembership(rows);
  if (brokerage) {
    const access = classifyPortalAccess(rows, userId);
    if (access.kind === 'floor' && access.via === 'personal_owner' && Array.isArray(rows)) {
      return rows.find((row) => row && row.organization_id === access.organizationId) ?? brokerage;
    }
    return brokerage;
  }
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row && isPersonalMembership(row)) ?? null;
}

/**
 * Authorize the caller for the Checklists page and its actions. Throws on
 * refusal so a server action cannot continue past it.
 */
export async function requireChecklistAccess(): Promise<ChecklistAccess> {
  if (await getImpersonationSession()) throw new Error('Not authorized');

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const [{ data: memberships }, suspended] = await Promise.all([
    supabase
      .from('organization_members')
      .select(PORTAL_MEMBERSHIP_SELECT)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    readOwnLicenceSuspended(supabase, user.id),
  ]);

  // BACKLOG-3878: a suspended account opens no checklist page and makes no
  // checklist write. FAIL-CLOSED: a failed licence read refuses too.
  if (suspended !== false) throw new Error('Not authorized');

  const membership = pickChecklistMembership(memberships, user.id);
  if (!membership) throw new Error('Not authorized');
  // BACKLOG-3917: a row whose status does not grant access opens nothing,
  // and there is no fall-through to the personal organization.
  if (!memberStatusGrantsAccess(membership.license_status)) throw new Error('Not authorized');

  // BACKLOG-3853 PR-2B: a suspended brokerage opens no checklist page and makes
  // no checklist write. FAIL-CLOSED.
  if (!isPersonalMembership(membership)) {
    const { data: orgSuspended, error: orgError } = await supabase.rpc('org_billing_suspended', {
      p_org: membership.organization_id,
    });
    if (orgError || orgSuspended !== false) throw new Error('Not authorized');
  }

  // Boolean only: the route and every action refuse when the database
  // refuses. The sidebar's grayed entry (lib/checklist-nav.ts, BACKLOG-3477)
  // is presentation only and never makes the route reachable.
  const { data: canEdit, error } = await supabase.rpc('can_edit_checklist_templates', {
    p_org_id: membership.organization_id,
  });
  if (error) throw new Error('Not authorized');
  const personalOrg = isPersonalMembership(membership);
  const base = {
    supabase,
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
    personalOrg,
  };
  if (canEdit === true) return { ...base, canEditOrg: true };

  // BACKLOG-3618: asked second, and only for a brokerage member, so an editor
  // never depends on it.
  if (personalOrg) throw new Error('Not authorized');
  const { data: canOwn, error: ownError } = await supabase.rpc('can_create_own_checklist_templates', {
    p_org_id: membership.organization_id,
  });
  if (ownError || canOwn !== true) throw new Error('Not authorized');
  return { ...base, canEditOrg: false };
}

/**
 * Non-throwing form for rendering decisions (sidebar entry, route gate).
 * Shares requireChecklistAccess so the two cannot drift. Any throw is a
 * refusal.
 */
export async function isChecklistPageEnabled(): Promise<boolean> {
  try {
    await requireChecklistAccess();
    return true;
  } catch {
    return false;
  }
}
