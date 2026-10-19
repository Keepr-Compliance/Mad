/**
 * "Account suspended" email to a brokerage's billing contact (BACKLOG-3853 PR-2, founder B4:
 * Keepr sends only "seats added" and "account suspended"; there is no reinstated email).
 * Sent once per suspension by the billing outbox (kind notify_org_suspended).
 */

import { baseLayout } from './base-layout';
import type { AccountSuspendedParams, EmailContent } from '../types';

export function buildAccountSuspendedEmail(params: AccountSuspendedParams): EmailContent {
  const { brokerageName, reason } = params;
  const subject = `Your Keepr account for ${brokerageName} is suspended`;

  const lines =
    reason === 'non_payment'
      ? [
          `Keepr has suspended the account for ${brokerageName} because an invoice is past due.`,
          'While the account is suspended, members cannot use Keepr, buy exports or submit transactions. Your data is kept.',
          'To restore access, pay the overdue invoice from the link in the invoice email from Stripe. Access returns on its own shortly after the payment clears.',
          'If you think this is a mistake, reply to this email or contact your Keepr account manager.',
        ]
      : [
          `Keepr has suspended the account for ${brokerageName}.`,
          'While the account is suspended, members cannot use Keepr, buy exports or submit transactions. Your data is kept.',
          'Please contact your Keepr account manager to restore access.',
        ];

  const html = baseLayout({
    preheader: `The Keepr account for ${brokerageName} is suspended`,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#111827; line-height:1.3;">
        ${escapeHtml(subject)}
      </h1>
      ${lines
        .map(
          (l) =>
            `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`,
        )
        .join('\n      ')}
    `,
  });

  const text = [subject, '', ...lines.flatMap((l) => [l, ''])].join('\n').trimEnd();
  return { subject, html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
