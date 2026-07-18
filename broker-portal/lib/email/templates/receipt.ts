/**
 * Purchase receipt email template (BACKLOG-2009).
 *
 * Sent to the paying customer after a successful Stripe transaction-unlock
 * charge is fulfilled. Confirms the amount, what was purchased, and the Stripe
 * payment reference for their records.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, ReceiptEmailParams } from '../types';

function formatUsd(cents: number): string {
  const dollars = Math.max(0, Math.round(cents)) / 100;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function buildReceiptEmail(params: ReceiptEmailParams): EmailContent {
  const amount = formatUsd(params.amountCents);
  const description = params.description || 'Transaction audit unlock';
  const purchasedAt = formatDate(params.purchasedAt || new Date().toISOString());
  const reference = params.paymentReference;

  const subject = `Your Keepr receipt — ${amount}`;

  const html = baseLayout({
    preheader: `Receipt for your Keepr purchase (${amount})`,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:24px; font-weight:700; color:#111827; line-height:1.3;">
        Thanks for your purchase
      </h1>
      <p style="margin:0 0 8px 0; font-size:16px; color:#374151; line-height:1.6;">
        Your payment was received. Here's a summary for your records.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 24px 0; width:100%;">
        <tr>
          <td style="padding:16px; background-color:#f9fafb; border-radius:6px; border:1px solid #e5e7eb;">
            <p style="margin:0 0 4px 0; font-size:13px; color:#6b7280;">Item</p>
            <p style="margin:0 0 12px 0; font-size:15px; font-weight:600; color:#111827;">${escapeHtml(description)}</p>
            <p style="margin:0 0 4px 0; font-size:13px; color:#6b7280;">Amount</p>
            <p style="margin:0 0 12px 0; font-size:15px; font-weight:600; color:#111827;">${escapeHtml(amount)}</p>
            <p style="margin:0 0 4px 0; font-size:13px; color:#6b7280;">Date</p>
            <p style="margin:0 0 12px 0; font-size:15px; color:#111827;">${escapeHtml(purchasedAt)}</p>
            <p style="margin:0 0 4px 0; font-size:13px; color:#6b7280;">Payment reference</p>
            <p style="margin:0; font-size:13px; color:#111827; font-family:monospace;">${escapeHtml(reference)}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0; font-size:14px; color:#6b7280; line-height:1.5;">
        Questions about this charge? Reply to this email and our team will help.
      </p>
    `,
  });

  const text = [
    `Your Keepr receipt — ${amount}`,
    '',
    'Your payment was received. Here is a summary for your records.',
    '',
    `Item: ${description}`,
    `Amount: ${amount}`,
    `Date: ${purchasedAt}`,
    `Payment reference: ${reference}`,
    '',
    'Questions about this charge? Reply to this email and our team will help.',
  ].join('\n');

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
