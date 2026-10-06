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
 *   brokerage row is routed on their personal organization. There is no
 *   fall-through to the personal organization.
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
 */

import { createClient } from '@/lib/supabase/server';
import { getImpersonationSession } from '@/lib/impersonation';
import {
  PORTAL_MEMBERSHIP_SELECT,
  isPersonalMembership,
  pickBrokerageMembership,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

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
 * whatever its role; only a user with no brokerage row is routed on their
 * personal organization.
 */
export function pickChecklistMembership(
  rows: PortalMembershipRow[] | null | undefined
): PortalMembershipRow | null {
  const brokerage = pickBrokerageMembership(rows);
  if (brokerage) return brokerage;
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

  const { data: memberships } = await supabase
    .from('organization_members')
    .select(PORTAL_MEMBERSHIP_SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  const membership = pickChecklistMembership(memberships);
  if (!membership) throw new Error('Not authorized');

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
