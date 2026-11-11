/**
 * The hourly domain capture switch job — BACKLOG-3962 PR3a.
 *
 * Reachability: broker-portal/vercel.json cron -> app/api/cron/domain-capture-switch/route.ts ->
 * runCaptureSwitch.
 *
 * 1. _domain_capture_due takes the scheduled switches whose day has come (selects and stamps them).
 * 2. Per claim, ONE fresh DNS-over-HTTPS read of `_keepr.<domain>`, recorded with
 *    _domain_claim_record_check, p_source 'recheck' (misses are spaced 20 h apart in the database,
 *    so an hourly call cannot lapse a claim faster than the daily re-check, and a claim whose record
 *    is gone still lapses, which cancels its switches). _domain_capture_switch refuses unless a
 *    verified answer was recorded in the last hour.
 * 3. A notice still undecided (queued for retry) is decided from the delivery log: a 'sent' row of
 *    kind domain_capture_notice for that switch marks it delivered; otherwise the switch cancels it.
 * 4. _domain_capture_switch per row. Non-payers get one "switched" email. Payers get only the
 *    BACKLOG-3850 "plan ended" email, sent by the billing outbox the membership insert queued.
 * 5. One seat-limit email per brokerage per run when anyone joined without a license.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { lookupClaimTxt, type TxtLookup } from '@/lib/domain/doh';
import { isNotDeployedError } from '@/lib/domain/claims';
import {
  DOMAIN_CAPTURE_NOTICE_LOG_KIND,
  sendDomainCaptureSwitchedEmail,
  sendSeatLimitReachedEmail,
} from '@/lib/email';
import { loadSeatAlertContext } from '@/lib/users/seatRecipients';

export const CAPTURE_BATCH_LIMIT = 100;
/** People named in a seat email before "and N more". */
const SEAT_EMAIL_NAMES = 5;

export interface DueSwitch {
  switch_id: string;
  organization_id: string;
  claim_id: string;
  user_id: string;
  domain: string;
  notice_delivered: boolean | null;
}

function isDueSwitch(v: unknown): v is DueSwitch {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.switch_id === 'string' && typeof r.organization_id === 'string' &&
    typeof r.claim_id === 'string' && typeof r.user_id === 'string' && typeof r.domain === 'string';
}

export interface CaptureSwitchDeps {
  service: SupabaseClient;
  lookup?: (domain: string) => Promise<TxtLookup>;
  sendSwitched?: typeof sendDomainCaptureSwitchedEmail;
  sendSeatAlert?: typeof sendSeatLimitReachedEmail;
  now?: () => number;
}

export interface CaptureSwitchSummary {
  status: 'ok' | 'not_deployed' | 'error';
  due: number;
  switched: number;
  unassigned: number;
  cancelled: Record<string, number>;
  deferred: Record<string, number>;
  failed: number;
  switchedEmails: number;
  seatAlerts: number;
}

