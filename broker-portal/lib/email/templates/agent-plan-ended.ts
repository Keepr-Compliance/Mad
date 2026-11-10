/**
 * "Your Keepr Agent plan has ended" — BACKLOG-3850.
 * Founder copy: Q1 in pm_comments d443fb5b (approved dd904bb8), second version 35b3b3ab.
 * Sent by the billing outbox (kind cancel_agent_on_brokerage_join) to the Agent plan's billing
 * contact once the personal Agent plan was ended because the person joined a brokerage.
 *   - licensed (license_status 'active'): "so your brokerage now covers your account";
 *   - any other status (unassigned): "once {Brokerage} assigns you a license, you can use Keepr
 *     through them".
 * Both keep "won't be charged for it again" and "transactions and credits stay with you", and both
 * end with "If you believe this was a mistake, contact support@keeprcompliance.com."
 * (founder-approved wording, pm_comments cd92edb8), followed by a Contact support button that opens
 * the public ticket form (/support/new, no sign-in needed; the page takes no prefill params).
 * No amounts, card or plan details appear in the email.
 */

import { baseLayout } from './base-layout';
import type { AgentPlanEndedParams, EmailContent } from '../types';

export const AGENT_PLAN_ENDED_SUBJECT = 'Your Keepr Agent plan has ended';
export const CONTACT_SUPPORT_BUTTON_LABEL = 'Contact support';

export function agentPlanEndedLines(p: Pick<AgentPlanEndedParams, 'brokerageName' | 'licensed'>): string[] {
  const joined = p.licensed
    ? `You've joined ${p.brokerageName} on Keepr, so your brokerage now covers your account.`
    : `You've joined ${p.brokerageName} on Keepr. Once ${p.brokerageName} assigns you a license, you can use Keepr through them.`;
  return [
    joined,
    "We've ended your personal Agent plan today, and you won't be charged for it again. Your transactions and credits stay with you.",
    'If you believe this was a mistake, contact support@keeprcompliance.com.',
  ];
}

export function buildAgentPlanEndedEmail(params: AgentPlanEndedParams): EmailContent {
  const subject = AGENT_PLAN_ENDED_SUBJECT;
  const lines = agentPlanEndedLines(params);
  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  // Table-based button, as templates/payment-failed.ts. Opens the public support ticket form.
  const button = `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeHtml(params.supportUrl)}"
               target="_blank"
               data-contact-support="true"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              ${CONTACT_SUPPORT_BUTTON_LABEL}
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
  const text = [subject, '', ...lines.flatMap((l, i) => (i === 0 ? [l] : ['', l])), '', `${CONTACT_SUPPORT_BUTTON_LABEL}: ${params.supportUrl}`].join('\n');
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
