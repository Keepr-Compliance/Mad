/**
 * Invite email template.
 *
 * Sent when an admin invites a new user to join their organisation on Keepr.
 * Includes organisation name, inviter name, role, CTA button, and expiry notice.
 *
 * TASK-2197: Email Service Infrastructure
 */

import { baseLayout } from './base-layout';
import type { EmailContent, InviteEmailParams } from '../types';
import { BILLING_ONLY_INVITE_LINE, UNLICENSED_INVITE_LINE } from '@/lib/invite/validateResult';

/**
 * Build the invite email content (subject, HTML, plain text).
 *
 * Pure function -- no side effects, no async.
 */
export function buildInviteEmail(params: InviteEmailParams): EmailContent {
  const {
    organizationName,
    inviterName,
    role,
    inviteLink,
    expiresInDays,
    isResend = false,
    withoutLicense = false,
    billingOnly = false,
    recipientFirstName,
  } = params;

  // BACKLOG-3851 PR-2f
  const firstName = recipientFirstName?.trim() || '';
  const greeting = firstName ? `Hi ${firstName},` : '';
  // BACKLOG-4007 PR-4: a billing-only login says what it opens, not "until your admin assigns one".
  const unlicensedLine = billingOnly ? BILLING_ONLY_INVITE_LINE : withoutLicense ? UNLICENSED_INVITE_LINE : '';

  const isOrgInvite = organizationName && organizationName !== 'Keepr';

  let subject: string;
  if (isResend) {
    subject = isOrgInvite
      ? `Reminder: Your invitation to join ${organizationName} expires in ${expiresInDays} day${expiresInDays !== 1 ? 's' : ''}`
      : `Reminder: Your invitation to join Keepr expires in ${expiresInDays} day${expiresInDays !== 1 ? 's' : ''}`;
  } else {
    subject = isOrgInvite
      ? `You've been invited to join ${organizationName} on Keepr`
      : `You've been invited to join Keepr`;
  }

  const heading = isResend ? 'Invitation Reminder' : "You're Invited!";

  const html = baseLayout({
    preheader: subject,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:24px; font-weight:700; color:#111827; line-height:1.3;">
        ${heading}
      </h1>
      ${greeting ? `<p style="margin:0 0 8px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(greeting)}</p>` : ''}
      <p style="margin:0 0 8px 0; font-size:16px; color:#374151; line-height:1.6;">
        ${isOrgInvite
          ? `${escapeHtml(inviterName)} has invited you to join <strong>${escapeHtml(organizationName)}</strong> on Keepr.`
          : `${escapeHtml(inviterName)} has invited you to join <strong>Keepr</strong> — the real estate transaction auditing platform.`
        }
      </p>
      ${isOrgInvite && role ? `
      <p style="margin:0 0 24px 0; font-size:14px; color:#6b7280; line-height:1.5;">
        Role: <strong>${escapeHtml(role)}</strong>
      </p>` : '<div style="margin:0 0 24px 0;"></div>'}
      ${unlicensedLine ? `
      <p style="margin:0 0 24px 0; font-size:14px; color:#374151; line-height:1.5;">
        ${escapeHtml(unlicensedLine)}
      </p>` : ''}
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(inviteLink)}"
               target="_blank"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              Accept Invitation
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px 0; font-size:14px; color:#6b7280; line-height:1.5;">
        This invitation expires in ${expiresInDays} day${expiresInDays !== 1 ? 's' : ''}.
      </p>
      <p style="margin:0; font-size:13px; color:#9ca3af; line-height:1.5;">
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    `,
  });

  const textLines = [
    subject,
    '',
    ...(greeting ? [greeting, ''] : []),
    isOrgInvite
      ? `${inviterName} has invited you to join ${organizationName} on Keepr.`
      : `${inviterName} has invited you to join Keepr — the real estate transaction auditing platform.`,
  ];
  if (isOrgInvite && role) {
    textLines.push(`Role: ${role}`);
  }
  if (unlicensedLine) {
    textLines.push('', unlicensedLine);
  }
  textLines.push(
    '',
    `Accept your invitation: ${inviteLink}`,
    '',
    `This invitation expires in ${expiresInDays} day${expiresInDays !== 1 ? 's' : ''}.`,
    '',
    'If you didn\'t expect this invitation, you can safely ignore this email.',
  );
  const text = textLines.join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string | null | undefined): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str: string | null | undefined): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
