/**
 * Day-0 domain capture notices — BACKLOG-3962 PR3a.
 *
 * One email per newly scheduled switch, then the outcome is recorded with
 * _domain_capture_mark_notice (server role):
 *   'sent'    the mail service accepted the send -> delivered
 *   'queued'  a transient failure went to the retry queue -> decided by the switch job
 *   'failed' / 'skipped' -> the database cancels that switch (notice_undelivered)
 * "Delivered" means accepted by the mail service (Microsoft Graph 202). Keepr receives no bounce
 * reports, so a later bounce is not seen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { sendDomainCaptureNoticeEmail } from '@/lib/email';

/**
 * Tokenless: the portal page reads the signed-in person's own scheduled switch. Each link only
 * focuses one button on the banner; the choice is made there, after a confirm step. Emails sent
 * before "Join now" carry /dashboard?capture=notice, which still focuses "Keep".
 */
export const CAPTURE_JOIN_PATH = '/dashboard?capture=join';
export const CAPTURE_KEEP_PATH = '/dashboard?capture=keep';

function portalBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

export function captureJoinUrl(): string {
  return `${portalBase()}${CAPTURE_JOIN_PATH}`;
}

export function captureKeepUrl(): string {
  return `${portalBase()}${CAPTURE_KEEP_PATH}`;
}

export interface ScheduledSwitch {
  switch_id: string;
  user_id: string;
  email: string;
  switch_at: string;
  /** Pays for a personal plan (decided by the database at start); absent reads as not a payer */
  payer?: boolean;
}

export function isScheduledSwitch(v: unknown): v is ScheduledSwitch {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.switch_id === 'string' && typeof r.user_id === 'string' && typeof r.email === 'string' &&
    typeof r.switch_at === 'string';
}

export interface NoticeSummary {
  sent: number;
  queued: number;
  undelivered: number;
}

export async function sendCaptureNotices(
  service: SupabaseClient,
  rows: readonly ScheduledSwitch[],
  ctx: { brokerageName: string; domain: string },
): Promise<NoticeSummary> {
  const summary: NoticeSummary = { sent: 0, queued: 0, undelivered: 0 };
  const joinUrl = captureJoinUrl();
  const keepUrl = captureKeepUrl();
  for (const row of rows) {
    let outcome: 'sent' | 'queued' | 'failed' | 'skipped' = 'failed';
    try {
      const result = await sendDomainCaptureNoticeEmail({
        recipientEmail: row.email,
        brokerageName: ctx.brokerageName,
        domain: ctx.domain,
        switchAt: row.switch_at,
        joinUrl,
        keepUrl,
        switchId: row.switch_id,
        payer: row.payer === true,
      });
      outcome = result.outcome ?? (result.success ? 'sent' : 'failed');
    } catch {
      outcome = 'failed';
    }
    const { error } = await service.rpc('_domain_capture_mark_notice', { p_switch: row.switch_id, p_outcome: outcome });
    if (error) {
      // The row stays undecided (notice_delivered NULL); the switch job cancels it unless a 'sent'
      // delivery-log row for it turns up.
      Sentry.captureMessage('domain capture mark_notice failed', { level: 'warning', extra: { code: error.code ?? null } });
    }
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome === 'queued') summary.queued += 1;
    else summary.undelivered += 1;
  }
  return summary;
}
