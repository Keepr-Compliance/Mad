/**
 * Pure helpers for the inviteUser server action (BACKLOG-1914).
 *
 * Extracted so they can be unit-tested (admin-portal vitest runs *.test.ts,
 * not the server action itself, which needs Supabase + Next server mocks).
 *
 * BACKLOG-1914: the individual (no-org) path no longer writes an
 * `individual_invitations` row (that token link was dead on arrival). Instead:
 *   - ORG invites (organizationId set)     → admin_invite_user RPC + /invite link.
 *   - INDIVIDUAL invites (no organization)  → branded "Get Keepr" download email;
 *                                             the invitee signs in on desktop and
 *                                             a trial is provisioned automatically.
 */

/** Canonical Keepr download / landing page (mirrors the email template default). */
export const DEFAULT_DOWNLOAD_URL = 'https://keeprcompliance.com';

/** Basic email format validation. */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export type InviteFlow = 'org' | 'download';

/**
 * Decide which invite flow applies. An organization id routes to the org RPC
 * path; its absence routes to the individual download-invite email.
 */
export function resolveInviteFlow(organizationId: string | null | undefined): InviteFlow {
  return organizationId ? 'org' : 'download';
}

export interface DownloadInvitePayload {
  recipientEmail: string;
  downloadUrl: string;
}

/**
 * Shape the payload sent to the broker-portal /api/email/send-download-invite
 * route for an individual invitee. Normalises the email and resolves the
 * canonical download URL.
 */
export function buildDownloadInvitePayload(
  email: string,
  downloadUrl?: string | null,
): DownloadInvitePayload {
  return {
    recipientEmail: email.toLowerCase().trim(),
    downloadUrl: downloadUrl?.trim() || DEFAULT_DOWNLOAD_URL,
  };
}
