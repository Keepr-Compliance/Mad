/**
 * Who is calling a personal Billing-page action, recomputed on the server —
 * BACKLOG-3847, shared with the BACKLOG-3848 actions.
 *
 * Not a server-action module: imported by lib/actions/agentPlan.ts and
 * lib/actions/billingCard.ts, whose exported functions are the callable actions.
 * The caller runs blockWriteDuringImpersonation() BEFORE this (its result is
 * checked; SR R7 of 3847).
 */

import { headers } from 'next/headers';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { createServiceClient } from '@/lib/supabase/service';
import { billingEnabled } from './flag';
import { billingCapabilities, type BillingCapabilities } from './capabilities';
import { currentStripeMode, type StripeMode } from './mode';
import { getAgentPlanView, type AgentPlanView } from './agentPlan';
import { chooseReturnBase } from './agentCheckoutParams';

export const NOT_AVAILABLE = 'Billing is not available for this account.';
export const NOT_NOW = 'That change is not available for your plan right now. Refresh the page.';
export const MODE_REFUSED = 'Payments are not available for this account.';
export const BILLING_PATH = '/dashboard/billing';

export interface AgentContext {
  userId: string;
  email: string | null;
  service: ReturnType<typeof createServiceClient>;
  mode: StripeMode;
  view: AgentPlanView;
  caps: BillingCapabilities;
}

export async function agentContext(): Promise<AgentContext | { error: string }> {
  if (!billingEnabled()) return { error: NOT_AVAILABLE };
  const portal = await getPortalAccess();
  if (!portal) return { error: 'Please sign in again.' };
  const access = portal.access;
  // Only a personal owner has an Agent plan; refuse before any billing read.
  if (!(access.kind === 'floor' && access.via === 'personal_owner')) return { error: NOT_AVAILABLE };
  const service = createServiceClient();
  const mode = currentStripeMode();
  const view = await getAgentPlanView(service, portal.user.id, mode);
  const caps = billingCapabilities({
    access,
    isImpersonating: false,
    enabled: true,
    agentPlan: view.state,
    renewalUnpaid: view.row?.status === 'unpaid',
    // BACKLOG-3878: the licence (view.suspended). A suspended account cannot
    // cancel, keep or end its plan, or buy one; it may still replace its card.
    accountSuspended: view.suspended,
    orgBillingSetUp: false,
  });
  if (!caps || caps.kind !== 'personal') return { error: NOT_AVAILABLE };
  return { userId: portal.user.id, email: portal.user.email ?? null, service, mode, view, caps };
}

export async function returnBase(): Promise<string> {
  const h = await headers();
  const chosen = chooseReturnBase(h.get('x-forwarded-host') ?? h.get('host'), {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  });
  console.info(
    `[billing/agent] checkout return base ${chosen.base} (${chosen.source}; VERCEL_BRANCH_URL ${process.env.VERCEL_BRANCH_URL ? 'set' : 'unset'})`
  );
  return chosen.base;
}
