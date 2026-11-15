/**
 * The JIT (auto-join) step of a sign-in, shared by the portal callback (app/auth/callback/route.ts)
 * and the desktop sign-in (lib/actions/desktopJitJoin.ts) — BACKLOG-3962 PR4a.
 *
 * jit_join_organization decides everything in the database: it joins only a brand-new person on a
 * brokerage's VERIFIED email domain. This file asks it, and turns a refusal into a /login code.
 *
 * domainManagedFor: whether the brokerage that verified the caller's own email domain has turned
 * off personal accounts for it (caller_domain_managed; the same answer the licence gate gives).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isBrokerageSuspendedError } from '@/lib/auth/orgSuspension';
import { isBillingSetupIncompleteError, jitTargetFor, type UserWithIdentities } from '@/lib/auth/jitIdentity';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type JitJoinOutcome =
  | { joined: true; organizationId: string; role: string | null }
  /** errorCode null: JIT does not apply to this sign-in (no Microsoft tenant / Workspace domain). */
  | { joined: false; errorCode: string | null };

/** jit_join_organization refusals that have their own /login message. */
const OWN_MESSAGE = ['jit_disabled', 'billing_setup_pending', 'existing_account', 'already_placed'] as const;

/** The /login code for a JIT refusal. Anything else (reauth_required, domain_not_verified, ...) is org_not_setup. */
export function jitErrorCodeFor(result: { error?: unknown } | null | undefined, error: { code?: string; message?: string } | null): string {
  // BACKLOG-3853 PR-2B: the member trigger refuses a join into a suspended brokerage.
  if (isBrokerageSuspendedError(error)) return 'brokerage_suspended';
  // BACKLOG-4012: the member trigger's refusal while billing setup is pending.
  if (isBillingSetupIncompleteError(error)) return 'billing_setup_pending';
  return OWN_MESSAGE.find((code) => code === result?.error) ?? 'org_not_setup';
}

export async function runJitJoin(supabase: RpcClient, user: UserWithIdentities): Promise<JitJoinOutcome> {
  // Microsoft by tenant, Google Workspace by domain, from the identity THIS sign-in used
  // (BACKLOG-4012; lib/auth/jitIdentity.ts). Consumer Google accounts never JIT-join.
  const target = jitTargetFor(user);
  if (!target) return { joined: false, errorCode: null };

  const { data, error } = await supabase.rpc('jit_join_organization', {
    p_provider_type: target.providerType,
    p_identifier: target.identifier,
  });
  if (data?.success) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`JIT joined org ${data.organization_id} with role ${data.role}`);
    }
    return { joined: true, organizationId: data.organization_id, role: data.role ?? null };
  }
  if (error) {
    console.error('JIT join RPC failed:', error);
  }
  return { joined: false, errorCode: jitErrorCodeFor(data, error) };
}

export interface DomainManaged {
  organizationName: string;
  domain: string;
}

/** The caller's own answer from caller_domain_managed; null when not blocked or on any failure. */
export async function domainManagedFor(supabase: RpcClient): Promise<DomainManaged | null> {
  try {
    const { data, error } = await supabase.rpc('caller_domain_managed');
    if (error || !data || data.blocked !== true) return null;
    const organizationName = typeof data.organization_name === 'string' && data.organization_name.trim() ? data.organization_name.trim() : 'Your brokerage';
    const domain = typeof data.domain === 'string' ? data.domain : '';
    return { organizationName, domain };
  } catch {
    return null;
  }
}

/**
 * When a sign-in that was not placed may show domain_managed instead of the JIT code: only over
 * the generic outcomes. An existing account, a placed person, a suspended brokerage and a pending
 * billing setup keep their own, more specific message.
 */
export function domainManagedMayReplace(errorCode: string | null): boolean {
  return errorCode === null || errorCode === 'org_not_setup' || errorCode === 'jit_disabled';
}

/** The message for domain_managed, with the brokerage's name and the domain. */
export function domainManagedMessage(managed: DomainManaged): string {
  const at = managed.domain ? `@${managed.domain}` : 'your email domain';
  return `${managed.organizationName} manages Keepr accounts for ${at}. Ask ${managed.organizationName} to invite you, then open the invitation email.`;
}
