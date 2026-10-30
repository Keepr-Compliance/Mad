/**
 * Last-admin email (BACKLOG-4027, founder decision B): the brokerage's identity provider
 * (SCIM provisioning or directory sync) tried to deactivate or demote the brokerage's last
 * active admin, and Keepr kept them. Sent to Keepr support and the brokerage's IT contact, at
 * most once a day per brokerage, so a new admin is named.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, LastAdminKeptParams } from '../types';

export function buildLastAdminKeptEmail(params: LastAdminKeptParams): EmailContent {
  const { personLabel, brokerageName, kind, source } = params;
  const via = source === 'scim' ? 'provisioning' : 'directory sync';
  const verb = kind === 'deactivate' ? 'deactivate' : 'change the role of';

  const subject = `Keepr kept the last admin of ${brokerageName}`;
  const lines = [
    `Your identity provider's ${via} tried to ${verb} ${personLabel}, the last active admin of ${brokerageName} in Keepr. Keepr kept them as an active admin.`,
    'A brokerage always keeps at least one active admin.',
    'To finish the change, make someone else an admin on the Users page in Keepr, then retry it in your identity provider.',
  ];

  const html = baseLayout({
    preheader: `${brokerageName} needs another admin in Keepr`,
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
