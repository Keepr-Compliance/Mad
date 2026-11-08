/**
 * "Your Keepr account is active again" — BACKLOG-4209, staff reinstatement (text approved by the
 * founder, pm_comments on 4209). Sent by the billing outbox (kind notify_org_reinstated, via
 * 'staff') to the deal's billing contact. The billing line is left out when there is no live
 * Stripe subscription (founder ruling on SR D1). No button.
 */

import { buildSimpleNotice } from './simple-notice';
import { billingLineText } from './billing-line';
import type { EmailContent, OrgReinstatedParams } from '../types';

export function orgReinstatedSubject(p: Pick<OrgReinstatedParams, 'brokerageName'>): string {
  return `Your Keepr account for ${p.brokerageName} is active again`;
}

export function orgReinstatedLines(p: Pick<OrgReinstatedParams, 'brokerageName' | 'billing'>): string[] {
  const billing = billingLineText(p.billing);
  return [
    `As you requested, Keepr reinstated the account for ${p.brokerageName}. Members have full access again.`,
    ...(billing ? [billing] : []),
    'If you did not ask for this, contact your Keepr account manager.',
  ];
}

export function buildOrgReinstatedEmail(params: OrgReinstatedParams): EmailContent {
  return buildSimpleNotice(orgReinstatedSubject(params), orgReinstatedLines(params));
}
