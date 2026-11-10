/**
 * "Payment failed" — BACKLOG-3932 (founder copy, option B, pm_comments 0486b6aa on BACKLOG-3932).
 * Sent by the billing outbox (kind notify_payment_failed) to a brokerage's billing contact one
 * hour after a payment on its invoice failed, unless the invoice was paid or a newer attempt is
 * pending by then. Solo Agent plans get Stripe's own email instead (founder, ec5377e1).
 *
 * The Pay invoice button opens Stripe's hosted invoice page (or the Keepr Billing page when the
 * invoice has none). No card or bank details appear in the email.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, PaymentFailedParams } from '../types';

export const PAY_INVOICE_BUTTON_LABEL = 'Pay invoice';

export function paymentFailedLines(p: Pick<PaymentFailedParams, 'brokerageName' | 'amountLabel'>): string[] {
  const amount = p.amountLabel ? `${p.amountLabel} ` : '';
  return [
    `Your ${amount}payment for ${p.brokerageName}'s Keepr subscription didn't go through.`,
    'Please pay the invoice with the button below, or change your payment method under Manage billing on the Keepr Billing page.',
    'Your members keep their access. Questions? Reply to this email or contact your Keepr account manager.',
  ];
}

export function buildPaymentFailedEmail(params: PaymentFailedParams): EmailContent {
  const subject = `Payment failed for ${params.brokerageName}`;
  const [first, second, third] = paymentFailedLines(params);
  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  // Table-based button, as templates/account-suspended.ts.
  const button = `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(params.payUrl)}"
               target="_blank"
               data-pay-invoice="true"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              ${PAY_INVOICE_BUTTON_LABEL}
            </a>
          </td>
        </tr>
      </table>`;

  const html = baseLayout({
    preheader: subject,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#111827; line-height:1.3;">
        ${escapeHtml(subject)}
      </h1>
      ${p(first)}
      ${p(second)}
      ${button}
      ${p(third)}
    `,
  });
  const text = [subject, '', first, '', second, '', `${PAY_INVOICE_BUTTON_LABEL}: ${params.payUrl}`, '', third].join('\n');
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

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
