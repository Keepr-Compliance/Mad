/**
 * Seat-limit email: Microsoft Entra provisioning (SCIM) tried to add or re-activate a
 * person in a brokerage whose licenses are all in use, and Keepr refused it.
 * Sent to the brokerage's IT admins (fallback: admins, then brokers) at most once a day
 * per brokerage. BACKLOG-3851 PR-2c.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, SeatLimitReachedParams } from '../types';

export function buildSeatLimitReachedEmail(params: SeatLimitReachedParams): EmailContent {
  const { personLabel, brokerageName, used, maxSeats, kind } = params;
  const verb = kind === 'reactivate' ? 're-activate' : 'add';
  const counts = maxSeats !== null ? ` (${used} of ${maxSeats})` : '';

  const subject =
    kind === 'reactivate'
      ? 'A person from your directory could not be re-activated in Keepr'
      : 'A person from your directory could not be added to Keepr';

  const lines = [
    `Your Microsoft Entra provisioning tried to ${verb} ${personLabel} in ${brokerageName} on Keepr, but every license is in use${counts}. Keepr did not ${verb} them.`,
    'Entra will try again on its own schedule.',
    'To make room, ask a Broker or Admin to free a license on the Users page in Keepr, or contact Keepr support to add seats.',
    'Others may be waiting too: you get at most one of these emails a day while every license is in use.',
  ];

  const html = baseLayout({
    preheader: `Every Keepr license in ${brokerageName} is in use`,
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
