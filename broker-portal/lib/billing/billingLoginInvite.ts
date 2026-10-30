/**
 * The billing-only login's invitation email — BACKLOG-4007 PR-4.
 *
 * The database creates the login (an 'unassigned' invitation linked from the billing contact,
 * `_org_people_invite_row`, BACKLOG-4007 People v2) and returns its token; a row insert sends
 * nothing, so this is the sender. The link is the ordinary /invite/<token> path; accept_invitation keeps an
 * 'unassigned' invitation unassigned. Server only.
 */

import * as Sentry from '@sentry/nextjs';
import { sendInviteEmail } from '@/lib/email';

/** What the database returns for a created login (`billing_login` of the RPC result). */
export interface BillingLoginCreated {
  success: true;
  token: string;
  email: string;
  name?: string | null;
  org_name?: string | null;
}

export function isBillingLoginCreated(x: unknown): x is BillingLoginCreated {
  const o = x as Partial<BillingLoginCreated> | null;
  return !!o && o.success === true && typeof o.token === 'string' && o.token.length > 0 && typeof o.email === 'string';
}

export function billingLoginInviteLink(token: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  return `${baseUrl}/invite/${token}`;
}

/** Sends the invitation. Never throws; returns whether the email went out (or was queued). */
export async function sendBillingLoginInvite(created: BillingLoginCreated, inviterName: string): Promise<boolean> {
  try {
    const firstName = (created.name ?? '').trim().split(/\s+/)[0] || undefined;
    const r = await sendInviteEmail({
      recipientEmail: created.email,
      organizationName: created.org_name || 'your brokerage',
      inviterName,
      role: 'Billing only',
      inviteLink: billingLoginInviteLink(created.token),
      expiresInDays: 7,
      withoutLicense: true,
      billingOnly: true,
      recipientFirstName: firstName,
    });
    return r.success || r.outcome === 'queued';
  } catch (e) {
    Sentry.captureException(e, { tags: { action: 'billing_login_invite' } });
    return false;
  }
}

export { billingLoginErrorMessage } from './billingLoginErrors';
