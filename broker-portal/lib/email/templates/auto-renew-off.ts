/**
 * "Auto-renew is off" — BACKLOG-4200 (text approved by the founder, pm_comments on 4200).
 * Sent by the billing outbox (kind notify_auto_renew_off) to the deal's billing contact after Keepr
 * staff turned the brokerage's auto-renew off. Three sentences. No button.
 */

import { buildSimpleNotice } from './simple-notice';
import type { AutoRenewOffParams, EmailContent } from '../types';

export function autoRenewOffSubject(p: Pick<AutoRenewOffParams, 'brokerageName'>): string {
  return `Auto-renew is off for ${p.brokerageName}`;
}

export function autoRenewOffLines(p: Pick<AutoRenewOffParams, 'brokerageName' | 'endsOn'>): string[] {
  return [
    `As you requested, Keepr turned off auto-renew for ${p.brokerageName}.`,
    p.endsOn
      ? `Your plan ends on ${p.endsOn}. Members keep access until then.`
      : 'Your plan ends at the end of the billing period. Members keep access until then.',
    'If you did not ask for this, contact your Keepr account manager.',
  ];
}

export function buildAutoRenewOffEmail(params: AutoRenewOffParams): EmailContent {
  return buildSimpleNotice(autoRenewOffSubject(params), autoRenewOffLines(params));
}
