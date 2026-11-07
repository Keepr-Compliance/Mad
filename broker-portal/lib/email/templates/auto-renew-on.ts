/**
 * "Auto-renew is back on" — BACKLOG-4045 (text approved by the founder, pm_comments on 4045).
 * Sent by the billing outbox (kind notify_auto_renew_on) to the deal's billing contact after Keepr
 * staff turned the brokerage's auto-renew back on. Three sentences. No button. Layout as seats-added.ts.
 */

import { baseLayout } from './base-layout';
import type { AutoRenewOnParams, EmailContent } from '../types';

export function autoRenewOnSubject(p: Pick<AutoRenewOnParams, 'brokerageName'>): string {
  return `Auto-renew is back on for ${p.brokerageName}`;
}

export function autoRenewOnLines(p: Pick<AutoRenewOnParams, 'brokerageName'>): string[] {
  return [
    `Keepr turned auto-renew back on for ${p.brokerageName}.`,
    'Your plan renews each month and is billed as before.',
    'If you did not ask for this, contact your Keepr account manager.',
  ];
}

export function buildAutoRenewOnEmail(params: AutoRenewOnParams): EmailContent {
  const subject = autoRenewOnSubject(params);
  const lines = autoRenewOnLines(params);
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
