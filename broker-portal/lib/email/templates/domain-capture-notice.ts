/**
 * Day-0 notice of a domain capture (BACKLOG-3962 PR3a): the brokerage verified the person's email
 * domain, and their personal Keepr account moves into the brokerage 14 days later unless they opt
 * out. The link is tokenless: it opens the portal, where the signed-in person confirms the opt-out.
 *
 * Draft copy, for founder review on the preview.
 */

import { buildSimpleNotice } from './simple-notice';
import type { DomainCaptureNoticeParams, EmailContent } from '../types';

/** "November 24, 2026" (UTC), the day the switch runs. */
export function formatSwitchDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the switch date';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

export function buildDomainCaptureNoticeEmail(params: DomainCaptureNoticeParams): EmailContent {
  const { recipientEmail, brokerageName, domain, switchAt, optOutUrl, payer } = params;
  const date = formatSwitchDate(switchAt);
  const subject = `${brokerageName} will move your Keepr account on ${date}`;
  return buildSimpleNotice(subject, [
    `${brokerageName} verified that it owns ${domain}.`,
    `On ${date}, your Keepr account (${recipientEmail}) moves into ${brokerageName}, and any personal Keepr plan on it ends.`,
    `After the move, ${brokerageName} manages this account and can end your access to it. If you opt out, your account stays separate${payer === true ? ' and stays on your own paid plan' : ''}.`,
    `To opt out, sign in at ${optOutUrl} before ${date}.`,
  ]);
}
