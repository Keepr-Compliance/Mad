/**
 * Download-invite email template (BACKLOG-1914).
 *
 * Sent when an admin invites an INDIVIDUAL (no-organization) user to Keepr.
 * Instead of the old, dead `individual_invitations` token link (which the
 * acceptance side never resolved — 0/8 organic accepts), this email points the
 * invitee at the canonical download page. They download Keepr, sign in with
 * their email, and a 14-day trial is provisioned automatically on first
 * sign-in (create_trial_license). No per-invitee token is required.
 *
 * Branding mirrors the existing transactional templates (invite.ts /
 * receipt.ts): the Keepr indigo (#4f46e5) header + CTA, table-based layout,
 * inline CSS only, plain-text fallback.
 */

import { baseLayout } from './base-layout';
import type { EmailContent, DownloadInviteEmailParams } from '../types';

/** Canonical Keepr download / landing page. */
export const DEFAULT_DOWNLOAD_URL = 'https://keeprcompliance.com';

/**
 * Build the download-invite email content (subject, HTML, plain text).
 *
 * Pure function -- no side effects, no async.
 */
export function buildDownloadInviteEmail(
  params: DownloadInviteEmailParams,
): EmailContent {
  const downloadUrl = params.downloadUrl?.trim() || DEFAULT_DOWNLOAD_URL;

  const subject = "You've been invited to Keepr";

  const html = baseLayout({
    preheader: 'Download Keepr and sign in with this email — your trial starts automatically.',
    body: `
      <h1 style="margin:0 0 16px 0; font-size:24px; font-weight:700; color:#111827; line-height:1.3;">
        You've been invited to Keepr
      </h1>
      <p style="margin:0 0 20px 0; font-size:16px; color:#374151; line-height:1.6;">
        Keepr is the desktop app that automatically audits your real estate
        transactions for compliance — no spreadsheets, no manual paperwork chasing.
      </p>
      <p style="margin:0 0 24px 0; font-size:16px; color:#374151; line-height:1.6;">
        Getting started takes about a minute:
      </p>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0; width:100%;">
        <tr>
          <td style="padding:0 0 10px 0; font-size:15px; color:#374151; line-height:1.5;">
            <strong style="color:#4f46e5;">1.</strong>&nbsp; Download Keepr for your computer.
          </td>
        </tr>
        <tr>
          <td style="padding:0 0 10px 0; font-size:15px; color:#374151; line-height:1.5;">
            <strong style="color:#4f46e5;">2.</strong>&nbsp; Sign in with <strong>this email address</strong>.
          </td>
        </tr>
        <tr>
          <td style="padding:0; font-size:15px; color:#374151; line-height:1.5;">
            <strong style="color:#4f46e5;">3.</strong>&nbsp; Your free 14-day trial starts automatically.
          </td>
        </tr>
      </table>
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(downloadUrl)}"
               target="_blank"
               style="display:inline-block; padding:14px 40px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              Get Keepr
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px 0; font-size:13px; color:#6b7280; line-height:1.5;">
        Or copy this link into your browser:<br>
        <a href="${escapeAttr(downloadUrl)}" target="_blank" style="color:#4f46e5; word-break:break-all;">${escapeHtml(downloadUrl)}</a>
      </p>
      <p style="margin:0; font-size:13px; color:#9ca3af; line-height:1.5;">
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    `,
  });

  const text = [
    subject,
    '',
    'Keepr is the desktop app that automatically audits your real estate transactions for compliance.',
    '',
    'Getting started takes about a minute:',
    '  1. Download Keepr for your computer.',
    '  2. Sign in with this email address.',
    '  3. Your free 14-day trial starts automatically.',
    '',
    `Get Keepr: ${downloadUrl}`,
    '',
    "If you didn't expect this invitation, you can safely ignore this email.",
  ].join('\n');

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
