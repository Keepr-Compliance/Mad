'use server';

/**
 * Brokerage domain capture: schedule, cancel, opt out — BACKLOG-3962 PR3a.
 *
 * startCapture / cancelCapture: an org admin, through requireDomainClaimAccess. The organization is
 * ALWAYS the session's own; a value posted by the browser is never read. The database functions
 * decide on auth.uid() as well, and re-evaluate every person (the posted list is a request).
 *
 * optOutSelf: the signed-in person, for their own scheduled switch, after a confirm step. The email
 * link only opens the portal (GET changes nothing); only this action, with confirm === true, opts out.
 *
 * Portal code ships before the migration: a missing function (PGRST202 etc.) answers
 * DOMAIN_CAPTURE_UNAVAILABLE.
 */

import * as Sentry from '@sentry/nextjs';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireDomainClaimAccess } from '@/lib/domain/access';
import { isNotDeployedError } from '@/lib/domain/claims';
import { isScheduledSwitch, sendCaptureNotices } from '@/lib/domain/captureNotice';
import {
  DOMAIN_CAPTURE_UNAVAILABLE,
  DOMAIN_CAPTURE_FAILED,
  DOMAIN_CAPTURE_NOT_AUTHORIZED,
  DOMAIN_CAPTURE_NOT_VERIFIED,
  DOMAIN_CAPTURE_NOT_FOUND,
  DOMAIN_CAPTURE_NOT_SCHEDULED,
  DOMAIN_CAPTURE_BILLING_NOT_READY,
  DOMAIN_CAPTURE_CONFIRM,
  DOMAIN_CAPTURE_TOO_LATE,
  DOMAIN_CAPTURE_SIGNED_OUT,
  type DomainCaptureActionResult,
} from '@/lib/domain/captureMessages';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PEOPLE = 500;


type RpcReply = { data: unknown; error: { code?: string; message?: string } | null };

function fail(message: string): DomainCaptureActionResult {
  return { success: false, message };
}

function rpcFailure(error: { code?: string } | null, where: string): DomainCaptureActionResult {
  if (isNotDeployedError(error)) return fail(DOMAIN_CAPTURE_UNAVAILABLE);
  Sentry.captureMessage('domain capture rpc failed', { level: 'warning', extra: { where, code: error?.code ?? null } });
  return fail(DOMAIN_CAPTURE_FAILED);
}

function replyObject(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function stateError(code: unknown): DomainCaptureActionResult {
  switch (code) {
    case 'not_authorized':
    case 'not_authenticated':
      return fail(DOMAIN_CAPTURE_NOT_AUTHORIZED);
    case 'claim_not_found':
    case 'claim_not_verified':
      return fail(DOMAIN_CAPTURE_NOT_VERIFIED);
    case 'billing_not_ready':
      return fail(DOMAIN_CAPTURE_BILLING_NOT_READY);
    case 'switch_not_found':
      return fail(DOMAIN_CAPTURE_NOT_FOUND);
    case 'not_scheduled':
      return fail(DOMAIN_CAPTURE_NOT_SCHEDULED);
    case 'too_late':
      return fail(DOMAIN_CAPTURE_TOO_LATE);
    default:
      return fail(DOMAIN_CAPTURE_FAILED);
  }
}

/**
 * Schedule the move of the chosen people. Only `claimId` and `userIds` are read from the input.
 */
export async function startCapture(input: { claimId: string; userIds: string[] }): Promise<DomainCaptureActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);
  const claimId = input?.claimId;
  const userIds = input?.userIds;
  if (typeof claimId !== 'string' || !UUID.test(claimId)) return fail(DOMAIN_CAPTURE_NOT_VERIFIED);
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > MAX_PEOPLE ||
      !userIds.every((u) => typeof u === 'string' && UUID.test(u))) {
    return fail('Choose at least one person to move.');
  }

  const access = await requireDomainClaimAccess();
  if (!access.ok) return fail(DOMAIN_CAPTURE_NOT_AUTHORIZED);

  const { data, error } = (await access.supabase.rpc('domain_capture_start', {
    p_org: access.organizationId,
    p_claim: claimId,
    p_users: Array.from(new Set(userIds)),
  })) as RpcReply;
  if (error) return rpcFailure(error, 'start');
  const reply = replyObject(data);
  if (reply.success !== true) return stateError(reply.error);

  const scheduled = (Array.isArray(reply.scheduled) ? reply.scheduled : []).filter(isScheduledSwitch);
  const skipped = (Array.isArray(reply.skipped) ? reply.skipped : []) as Array<{ user_id: string; reason: string }>;
  const notices = await sendCaptureNotices(createServiceClient({ actorId: access.userId }), scheduled, {
    brokerageName: typeof reply.brokerage_name === 'string' ? reply.brokerage_name : 'your brokerage',
    domain: typeof reply.domain === 'string' ? reply.domain : '',
  });

  const parts = [`${scheduled.length} scheduled to move in 14 days.`];
  if (notices.undelivered > 0) parts.push(`${notices.undelivered} not moved: the notice email could not be delivered.`);
  if (notices.queued > 0) parts.push(`${notices.queued} notice email(s) will be retried.`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped.`);
  return {
    success: true,
    message: parts.join(' '),
    scheduled: scheduled.length,
    noticesSent: notices.sent,
    noticesQueued: notices.queued,
    noticesUndelivered: notices.undelivered,
    skipped,
  };
}

/** An org admin cancels one scheduled move. */
export async function cancelCapture(switchId: string): Promise<DomainCaptureActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);
  if (typeof switchId !== 'string' || !UUID.test(switchId)) return fail(DOMAIN_CAPTURE_NOT_FOUND);

  const access = await requireDomainClaimAccess();
  if (!access.ok) return fail(DOMAIN_CAPTURE_NOT_AUTHORIZED);

  const { data, error } = (await access.supabase.rpc('domain_capture_cancel', { p_switch: switchId })) as RpcReply;
  if (error) return rpcFailure(error, 'cancel');
  const reply = replyObject(data);
  if (reply.success !== true) return stateError(reply.error);
  return { success: true, message: 'The move was cancelled.' };
}

/** The signed-in person opts out of their own scheduled move. Requires confirm === true. */
export async function optOutSelf(input: { switchId: string; confirm: boolean }): Promise<DomainCaptureActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return fail(blocked.error);
  const switchId = input?.switchId;
  if (typeof switchId !== 'string' || !UUID.test(switchId)) return fail(DOMAIN_CAPTURE_NOT_FOUND);
  if (input?.confirm !== true) return fail(DOMAIN_CAPTURE_CONFIRM);

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return fail(DOMAIN_CAPTURE_SIGNED_OUT);

  const { data, error } = (await supabase.rpc('domain_capture_opt_out_self', { p_switch: switchId })) as RpcReply;
  if (error) return rpcFailure(error, 'opt_out');
  const reply = replyObject(data);
  if (reply.success !== true) return stateError(reply.error);
  return { success: true, message: 'Your account stays separate. It will not be moved.' };
}
