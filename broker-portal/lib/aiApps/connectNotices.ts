/**
 * The "an AI app was connected" email job (BACKLOG-4263 PR-10.8).
 *
 * Reachability: broker-portal/vercel.json cron (every 5 minutes, production only) ->
 * app/api/cron/ai-app-notices/route.ts -> drainAiAppConnectNotices.
 *
 * The database writes one ai_app_connect_notices row when an AI app's connection turns active
 * (migration 20261118180000, mcp_exchange_code). This job:
 *   1. claims up to CLAIM_LIMIT due rows with ai_app_notice_claim (service role, through PostgREST;
 *      the function refuses any caller whose request role is not service_role). Each claimed row is
 *      leased for 5 minutes and its attempts counted;
 *   2. per row: reads the person's sign-in address with auth.admin.getUserById(row.user_id);
 *      checks email_delivery_log for an earlier send of this notice; sends the email; and records
 *      the outcome with ai_app_notice_done(id, attempts, status, code).
 *
 * Outcome -> status: sent -> 'sent'; queued -> 'queued'; skipped (mail not configured) ->
 * 'skipped'; failed -> 'due' (releases the lease; the claim retries it and marks it 'failed' after
 * 5 tries); no user or no address -> 'skipped' with 'no_address'.
 *
 * At-least-once: a run that sends and dies before `done` leaves the row due; after the lease it is
 * claimed again. Before sending, the job looks for a 'sent' or 'queued' delivery-log row carrying
 * this notice_id and, if found, records that outcome instead of sending again. The window left: the
 * mail service accepted the send and the run died before sendEmail wrote its log row.
 *
 * `done` answering false means the row is no longer this run's (re-claimed or finished); it is
 * logged and never causes a second send. Logs carry fixed codes and counts only: no address, no id.
 * last_error values are fixed codes of at most 40 characters, never provider or app text.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/send-email';
import { buildAiAppConnectedEmail } from '@/lib/email/templates/ai-app-connected';
import type { Provider } from '@/lib/mcp/account/messages';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const CLAIM_LIMIT = 20;
export const NOTICE_LOG_KIND = 'ai_app_connected';
const LOG = '[cron/ai-app-notices]';

/** One element of ai_app_notice_claim's answer (20261118180000, jsonb_build_object at :217-218). */
export interface ClaimedNotice {
  id: string;
  user_id: string;
  provider: Provider;
  replaced: boolean;
  connected_at: string;
  attempts: number;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  queued: number;
  skipped: number;
  failed: number;
}

/** Fixed codes written to last_error or logged. Each is at most 40 characters. */
export const CODES = {
  noAddress: 'no_address',
  sendFailed: 'send_failed',
  sendThrew: 'send_threw',
  lookupFailed: 'user_lookup_failed',
  logReadFailed: 'delivery_log_read_failed',
  emailNotConfigured: 'email_not_configured',
} as const;

const CLAIM_KEYS = ['attempts', 'connected_at', 'id', 'provider', 'replaced', 'user_id'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isClaimedNotice(v: unknown): v is ClaimedNotice {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((k, i) => k !== CLAIM_KEYS[i])) return false;
  return (
    typeof r.id === 'string' &&
    UUID_RE.test(r.id) &&
    typeof r.user_id === 'string' &&
    UUID_RE.test(r.user_id) &&
    (r.provider === 'anthropic' || r.provider === 'openai') &&
    typeof r.replaced === 'boolean' &&
    typeof r.connected_at === 'string' &&
    !Number.isNaN(Date.parse(r.connected_at)) &&
    typeof r.attempts === 'number' &&
    Number.isInteger(r.attempts) &&
    r.attempts >= 1
  );
}

/** The whole answer, or null when any part of it is not the contract's shape. */
export function parseClaimAnswer(data: unknown): ClaimedNotice[] | null {
  if (!Array.isArray(data) || data.length > CLAIM_LIMIT) return null;
  return data.every(isClaimedNotice) ? (data as ClaimedNotice[]) : null;
}

function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

/** Same setting as the other portal emails (lib/domain/captureNotice.ts:25-27). */
export function portalOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

type Lookup = { kind: 'address'; email: string } | { kind: 'none' } | { kind: 'error' };

async function lookupAddress(service: ServiceClient, userId: string): Promise<Lookup> {
  try {
    const { data, error } = await service.auth.admin.getUserById(userId);
    if (error) {
      const e = error as { status?: number; code?: string };
      // auth-js answers a missing user with an AuthApiError (status 404, code user_not_found).
      if (e.status === 404 || e.code === 'user_not_found') return { kind: 'none' };
      return { kind: 'error' };
    }
    const email = data?.user?.email?.trim();
    return email ? { kind: 'address', email } : { kind: 'none' };
  } catch {
    return { kind: 'error' };
  }
}

