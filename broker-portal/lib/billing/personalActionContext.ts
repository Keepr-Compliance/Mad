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
import { currentStripeMode } from './mode';
import { chooseReturnBase } from './agentCheckoutParams';
import { agentAccessRefusal, agentContextForUser, type AgentContext } from './agentContextCore';

export type { AgentContext } from './agentContextCore';

export const NOT_AVAILABLE = 'Billing is not available for this account.';
export const NOT_NOW = 'That change is not available for your plan right now. Refresh the page.';
export const MODE_REFUSED = 'Payments are not available for this account.';
export const BILLING_PATH = '/dashboard/billing';

export async function agentContext(): Promise<AgentContext | { error: string }> {
  if (!billingEnabled()) return { error: NOT_AVAILABLE };
  const portal = await getPortalAccess();
  if (!portal) return { error: 'Please sign in again.' };
  // Only a personal owner has an Agent plan; refuse before any billing read.
  // The website shows one message for every refusal code.
  if (agentAccessRefusal(portal.access)) return { error: NOT_AVAILABLE };
  const ctx = await agentContextForUser({
    userId: portal.user.id,
    email: portal.user.email ?? null,
    access: portal.access,
    service: createServiceClient(),
    mode: currentStripeMode(),
  });
  if ('refusal' in ctx) return { error: NOT_AVAILABLE };
  return ctx;
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
