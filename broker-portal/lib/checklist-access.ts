/**
 * Checklist template editor access gate — BACKLOG-3474, BACKLOG-3535.
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
 *   fall-through: a brokerage agent the database refuses is refused, even if
 *   they also own a personal organization.
 * - Whether: one call to can_edit_checklist_templates(p_org_id), the same
 *   function RLS and save_checklist_template use. The role list, the
 *   personal-owner rule and the feature check live there only; the portal
 *   carries no copy of them. FAIL-CLOSED: an RPC error or anything other than a
 *   literal `true` refuses.
 */

import { createClient } from '@/lib/supabase/server';
import { getImpersonationSession } from '@/lib/impersonation';
import {
  PORTAL_MEMBERSHIP_SELECT,
  isPersonalMembership,
  pickBrokerageMembership,
  type PortalMembershipRow,
} from '@/lib/auth/membership';
import {
  featureRenderPolicy,
  fetchFeatureBuildStates,
  isFeatureBuilt,
  type FeatureRenderPolicy,
} from '@/lib/feature-availability';

/** feature_definitions.key seeded by 20260921101757_backlog_3473_transaction_checklists.sql */
export const CHECKLIST_FEATURE_KEY = 'transaction_checklists';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface ChecklistEditorAccess {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  role: string;
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
 * Authorize the caller for checklist template work. Throws on refusal so a
 * server action cannot continue past it.
 */
export async function requireChecklistEditorAccess(): Promise<ChecklistEditorAccess> {
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
  // refuses. The sidebar's grayed entry (getChecklistNavPolicy below) is
  // presentation only and never makes the route reachable.
  const { data: allowed, error } = await supabase.rpc('can_edit_checklist_templates', {
    p_org_id: membership.organization_id,
  });
  if (error || allowed !== true) throw new Error('Not authorized');

  return {
    supabase,
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
  };
}

/**
 * Non-throwing form for rendering decisions (sidebar entry, route gate).
 * Shares requireChecklistEditorAccess so the two cannot drift. Any throw is a
 * refusal.
 */
export async function isChecklistEditorEnabled(): Promise<boolean> {
  try {
    await requireChecklistEditorAccess();
    return true;
  } catch {
    return false;
  }
}

/**
 * The sidebar entry's render policy — BACKLOG-3477 (ruling 9af9ffbd on
 * b152ee0a): a full-portal member of an organization whose plan does not
 * include checklists sees the entry GRAYED with one neutral line, not hidden.
 *
 * - enabled  the same gate as the route (isChecklistEditorEnabled).
 * - grayed   refused by that gate, the caller is a full-portal user (broker,
 *            admin, it_admin of a brokerage; the layout passes that in from
 *            classifyPortalAccess), and feature_definitions.is_built is true
 *            for the feature. featureRenderPolicy is the portal's one rule
 *            for this (BACKLOG-3098).
 * - hidden   everything else: impersonation, floor users (agents), personal
 *            organizations, an unbuilt feature, an unreadable build state.
 *
 * Grayed is presentation only. The route, the actions and RLS still refuse.
 */
export async function getChecklistNavPolicy(options: {
  isImpersonating: boolean;
  isFullPortalUser: boolean;
}): Promise<FeatureRenderPolicy> {
  if (options.isImpersonating) return 'hidden';
  if (await isChecklistEditorEnabled()) return 'enabled';
  if (!options.isFullPortalUser) return 'hidden';
  const built = await fetchFeatureBuildStates();
  return featureRenderPolicy(false, isFeatureBuilt(built, CHECKLIST_FEATURE_KEY));
}
