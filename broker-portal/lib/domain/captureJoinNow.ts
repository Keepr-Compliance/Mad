/**
 * "Join now" for a scheduled domain capture move — BACKLOG-3962.
 *
 * Reachability: components/CaptureNoticeBanner.tsx (confirm step) -> joinNowSelf
 * (lib/actions/domainCapture.ts) -> runCaptureJoinNow.
 *
 * 1. Pre-read, server role, filtered to the switch id AND the session user AND status scheduled.
 *    Nothing else happens for a switch that is not the caller's own (no DNS read, no write).
 * 2. A fresh DNS re-check of the claim, unless one verified answer is already under 50 minutes old
 *    (_domain_capture_switch requires a verified answer from the last hour).
 * 3. _domain_capture_join_now(p_switch, p_user): every switch check runs in the database, and a
 *    deferral changes nothing.
 * 4. On 'switched': the same notifications as the hourly job (notifySwitched), one-person list.
 */

import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TxtLookup } from '@/lib/domain/doh';
import { isNotDeployedError } from '@/lib/domain/claims';
import { notifySwitched, recheckClaimDns, type NotifyDeps } from '@/lib/domain/captureSwitch';

/** A verified DNS answer younger than this is used as is. */
export const JOIN_DNS_FRESH_MS = 50 * 60 * 1000;

export interface JoinNowDeps extends NotifyDeps {
  service: SupabaseClient;
  lookup?: (domain: string) => Promise<TxtLookup>;
}

export type JoinNowResult =
  | { status: 'switched'; brokerageName: string; licensed: boolean }
  | {
      status: 'error';
      /** switch_not_found | not_scheduled | dns_not_fresh | billing_not_ready | billing_setup_incomplete | cancelled | unavailable | failed */
      code: string;
      brokerageName: string;
      /** the scheduled date (ISO), when the switch was read */
      switchAt?: string;
      /** not_scheduled: the row's status */
      rowStatus?: string;
    };

const FALLBACK_NAME = 'your brokerage';

export async function runCaptureJoinNow(deps: JoinNowDeps, userId: string, switchId: string): Promise<JoinNowResult> {
  const { service } = deps;
  const now = deps.now ?? Date.now;

  // 1. the caller's own scheduled switch
  const { data: row, error: readError } = await service
    .from('domain_capture_switches')
    .select('id, organization_id, claim_id, user_id, switch_at')
    .eq('id', switchId)
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .maybeSingle();
  if (readError) {
    return { status: 'error', code: isNotDeployedError(readError) ? 'unavailable' : 'failed', brokerageName: FALLBACK_NAME };
  }
  const sw = row as { organization_id?: unknown; claim_id?: unknown; switch_at?: unknown } | null;
  if (!sw || typeof sw.organization_id !== 'string' || typeof sw.claim_id !== 'string') {
    return { status: 'error', code: 'switch_not_found', brokerageName: FALLBACK_NAME };
  }
  const switchAt = typeof sw.switch_at === 'string' ? sw.switch_at : undefined;

  const [{ data: org }, { data: claim }] = await Promise.all([
    service.from('organizations').select('name').eq('id', sw.organization_id).maybeSingle(),
    service
      .from('domain_claims')
      .select('domain, last_check_result, last_checked_at')
      .eq('id', sw.claim_id)
      .maybeSingle(),
  ]);
  const name = (org as { name?: unknown } | null)?.name;
  const brokerageName = typeof name === 'string' && name.trim() ? name : FALLBACK_NAME;
  const c = (claim ?? {}) as { domain?: unknown; last_check_result?: unknown; last_checked_at?: unknown };

  // 2. DNS: re-check unless a verified answer is under 50 minutes old
  const checkedAt = typeof c.last_checked_at === 'string' ? Date.parse(c.last_checked_at) : NaN;
  const fresh = c.last_check_result === 'verified' && Number.isFinite(checkedAt) && now() - checkedAt < JOIN_DNS_FRESH_MS;
  if (!fresh && typeof c.domain === 'string') {
    await recheckClaimDns(service, { claim_id: sw.claim_id, organization_id: sw.organization_id, domain: c.domain }, deps.lookup);
  }

  // 3. the join, decided in the database
  const { data, error } = await service.rpc('_domain_capture_join_now', { p_switch: switchId, p_user: userId });
  if (error) {
    // 40P01 (deadlock) and anything unexpected read as a failure; nothing was changed.
    return { status: 'error', code: isNotDeployedError(error) ? 'unavailable' : 'failed', brokerageName, switchAt };
  }
  const r = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (r.success !== true) {
    return {
      status: 'error',
      code: typeof r.error === 'string' ? r.error : 'failed',
      brokerageName,
      switchAt,
      rowStatus: typeof r.status === 'string' ? r.status : undefined,
    };
  }
  if (r.outcome === 'cancelled') return { status: 'error', code: 'cancelled', brokerageName, switchAt };
  if (r.outcome !== 'switched') return { status: 'error', code: 'failed', brokerageName, switchAt };

  // 4. notifications, as the hourly job
  // The person has moved; a throw from the notifications (the seat-alert stage can throw) must not turn
  // that into an error result.
  try {
    await notifySwitched(service, [{ switchId, userId, organizationId: sw.organization_id, reply: r }], deps);
  } catch (notifyError) {
    Sentry.captureMessage('Join now: notifications failed after the move', {
      level: 'warning',
      tags: { action: 'domain_capture_join_now' },
      extra: { switchId, error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
    });
  }
  const replyName = typeof r.brokerage_name === 'string' && r.brokerage_name.trim() ? r.brokerage_name : brokerageName;
  return { status: 'switched', brokerageName: replyName, licensed: r.license_status === 'active' };
}
