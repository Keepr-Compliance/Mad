/**
 * Who may buy the Agent plan, for an already-verified user — BACKLOG-3676.
 *
 * The core of agentContext() (lib/billing/personalActionContext.ts), without the
 * cookie session: the website action feeds it the access its cookie session
 * classified, the desktop route (app/api/payments/subscription-session) the
 * access classified from the Bearer user's own membership rows. Both then read
 * the same plan view and the same billingCapabilities() rule.
 *
 * Returns a refusal CODE, never a sentence: the website maps every code to its
 * own message, the desktop app to its own screen.
 */

import type { PortalAccess } from '@keepr/shared';
import type { createServiceClient } from '@/lib/supabase/service';
import { billingCapabilities, type BillingCapabilities } from './capabilities';
import type { StripeMode } from './mode';
import { getAgentPlanView, type AgentPlanView } from './agentPlan';

export type AgentAccessRefusal =
  /** No Agent plan for this account (no membership, deactivated, not a personal owner). */
  | 'not_available'
  /** A brokerage covers this account (a full-portal role, or a licensed brokerage member). */
  | 'brokerage_managed'
  /** A brokerage member with no license assigned (BACKLOG-3851 'unassigned'). */
  | 'no_license'
  /** The membership read failed: unknown, never guessed. */
  | 'try_again';

export interface AgentContext {
  userId: string;
  email: string | null;
  service: ReturnType<typeof createServiceClient>;
  mode: StripeMode;
  view: AgentPlanView;
  caps: BillingCapabilities;
}

/** Only a personal owner has an Agent plan. Decided on the access alone, before any billing read. */
export function agentAccessRefusal(access: PortalAccess): AgentAccessRefusal | null {
  if (access.kind === 'floor' && access.via === 'personal_owner') return null;
  if (access.kind === 'unknown') return 'try_again';
  if (access.kind === 'full') return 'brokerage_managed';
  if (access.kind === 'floor' && access.via === 'brokerage') return 'brokerage_managed';
  if (access.kind === 'floor' && access.via === 'unlicensed') return 'no_license';
  return 'not_available';
}

export async function agentContextForUser(a: {
  userId: string;
  email: string | null;
  access: PortalAccess;
  service: ReturnType<typeof createServiceClient>;
  mode: StripeMode;
}): Promise<AgentContext | { refusal: AgentAccessRefusal }> {
  const refusal = agentAccessRefusal(a.access);
  if (refusal) return { refusal };
  const view = await getAgentPlanView(a.service, a.userId, a.mode);
  const caps = billingCapabilities({
    access: a.access,
    isImpersonating: false,
    enabled: true,
    agentPlan: view.state,
    renewalUnpaid: view.row?.status === 'unpaid',
    // BACKLOG-3878: the licence (view.suspended). A suspended account cannot
    // cancel, keep or end its plan, or buy one; it may still replace its card.
    accountSuspended: view.suspended,
    orgBillingSetUp: false,
  });
  if (!caps || caps.kind !== 'personal') return { refusal: 'not_available' };
  return { userId: a.userId, email: a.email, service: a.service, mode: a.mode, view, caps };
}
