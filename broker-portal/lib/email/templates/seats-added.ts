/**
 * "Seats added" — BACKLOG-3854 (founder d0c22cef #2). Sent by the billing outbox (kind
 * notify_seats_added) to the deal's billing contact after a Broker or Admin added seats on the
 * Billing page. Three sentences (founder: <= 3). No button. Layout as billing-contact-reassigned.ts.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, SeatsAddedParams } from '../types';

export function seatsAddedLines(p: Pick<SeatsAddedParams, 'brokerageName' | 'seatsFrom' | 'seatsTo' | 'trialing' | 'addedBy'>): string[] {
  return [
    `${p.addedBy} added seats for ${p.brokerageName}: ${p.seatsFrom} to ${p.seatsTo}.`,
    p.trialing
      ? 'The new seats are billed from the end of your trial.'
      : 'A prorated charge for the rest of this billing period will appear on your next invoice.',
    'Contact your Keepr account manager with any questions.',
  ];
}

export function buildSeatsAddedEmail(params: SeatsAddedParams): EmailContent {
  const subject = `Seats added for ${params.brokerageName}`;
  const lines = seatsAddedLines(params);
  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  const html = baseLayout({
    preheader: subject,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#111827; line-height:1.3;">
        ${escapeHtml(subject)}
      </h1>
      ${lines.map(p).join('\n      ')}
    `,
  });
  const text = [subject, '', ...lines.flatMap((l) => [l, ''])].join('\n');
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