function personList(emails: string[]): string {
  const shown = emails.slice(0, SEAT_EMAIL_NAMES);
  const rest = emails.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

export async function runCaptureSwitch(deps: CaptureSwitchDeps): Promise<CaptureSwitchSummary> {
  const { service } = deps;
  const lookup = deps.lookup ?? lookupClaimTxt;
  const sendSwitched = deps.sendSwitched ?? sendDomainCaptureSwitchedEmail;
  const sendSeatAlert = deps.sendSeatAlert ?? sendSeatLimitReachedEmail;
  const now = deps.now ?? Date.now;
  const summary: CaptureSwitchSummary = {
    status: 'ok', due: 0, switched: 0, unassigned: 0, cancelled: {}, deferred: {}, failed: 0,
    switchedEmails: 0, seatAlerts: 0,
  };

  const { data, error } = await service.rpc('_domain_capture_due', { p_limit: CAPTURE_BATCH_LIMIT });
  if (error) {
    summary.status = isNotDeployedError(error) ? 'not_deployed' : 'error';
    return summary;
  }
  const rows = (Array.isArray(data) ? data : []).filter(isDueSwitch);
  summary.due = rows.length;

  // 2. one fresh DNS check per claim
  const claims = new Map<string, DueSwitch>();
  for (const r of rows) if (!claims.has(r.claim_id)) claims.set(r.claim_id, r);
  for (const r of claims.values()) {
    try {
      const answer = await lookup(r.domain);
      await service.rpc('_domain_claim_record_check', {
        p_claim: r.claim_id,
        p_org: r.organization_id,
        p_answers: answer.answers,
        p_resolver_ok: answer.resolverOk,
        p_source: 'recheck',
      });
    } catch {
      // No fresh answer recorded: the switch below defers (dns_not_fresh).
    }
  }

  const unassignedByOrg = new Map<string, { emails: string[]; userIds: string[] }>();

  for (const row of rows) {
    try {
      // 3. a notice queued for retry: delivered when the retry drain logged it 'sent'
      if (row.notice_delivered !== true) {
        const { data: logged } = await service
          .from('email_delivery_log')
          .select('id')
          .eq('metadata->>kind', DOMAIN_CAPTURE_NOTICE_LOG_KIND)
          .eq('metadata->>switchId', row.switch_id)
          .eq('status', 'sent')
          .limit(1);
        if (Array.isArray(logged) && logged.length > 0) {
          await service.rpc('_domain_capture_mark_notice', { p_switch: row.switch_id, p_outcome: 'sent' });
        }
      }

      // 4. the switch
      const { data: reply, error: switchError } = await service.rpc('_domain_capture_switch', { p_switch: row.switch_id });
      const r = (reply ?? {}) as Record<string, unknown>;
      if (switchError || typeof r !== 'object') {
        summary.failed += 1;
        continue;
      }
      if (r.success !== true) {
        const why = typeof r.error === 'string' ? r.error : 'unknown';
        summary.deferred[why] = (summary.deferred[why] ?? 0) + 1;
        continue;
      }
      if (r.outcome === 'cancelled') {
        const why = typeof r.reason === 'string' ? r.reason : 'unknown';
        summary.cancelled[why] = (summary.cancelled[why] ?? 0) + 1;
        continue;
      }
      if (r.outcome !== 'switched') {
        summary.failed += 1;
        continue;
      }
      summary.switched += 1;
      const email = typeof r.email === 'string' ? r.email : '';
      const licensed = r.license_status === 'active';
      if (!licensed) {
        summary.unassigned += 1;
        const entry = unassignedByOrg.get(row.organization_id) ?? { emails: [], userIds: [] };
        entry.emails.push(email);
        entry.userIds.push(row.user_id);
        unassignedByOrg.set(row.organization_id, entry);
      }
      // Payers get the 3850 "plan ended" email only.
      if (r.payer !== true && email) {
        const sent = await sendSwitched({
          recipientEmail: email,
          brokerageName: typeof r.brokerage_name === 'string' && r.brokerage_name.trim() ? r.brokerage_name : 'your brokerage',
          licensed,
          switchId: row.switch_id,
        });
        if (sent.outcome === 'sent' || sent.outcome === 'queued') summary.switchedEmails += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  // 5. one seat-limit email per brokerage per run
  for (const [orgId, entry] of unassignedByOrg) {
    const ctx = await loadSeatAlertContext(service, orgId, now(), entry.userIds);
    if (!ctx || ctx.recipients.length === 0) continue;
    for (const to of ctx.recipients) {
      await sendSeatAlert({
        recipientEmail: to,
        personLabel: personList(entry.emails),
        brokerageName: ctx.brokerageName,
        used: ctx.used,
        maxSeats: ctx.maxSeats,
        kind: 'domain_capture',
      });
    }
    summary.seatAlerts += 1;
  }

  return summary;
}
