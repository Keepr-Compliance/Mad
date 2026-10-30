/**
 * "Finish your Keepr setup" reminder to a brokerage's broker/admin — BACKLOG-4007 PR-3.
 * Sent by the billing outbox (kind notify_setup_reminder) 3 and 7 days after the invite while the
 * brokerage's deal still waits for the Billing step. Two variants, chosen at send time:
 *   - finish: the broker/admin has an account; the button opens the setup guide.
 *   - accept: nobody has accepted the invitation yet; the button opens the invitation link.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, SetupReminderParams } from '../types';

export const FINISH_BUTTON_LABEL = 'Finish setup';
export const ACCEPT_BUTTON_LABEL = 'Accept invitation';

export function buildSetupReminderEmail(params: SetupReminderParams): EmailContent {
  const { brokerageName } = params;
  const finish = params.variant === 'finish';
  const subject = finish
    ? `Finish setting up Keepr for ${brokerageName}`
    : `Your Keepr invitation for ${brokerageName}`;
  const lines = finish
    ? [
        `Your Keepr account for ${brokerageName} is almost ready.`,
        'Confirm the billing details to finish setup. You can invite your team once it is done.',
      ]
    : [
        `You were invited to set up Keepr for ${brokerageName}.`,
        'Accept the invitation to create your account, then confirm the billing details.',
      ];
  const label = finish ? FINISH_BUTTON_LABEL : ACCEPT_BUTTON_LABEL;
  const after = 'Questions? Reply to this email or contact your Keepr account manager.';

  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  // Table-based button, as templates/invite.ts.
  const button = `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(params.url)}"
               target="_blank"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              ${label}
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
      ${p(after)}
    `,
  });
  const text = [subject, '', ...lines.flatMap((l) => [l, '']), `${label}: ${params.url}`, '', after].join('\n');
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
  return escapeHtml(str);
}
