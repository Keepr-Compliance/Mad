/**
 * Shared layout for the short billing notices (BACKLOG-4200/4209): a heading that repeats the
 * subject, then one paragraph per line. No button. Same markup as auto-renew-on.ts.
 */

import { baseLayout } from './base-layout';
import type { EmailContent } from '../types';

export function buildSimpleNotice(subject: string, lines: string[]): EmailContent {
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
