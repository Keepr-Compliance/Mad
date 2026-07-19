/**
 * API route for sending individual (no-org) download-invite emails.
 *
 * Called by the admin portal when an admin invites an INDIVIDUAL user (no
 * organization). Instead of the old dead individual_invitations token link,
 * this sends a branded "Get Keepr" download email pointing at the canonical
 * download page; the invitee signs in with their email and a 14-day trial is
 * provisioned automatically on first sign-in (create_trial_license).
 *
 * Authentication: shared secret via `x-api-secret` header (same pattern as
 * /api/email/send-invite and the ticket-notification routes).
 *
 * BACKLOG-1914: Replace dead individual-invite path with download-CTA email.
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendDownloadInviteEmail } from '@/lib/email';

interface SendDownloadInviteRequest {
  recipientEmail: string;
  /** Optional override for the canonical download page. */
  downloadUrl?: string;
}

export async function POST(request: NextRequest) {
  try {
    // Validate shared secret
    const secret = request.headers.get('x-api-secret');
    if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: SendDownloadInviteRequest = await request.json();

    // Validate required fields
    if (!body.recipientEmail) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    Sentry.addBreadcrumb({
      category: 'email.route',
      message: 'Processing send-download-invite request',
      level: 'info',
      data: { recipientEmail: body.recipientEmail },
    });

    const result = await sendDownloadInviteEmail({
      recipientEmail: body.recipientEmail,
      downloadUrl: body.downloadUrl,
    });

    if (!result.success) {
      Sentry.captureMessage(`Download-invite email failed for ${body.recipientEmail}`, {
        level: 'warning',
        extra: { error: result.error },
      });
    }

    return NextResponse.json({ success: result.success, error: result.error });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'email/send-download-invite' } });
    console.error('[SendDownloadInvite] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