/** An earlier send of this notice in email_delivery_log: 'sent' wins over 'queued'. */
async function earlierSend(service: ServiceClient, noticeId: string): Promise<'sent' | 'queued' | null | 'error'> {
  try {
    const { data, error } = await service
      .from('email_delivery_log')
      .select('status')
      .eq('metadata->>kind', NOTICE_LOG_KIND)
      .eq('metadata->>notice_id', noticeId)
      .in('status', ['sent', 'queued'])
      .limit(10);
    if (error || !Array.isArray(data)) return 'error';
    const statuses = (data as Array<{ status?: unknown }>).map((r) => r.status);
    if (statuses.includes('sent')) return 'sent';
    if (statuses.includes('queued')) return 'queued';
    return null;
  } catch {
    return 'error';
  }
}

type DoneStatus = 'due' | 'sent' | 'queued' | 'skipped';

async function markDone(service: ServiceClient, row: ClaimedNotice, status: DoneStatus, code: string | null): Promise<void> {
  try {
    const { data, error } = await service.rpc('ai_app_notice_done', {
      p_id: row.id,
      p_attempts: row.attempts,
      p_status: status,
      p_error: code,
    });
    if (error) console.error(`${LOG} done_error`, error.code ?? 'unknown');
    else if (data !== true) console.warn(`${LOG} status_not_updated`, status);
  } catch {
    console.error(`${LOG} done_threw`);
  }
}

type RowResult = 'sent' | 'queued' | 'skipped' | 'failed';

async function processRow(service: ServiceClient, row: ClaimedNotice, origin: string): Promise<RowResult> {
  const who = await lookupAddress(service, row.user_id);
  if (who.kind === 'error') {
    await markDone(service, row, 'due', CODES.lookupFailed);
    return 'failed';
  }
  if (who.kind === 'none') {
    await markDone(service, row, 'skipped', CODES.noAddress);
    return 'skipped';
  }

  const earlier = await earlierSend(service, row.id);
  if (earlier === 'error') {
    await markDone(service, row, 'due', CODES.logReadFailed);
    return 'failed';
  }
  if (earlier) {
    await markDone(service, row, earlier, null);
    return earlier;
  }

  const content = buildAiAppConnectedEmail({
    provider: row.provider,
    replaced: row.replaced,
    connectedAt: row.connected_at,
    portalOrigin: origin,
  });
  let outcome: 'sent' | 'queued' | 'skipped' | 'failed';
  try {
    const result = await sendEmail({
      to: who.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      emailType: 'other',
      logMetadata: { kind: NOTICE_LOG_KIND, notice_id: row.id },
    });
    outcome = result.outcome ?? (result.success ? 'sent' : 'failed');
  } catch {
    await markDone(service, row, 'due', CODES.sendThrew);
    return 'failed';
  }

  if (outcome === 'sent' || outcome === 'queued') {
    await markDone(service, row, outcome, null);
    return outcome;
  }
  if (outcome === 'skipped') {
    await markDone(service, row, 'skipped', CODES.emailNotConfigured);
    return 'skipped';
  }
  await markDone(service, row, 'due', CODES.sendFailed);
  return 'failed';
}

export async function drainAiAppConnectNotices(): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, sent: 0, queued: 0, skipped: 0, failed: 0 };
  let service: ServiceClient;
  let data: unknown;
  try {
    service = createServiceClient();
    const res = await service.rpc('ai_app_notice_claim', { p_limit: CLAIM_LIMIT });
    if (res.error) {
      console.error(`${LOG} ${isMissingFunction(res.error) ? 'claim_missing_function' : 'claim_error'}`, res.error.code ?? 'unknown');
      return summary;
    }
    data = res.data;
  } catch {
    console.error(`${LOG} claim_threw`);
    return summary;
  }

  const rows = parseClaimAnswer(data);
  if (!rows) {
    console.error(`${LOG} claim_answer_invalid`);
    return summary;
  }
  summary.claimed = rows.length;

  const origin = portalOrigin();
  for (const row of rows) {
    let result: RowResult;
    try {
      result = await processRow(service, row, origin);
    } catch {
      console.error(`${LOG} row_threw`);
      result = 'failed';
    }
    summary[result] += 1;
  }
  if (summary.claimed > 0) console.info(`${LOG} done`, summary);
  return summary;
}
