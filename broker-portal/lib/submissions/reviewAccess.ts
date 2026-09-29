/**
 * Who may do what on a submission's review page — BACKLOG-3477.
 *
 * THE ONE PLACE the portal decides review roles (BACKLOG-3080 audit):
 *
 *   tick / add checklist   whatever public.can_review_submission(org) says.
 *                          That SQL helper holds the role list (broker, admin,
 *                          it_admin) and the reviewer RPCs call it too; the
 *                          portal carries no copy of the list.
 *   approve / request      every reviewer EXCEPT it_admin. The founder ruled an
 *   changes / reject       IT admin may tick, not approve (pm_comments
 *                          dcc91c87, ruling 3). UPDATE on transaction_submissions
 *                          is not widened to it_admin either, so showing them the
 *                          buttons would only produce a write that changes
 *                          nothing.
 *
 * Every new server action and the page read their answer from here.
 */

import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/** The one role that may tick but not decide. */
export const TICK_ONLY_ROLE = 'it_admin';

/** Whether a member with this role may approve, request changes or reject. */
export function canDecideForRole(role: string | null | undefined): boolean {
  return role !== TICK_ONLY_ROLE;
}

export interface ReviewCapabilities {
  /** organization_members.role in the submission's organization, or null. */
  role: string | null;
  /** May tick items and add a checklist (database decides). */
  canTick: boolean;
  /** May approve / request changes / reject. */
  canDecide: boolean;
}

export const NO_CAPABILITIES: ReviewCapabilities = { role: null, canTick: false, canDecide: false };

/**
 * Ask the database whether the signed-in user reviews this organization's
 * submissions. Fail-closed: an error or anything but a literal `true` refuses.
 */
async function isReviewer(supabase: ServerClient, organizationId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_review_submission', { p_org_id: organizationId });
  if (error) {
    console.error('[submissions] can_review_submission failed:', error.message);
    return false;
  }
  return data === true;
}

/**
 * Capabilities of the signed-in user on a submission of `organizationId`.
 * Callers skip this during impersonation (support sessions are read-only).
 */
export async function getReviewCapabilities(organizationId: string): Promise<ReviewCapabilities> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NO_CAPABILITIES;

  const [{ data: membership }, canTick] = await Promise.all([
    supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', user.id)
      .maybeSingle(),
    isReviewer(supabase, organizationId),
  ]);

  const role = (membership as { role?: string } | null)?.role ?? null;
  return { role, canTick, canDecide: canDecideForRole(role) };
}

export interface SubmissionReviewer {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  status: string;
}

/**
 * Gate for every reviewer server action. Returns null on refusal; the caller
 * returns a not_authorized result. The reviewer RPCs re-check everything
 * themselves (SECURITY DEFINER, can_review_submission, feature, status).
 */
export async function requireSubmissionReviewer(submissionId: string): Promise<SubmissionReviewer | null> {
  if (typeof submissionId !== 'string' || submissionId === '') return null;
  if (await blockWriteDuringImpersonation()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: submission } = await supabase
    .from('transaction_submissions')
    .select('id, organization_id, status')
    .eq('id', submissionId)
    .maybeSingle();
  const row = submission as { organization_id?: string; status?: string } | null;
  if (!row?.organization_id) return null;

  if (!(await isReviewer(supabase, row.organization_id))) return null;

  return {
    supabase,
    userId: user.id,
    organizationId: row.organization_id,
    status: row.status ?? '',
  };
}
