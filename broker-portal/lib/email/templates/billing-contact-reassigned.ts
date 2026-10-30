/**
 * "You are now the billing contact" — BACKLOG-4007 People v2 (founder R9 refinement).
 * Sent by the billing outbox (kind notify_billing_contact_reassigned) after the identity provider
 * removed the brokerage's billing contact and the database made the account admin the contact.
 * Three sentences (founder: <= 3). Layout and button as templates/setup-reminder.ts.
 */

import { baseLayout } from './base-layout';
import type { BillingContactReassignedParams, EmailContent } from '../types';

export const BILLING_CONTACT_BUTTON_LABEL = 'Open People';

export function billingContactReassignedLines(brokerageName: string): string[] {
  return [
    `You are now the billing contact for ${brokerageName}.`,
    'Invoices for the brokerage will be emailed to you.',
    'You can change the billing contact in People under Org Settings.',
  ];
}

export function buildBillingContactReassignedEmail(params: BillingContactReassignedParams): EmailContent {
  const subject = `You are now the billing contact for ${params.brokerageName}`;
  const lines = billingContactReassignedLines(params.brokerageName);
  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  const button = `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeHtml(params.url)}"
               target="_blank"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              ${BILLING_CONTACT_BUTTON_LABEL}
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
      ${lines.map(p).join('\n      ')}
      ${button}
    `,
  });
  const text = [subject, '', ...lines.flatMap((l) => [l, '']), `${BILLING_CONTACT_BUTTON_LABEL}: ${params.url}`].join('\n');
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
