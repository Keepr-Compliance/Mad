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
 *
 * recheckClaimDns and notifySwitched are shared with the "Join now" path (captureJoinNow.ts).
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

export interface ClaimRef {
  claim_id: string;
  organization_id: string;
  domain: string;
}

/**
 * One fresh DNS-over-HTTPS read of `_keepr.<domain>`, recorded as a re-check. A lookup or record
 * that throws records nothing: the switch then defers (dns_not_fresh).
 */
export async function recheckClaimDns(
  service: SupabaseClient,
  claim: ClaimRef,
  lookup: (domain: string) => Promise<TxtLookup> = lookupClaimTxt,
): Promise<void> {
  try {
    const answer = await lookup(claim.domain);
    await service.rpc('_domain_claim_record_check', {
      p_claim: claim.claim_id,
      p_org: claim.organization_id,
      p_answers: answer.answers,
      p_resolver_ok: answer.resolverOk,
      p_source: 'recheck',
    });
  } catch {
    // No fresh answer recorded: the switch defers (dns_not_fresh).
  }
}

/** A successful _domain_capture_switch reply (outcome 'switched'). */
export interface SwitchedPerson {
  switchId: string;
  userId: string;
  organizationId: string;
  reply: Record<string, unknown>;
}

export interface NotifyDeps {
  sendSwitched?: typeof sendDomainCaptureSwitchedEmail;
  sendSeatAlert?: typeof sendSeatLimitReachedEmail;
  now?: () => number;
}

export interface NotifySummary {
  /** Sends that threw (counted as failed by the hourly job, as before the extraction) */
  failed: number;
  unassigned: number;
  switchedEmails: number;
  seatAlerts: number;
}

/**
 * After switches: one "switched" email per non-payer (payers get only the BACKLOG-3850 "plan
 * ended" email), then one seat-limit email per brokerage for everyone who joined without a license.
 */
export async function notifySwitched(
  service: SupabaseClient,
  people: readonly SwitchedPerson[],
  deps: NotifyDeps = {},
): Promise<NotifySummary> {
  const sendSwitched = deps.sendSwitched ?? sendDomainCaptureSwitchedEmail;
  const sendSeatAlert = deps.sendSeatAlert ?? sendSeatLimitReachedEmail;
  const now = deps.now ?? Date.now;
  const out: NotifySummary = { failed: 0, unassigned: 0, switchedEmails: 0, seatAlerts: 0 };
  const unassignedByOrg = new Map<string, { emails: string[]; userIds: string[] }>();

  for (const p of people) {
    const r = p.reply;
    try {
      const email = typeof r.email === 'string' ? r.email : '';
      const licensed = r.license_status === 'active';
      if (!licensed) {
        out.unassigned += 1;
        const entry = unassignedByOrg.get(p.organizationId) ?? { emails: [], userIds: [] };
        entry.emails.push(email);
        entry.userIds.push(p.userId);
        unassignedByOrg.set(p.organizationId, entry);
      }
      // Payers get the 3850 "plan ended" email only.
      if (r.payer !== true && email) {
        const sent = await sendSwitched({
          recipientEmail: email,
          brokerageName: typeof r.brokerage_name === 'string' && r.brokerage_name.trim() ? r.brokerage_name : 'your brokerage',
          licensed,
          switchId: p.switchId,
          joinedEarly: r.joined_early === true,
        });
        if (sent.outcome === 'sent' || sent.outcome === 'queued') out.switchedEmails += 1;
      }
    } catch {
      // The person moved; a failed email does not undo that.
      out.failed += 1;
    }
  }

  // one seat-limit email per brokerage
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
    out.seatAlerts += 1;
  }
  return out;
}

export async function runCaptureSwitch(deps: CaptureSwitchDeps): Promise<CaptureSwitchSummary> {
  const { service } = deps;
  const lookup = deps.lookup ?? lookupClaimTxt;
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
  for (const r of claims.values()) await recheckClaimDns(service, r, lookup);

  const switchedPeople: SwitchedPerson[] = [];

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
      switchedPeople.push({ switchId: row.switch_id, userId: row.user_id, organizationId: row.organization_id, reply: r });
    } catch {
      summary.failed += 1;
    }
  }

  // 4b/5. switched emails, then one seat-limit email per brokerage per run
  const notified = await notifySwitched(service, switchedPeople, deps);
  summary.failed += notified.failed;
  summary.unassigned = notified.unassigned;
  summary.switchedEmails = notified.switchedEmails;
  summary.seatAlerts = notified.seatAlerts;

  return summary;
}
