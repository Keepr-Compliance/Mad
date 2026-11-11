'use server';

/**
 * Brokerage domain claims: add a domain, check its DNS TXT record, remove it — BACKLOG-3962.
 *
 * The only browser-supplied values are the typed domain (create) and a claim id (check,
 * withdraw). The organization always comes from the session (requireDomainClaimAccess).
 *
 * Create and withdraw run on the caller's session client: the database functions decide on
 * auth.uid() and refuse anyone who is not an admin of the organization.
 *
 * Check runs the two check functions on the server-role client, which the database accepts
 * from nothing else. This action is where the person is authorised; the DNS answers it passes
 * are the ones it fetched itself, and the database compares them with the claim row's own token.
 */

import * as Sentry from '@sentry/nextjs';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { createServiceClient } from '@/lib/supabase/service';
import { requireDomainClaimAccess } from '@/lib/domain/access';
import { normalizeClaimDomain } from '@/lib/domain/normalize';
import { lookupClaimTxt } from '@/lib/domain/doh';
import {
  CHECK_RESULTS,
  DOMAIN_CLAIM_CONSUMER,
  DOMAIN_CLAIM_FAILED,
  DOMAIN_CLAIM_INVALID,
  DOMAIN_CLAIM_NOT_AUTHORIZED,
  DOMAIN_CLAIM_NOT_FOUND,
  DOMAIN_CLAIM_TOO_MANY,
  DOMAIN_CLAIM_TOO_SOON,
  DOMAIN_CLAIM_UNAVAILABLE,
  checkResultMessage,
  domainTakenMessage,
  doubledNameMessage,
  isNotDeployedError,
  type DomainCheckResult,
  type DomainClaimActionResult,
  type DomainClaimStatus,
} from '@/lib/domain/claims';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcReply = { data: unknown; error: { code?: string; message?: string } | null };

function fail(message: string): DomainClaimActionResult {
  return { success: false, message };
}

function rpcFailure(error: { code?: string } | null, where: string): DomainClaimActionResult {
  if (isNotDeployedError(error)) return fail(DOMAIN_CLAIM_UNAVAILABLE);
  Sentry.captureMessage('domain claim rpc failed', { level: 'warning', extra: { where, code: error?.code ?? null } });
  return fail(DOMAIN_CLAIM_FAILED);
}

function replyObject(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

export async function createDomainClaim(input: string): Promise<DomainClaimActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);

  const domain = normalizeClaimDomain(input);
  if (!domain) return fail(DOMAIN_CLAIM_INVALID);

  const access = await requireDomainClaimAccess();
  if (!access.ok) return fail(DOMAIN_CLAIM_NOT_AUTHORIZED);

  const { data, error } = (await access.supabase.rpc('domain_claim_create', {
    p_org: access.organizationId,
    p_domain: domain,
  })) as RpcReply;
  if (error) return rpcFailure(error, 'create');

  const reply = replyObject(data);
  if (reply.success === true) {
    return { success: true, message: `Add the TXT record below for ${domain}, then click Check.`, status: 'pending' };
  }
  switch (reply.error) {
    case 'invalid_domain':
      return fail(DOMAIN_CLAIM_INVALID);
    case 'consumer_domain':
      return fail(DOMAIN_CLAIM_CONSUMER);
    case 'domain_taken':
      return fail(domainTakenMessage(domain));
    case 'too_many_claims':
      return fail(DOMAIN_CLAIM_TOO_MANY);
    case 'not_authorized':
    case 'not_authenticated':
      return fail(DOMAIN_CLAIM_NOT_AUTHORIZED);
    default:
      return fail(DOMAIN_CLAIM_FAILED);
  }
}

/**
 * True when the claim's exact token is published at `_keepr.<domain>.<domain>`: a DNS host that
 * appends the zone to a Host that already ended in it. Never throws; any failure is "no".
 * lookupClaimTxt(`${domain}.${domain}`) queries exactly that name.
 */
async function foundAtDoubledName(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  organizationId: string,
  claimId: string,
  domain: string
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('domain_claims')
      .select('token')
      .eq('id', claimId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const token = (data as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || token === '') return false;
    const doubled = await lookupClaimTxt(`${domain}.${domain}`);
    return doubled.answers.includes(token);
  } catch {
    return false;
  }
}

export async function checkDomainClaim(claimId: string): Promise<DomainClaimActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);
  if (typeof claimId !== 'string' || !UUID.test(claimId)) return fail(DOMAIN_CLAIM_NOT_FOUND);

  const access = await requireDomainClaimAccess();
  if (!access.ok) return fail(DOMAIN_CLAIM_NOT_AUTHORIZED);

  const service = createServiceClient({ actorId: access.userId });

  // Binds the claim to the session's organization and enforces the 30 s limit.
  const begin = (await service.rpc('_domain_claim_begin_check', {
    p_claim: claimId,
    p_org: access.organizationId,
  })) as RpcReply;
  if (begin.error) return rpcFailure(begin.error, 'begin_check');
  const started = replyObject(begin.data);
  if (started.success !== true || typeof started.domain !== 'string') {
    if (started.error === 'too_soon') return fail(DOMAIN_CLAIM_TOO_SOON);
    return fail(DOMAIN_CLAIM_NOT_FOUND);
  }
  const domain = started.domain;

  const lookup = await lookupClaimTxt(domain);

  const recorded = (await service.rpc('_domain_claim_record_check', {
    p_claim: claimId,
    p_org: access.organizationId,
    p_answers: lookup.answers,
    p_resolver_ok: lookup.resolverOk,
    p_source: 'manual',
  })) as RpcReply;
  if (recorded.error) return rpcFailure(recorded.error, 'record_check');
  const reply = replyObject(recorded.data);
  const result = reply.result;
  if (reply.success !== true || typeof result !== 'string' || !(CHECK_RESULTS as readonly string[]).includes(result)) {
    return fail(DOMAIN_CLAIM_NOT_FOUND);
  }
  if (result === 'not_found' && (await foundAtDoubledName(access.supabase, access.organizationId, claimId, domain))) {
    // Display-only. The check above was recorded as a miss and stays one.
    return {
      success: false,
      message: doubledNameMessage(domain),
      result: 'not_found',
      status: typeof reply.status === 'string' ? (reply.status as DomainClaimStatus) : undefined,
      doubledName: true,
    };
  }
  return {
    success: result === 'verified',
    message: checkResultMessage(result as DomainCheckResult, domain),
    result: result as DomainCheckResult,
    status: typeof reply.status === 'string' ? (reply.status as DomainClaimStatus) : undefined,
  };
}

export async function withdrawDomainClaim(claimId: string): Promise<DomainClaimActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);
  if (typeof claimId !== 'string' || !UUID.test(claimId)) return fail(DOMAIN_CLAIM_NOT_FOUND);

  const access = await requireDomainClaimAccess();
  if (!access.ok) return fail(DOMAIN_CLAIM_NOT_AUTHORIZED);

  const { data, error } = (await access.supabase.rpc('domain_claim_withdraw', { p_claim: claimId })) as RpcReply;
  if (error) return rpcFailure(error, 'withdraw');
  const reply = replyObject(data);
  if (reply.success === true) return { success: true, message: 'Domain removed.', status: 'withdrawn' };
  return fail(DOMAIN_CLAIM_NOT_FOUND);
}
