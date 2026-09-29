'use server';

/**
 * Add Split Agreement Change — BACKLOG-3504.
 *
 * "Change the split" is an INSERT of a new effective-dated row, never an
 * UPDATE — `agent_split_agreements` grants no UPDATE and no UPDATE policy
 * exists (BACKLOG-3503). A correction is also a new row, dated however the
 * broker/admin chooses (backdatable).
 *
 * Column list matches the post-trim GRANT exactly (BACKLOG-3503,
 * `chore/BACKLOG-3503-trim-fees` @ 107c29deb):
 *   GRANT INSERT (organization_id, agent_user_id, agent_pct, brokerage_pct,
 *                 effective_from, note) ON agent_split_agreements TO authenticated;
 * `seq`/`set_by`/`set_at` are deliberately absent from that grant — the
 * server defaults them, and a client that could name them could name someone
 * else as the setter. Do not add them to the insert payload below.
 *
 * RLS (`agent_split_agreements_insert_writer`) is the actual authority; the
 * checks below are the same defense-in-depth pattern as updateUserRole.ts —
 * an explicit role/authorization check server-side, not a bet that the UI
 * gate was the only caller.
 */

import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import type { Role } from '@/lib/types/users';

// ============================================================================
// Types
// ============================================================================

interface AddSplitChangeInput {
  /** organization_members.id of the SUBJECT (the agent/broker the split is for). */
  memberId: string;
  /** 0-100; brokerage % is derived server-side as 100 - agentPct, never
   *  trusted from the client, matching the DB's own CHECK
   *  (agent_pct + brokerage_pct = 100). */
  agentPct: number;
  /** "YYYY-MM-DD", client-supplied, backdatable — matches
   *  agent_split_agreements.effective_from (date, no time component). */
  effectiveFrom: string;
  note?: string;
}

interface AddSplitChangeResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Main Action
// ============================================================================

export async function addSplitAgreementChange(
  input: AddSplitChangeInput
): Promise<AddSplitChangeResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // The subject of the split.
  const { data: targetMember } = await supabase
    .from('organization_members')
    .select('id, user_id, role, organization_id')
    .eq('id', input.memberId)
    .single();

  if (!targetMember) {
    return { success: false, error: 'Member not found' };
  }
  if (!targetMember.user_id) {
    return { success: false, error: 'Cannot set a split for a pending invitation' };
  }
  if (!['agent', 'broker'].includes(targetMember.role as Role)) {
    return { success: false, error: 'Splits apply to agent and broker roles only' };
  }

  // The caller's own membership in the SAME organization.
  const { data: currentMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', user.id)
    .eq('organization_id', targetMember.organization_id)
    .single();

  if (!currentMembership) {
    return { success: false, error: 'Not authorized' };
  }

  // Broker and admin may set a split; it_admin may not (founder, 2026-09-22 —
  // deliberately NOT the ADMIN_ROLES ('admin','it_admin') constant used
  // elsewhere on this page for Change Role/Deactivate/Remove).
  const currentUserRole = currentMembership.role as Role;
  if (!['admin', 'broker'].includes(currentUserRole)) {
    return { success: false, error: 'Not authorized to set commission splits' };
  }

  // Validate + derive percentages server-side.
  const agentPct = Number(input.agentPct);
  if (!Number.isFinite(agentPct) || agentPct < 0 || agentPct > 100) {
    return { success: false, error: 'Agent % must be between 0 and 100' };
  }
  const brokeragePct = Math.round((100 - agentPct) * 100) / 100;

  if (!input.effectiveFrom || Number.isNaN(Date.parse(input.effectiveFrom))) {
    return { success: false, error: 'Enter a valid effective date' };
  }

  // Matches the DB's own note CHECK: NULL, or trimmed length 1-2000.
  const trimmedNote = input.note?.trim();
  const note = trimmedNote ? trimmedNote : null;
  if (note && note.length > 2000) {
    return { success: false, error: 'Note must be 2000 characters or fewer' };
  }

  const { error: insertError } = await supabase.from('agent_split_agreements').insert({
    organization_id: targetMember.organization_id,
    agent_user_id: targetMember.user_id,
    agent_pct: agentPct,
    brokerage_pct: brokeragePct,
    effective_from: input.effectiveFrom,
    note,
  });

  if (insertError) {
    console.error('Error recording split agreement change:', insertError);
    return { success: false, error: 'Failed to record the change' };
  }

  return { success: true };
}
