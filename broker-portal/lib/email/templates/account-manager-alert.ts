/**
 * Internal alert to a brokerage's Keepr account manager (BACKLOG-3853 PR-2). One template;
 * the reason is in the subject. Overdue never suspends: the account manager decides.
 * Stripe's own reminders go to the customer; this one goes to Keepr staff only.
 */

import { baseLayout } from './base-layout';
import type { AccountManagerAlertParams, AccountManagerAlertReason, EmailContent } from '../types';

const REASON_TEXT: Record<AccountManagerAlertReason, { subject: string; line: string }> = {
  overdue: {
    subject: 'invoice past due',
    line: 'An invoice is past its due date and unpaid. The account is NOT suspended; suspend it from the admin portal if you decide to.',
  },
  payment_failed: {
    subject: 'payment failed',
    line: 'A payment on an invoice failed. Stripe keeps the invoice open; the customer can pay it again from the invoice link.',
  },
  refund: {
    subject: 'payment refunded',
    line: 'A payment on an invoice was refunded. Check that this was intended.',
  },
  dispute: {
    subject: 'payment disputed',
    line: 'The customer disputed a payment on an invoice. Respond to the dispute in Stripe. The account is NOT suspended.',
  },
  setup_not_completed: {
    subject: 'setup not finished',
    line: 'The broker has not finished the Billing step 7 days after the invitation. Billing has not started. Follow up with them.',
  },
  setup_no_recipient: {
    subject: 'setup reminder not sent',
    line: 'A setup reminder had nobody to go to: the invitation was removed or has expired. Send a new invitation from the organization page.',
  },
  price_question: {
    subject: 'question about the price',
    line: 'The broker has a question about the price shown in billing setup. Contact them before they confirm.',
  },
  billing_contact_removed: {
    subject: 'no billing contact',
    line: 'The billing contact was removed by the identity provider and the brokerage has no active admin to take over. Set a new billing contact in People.',
  },
};

export function buildAccountManagerAlertEmail(params: AccountManagerAlertParams): EmailContent {
  const r = REASON_TEXT[params.reason];
  const subject = `Keepr billing: ${params.brokerageName} - ${r.subject}`;
  const lines = [
    r.line,
    `Brokerage: ${params.brokerageName}`,
    ...(params.stripeObjectId ? [`Stripe reference: ${params.stripeObjectId}`] : []),
    ...(params.detail ? [params.detail] : []),
  ];

  const html = baseLayout({
    preheader: subject,
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
