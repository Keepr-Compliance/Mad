/**
 * API route for sending organization user invite emails.
 *
 * Called by the admin portal when inviting a user to an organization.
 * Authentication: shared secret via `x-api-secret` header.
 *
 * Follows the same pattern as:
 *  - /api/email/ticket-notification (support ticket emails)
 *  - /api/email/internal-invite (internal user emails)
 *
 * BACKLOG-1535: Proxy invite email through broker portal
 * BACKLOG-1567: Email Delivery Observability (Sentry)
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendInviteEmail } from '@/lib/email';

interface SendInviteRequest {
  recipientEmail: string;
  organizationName: string;
  inviterName: string;
  role: string;
  inviteLink: string;
  expiresInDays: number;
  isResend?: boolean;
  /** BACKLOG-4007 PR-4: the brokerage's billing-only login. */
  billingOnly?: boolean;
}

export async function POST(request: NextRequest) {
  try {
    // Validate shared secret
    const secret = request.headers.get('x-api-secret');
    if (!process.env.INTERNAL_API_SECRET || secret !== process.env.INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: SendInviteRequest = await request.json();

    // Validate required fields
    if (!body.recipientEmail || !body.inviterName || !body.inviteLink) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    Sentry.addBreadcrumb({
      category: 'email.route',
      message: 'Processing send-invite request',
      level: 'info',
      data: { recipientEmail: body.recipientEmail, organizationName: body.organizationName },
    });

    const result = await sendInviteEmail({
      recipientEmail: body.recipientEmail,
      organizationName: body.organizationName || 'Keepr',
      inviterName: body.inviterName,
      role: body.role || 'Member',
      inviteLink: body.inviteLink,
      expiresInDays: body.expiresInDays || 7,
      isResend: body.isResend ?? false,
      billingOnly: body.billingOnly === true,
      withoutLicense: body.billingOnly === true,
    });

    if (!result.success) {
      Sentry.captureMessage(`Invite email failed for ${body.recipientEmail}`, {
        level: 'warning',
        extra: { error: result.error, organizationName: body.organizationName },
      });
    }

    return NextResponse.json({ success: result.success, error: result.error });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'email/send-invite' } });
    console.error('[SendInvite] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
