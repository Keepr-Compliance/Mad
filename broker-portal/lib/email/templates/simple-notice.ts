/**
 * Shared layout for the short billing notices (BACKLOG-4200/4209): a heading that repeats the
 * subject, then one paragraph per line. Same markup as auto-renew-on.ts. Optional link buttons
 * (BACKLOG-3962) use the table-based button of account-suspended.ts; the text part lists each
 * button as "label: url".
 */

import { baseLayout } from './base-layout';
import type { EmailContent } from '../types';

export interface NoticeButton {
  label: string;
  url: string;
}

export function buildSimpleNotice(subject: string, lines: string[], buttons: readonly NoticeButton[] = []): EmailContent {
  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  const button = (b: NoticeButton, i: number) => {
    const bg = i === 0 ? '#4f46e5' : '#6b7280';
    return `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:${bg};">
            <a href="${escapeHtml(b.url)}"
               target="_blank"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:${bg};">
              ${escapeHtml(b.label)}
            </a>
          </td>
        </tr>
      </table>`;
  };
  // One button renders exactly as before. Several share ONE table row (a <td> per button, a small
  // gap between them) so they sit side by side; inline styles only, since Outlook and Gmail
  // ignore flexbox. They may wrap when the screen is narrow.
  const buttonsHtml =
    buttons.length > 1
      ? `<table cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${buttons.map((b, i) => `<td style="padding-right:${i < buttons.length - 1 ? 12 : 0}px;">${button(b, i)}</td>`).join('\n          ')}
        </tr>
      </table>`
      : buttons.map(button).join('\n      ');
  const html = baseLayout({
    preheader: subject,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#111827; line-height:1.3;">
        ${escapeHtml(subject)}
      </h1>
      ${lines.map(p).join('\n      ')}
      ${buttonsHtml}
    `,
  });
  const text = [subject, '', ...lines.flatMap((l) => [l, '']), ...buttons.flatMap((b) => [`${b.label}: ${b.url}`, ''])].join('\n');
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
