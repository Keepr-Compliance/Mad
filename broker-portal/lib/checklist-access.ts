/**
 * Checklist template editor access gate — BACKLOG-3474.
 *
 * One place decides whether the Checklists surfaces exist for the caller: the
 * sidebar entry (via app/dashboard/layout.tsx), the /dashboard/checklists route
 * and every checklist server action route through here, so the link, the page
 * and the writes cannot disagree.
 *
 * Refusal order: impersonation, identity, brokerage membership, role, feature.
 *
 * - Impersonation is checked explicitly. A staff member can hold their own
 *   portal session in the same browser as a support session, so "no auth user
 *   while impersonating" is not something to rely on.
 * - The membership read uses PORTAL_MEMBERSHIP_SELECT + pickBrokerageMembership
 *   (lib/auth/membership.ts), never `.single()`: a user's personal organization
 *   row is not a brokerage placement, and two rows must not read as none.
 * - CHECKLIST_EDITOR_ROLES mirrors the role list inside the database's
 *   can_edit_checklist_templates(), which RLS enforces independently.
 * - The feature check is FAIL-CLOSED (isFeatureEnabledFailClosed): an RPC
 *   error, an error payload or a missing key all refuse.
 */

import { createClient } from '@/lib/supabase/server';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';
import { getImpersonationSession } from '@/lib/impersonation';
import { PORTAL_MEMBERSHIP_SELECT, pickBrokerageMembership } from '@/lib/auth/membership';

/** feature_definitions.key seeded by 20260921101757_backlog_3473_transaction_checklists.sql */
export const CHECKLIST_FEATURE_KEY = 'transaction_checklists';

/** Roles that may edit checklist templates. Same list as can_edit_checklist_templates(). */
export const CHECKLIST_EDITOR_ROLES = ['broker', 'admin', 'it_admin'] as const;

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface ChecklistEditorAccess {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  role: string;
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

  const membership = pickBrokerageMembership(memberships);
  if (
    !membership ||
    !(CHECKLIST_EDITOR_ROLES as readonly string[]).includes(membership.role)
  ) {
    throw new Error('Not authorized');
  }

  // Boolean only, no featureRenderPolicy: the entry and the route are hidden
  // (404) when the feature is off, with no grayed state. Whether an OFF org
  // should see a grayed entry once feature_definitions.is_built flips true is
  // an open product question recorded on BACKLOG-3477.
  const enabled = await isFeatureEnabledFailClosed(
    membership.organization_id,
    CHECKLIST_FEATURE_KEY
  );
  if (!enabled) throw new Error('Not authorized');

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
