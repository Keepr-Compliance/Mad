/**
 * "Your Keepr account is active again" — BACKLOG-4209, automatic reinstatement after an overdue
 * invoice is paid (text approved by the founder, pm_comments on 4209). Sent by the billing outbox
 * (kind notify_org_reinstated, via 'auto') to the deal's billing contact. Same subject and billing
 * line as the staff email; it does not open "As you requested,". No button.
 */

import { buildSimpleNotice } from './simple-notice';
import { billingLineText } from './billing-line';
import { orgReinstatedSubject } from './org-reinstated';
import type { EmailContent, OrgReinstatedParams } from '../types';

export function orgAutoReinstatedLines(p: Pick<OrgReinstatedParams, 'brokerageName' | 'billing'>): string[] {
  const billing = billingLineText(p.billing);
  return [
    `We received your payment, so Keepr turned the account for ${p.brokerageName} back on automatically. Members have full access again.`,
    ...(billing ? [billing] : []),
    'If you have questions, contact your Keepr account manager.',
  ];
}

export function buildOrgAutoReinstatedEmail(params: OrgReinstatedParams): EmailContent {
  return buildSimpleNotice(orgReinstatedSubject(params), orgAutoReinstatedLines(params));
}
