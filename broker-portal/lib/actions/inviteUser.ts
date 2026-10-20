'use server';

/**
 * Invite User Server Action
 *
 * Handles creating invitation records for new organization members.
 * Validates email, checks for duplicates, and generates secure tokens.
 *
 * TASK-1810: Invite user modal and server action
 */

import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { randomBytes } from 'crypto';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { BROKERAGE_SUSPENDED_ERROR, isBrokerageSuspendedError } from '@/lib/auth/orgSuspension';
import { sendInviteEmail } from '@/lib/email';
import { inviteNameTooLong, normalizeInviteName } from '@/lib/users/inviteNames';
import {
  INVITE_WITHOUT_LICENSE_UNAVAILABLE,
  inviteWithoutLicenseAvailable,
} from '@/lib/users/memberLicenseActions';

// ============================================================================
// Types
// ============================================================================

interface InviteUserInput {
  email: string;
  role: 'agent' | 'broker' | 'admin';
  organizationId: string;
  /** BACKLOG-3851 PR-2f (I2): invite as 'unassigned' (no license, holds no seat). */
  withoutLicense?: boolean;
  /** BACKLOG-3851 PR-2f (S1): optional names; trimmed, empty -> null, <= 100 characters. */
  firstName?: string;
  lastName?: string;
}

interface InviteUserResult {
  success: boolean;
  inviteLink?: string;
  emailSent?: boolean;
  /**
   * BACKLOG-2009: delivery outcome for admin visibility.
   *   'sent'    — invite email delivered.
   *   'queued'  — transient send failure; queued for the retry cron (pending).
   *   'skipped' — email service not configured.
   *   'failed'  — permanent send failure.
   */
  emailOutcome?: 'sent' | 'queued' | 'skipped' | 'failed';
  error?: string;
  /** BACKLOG-3851: the organization has no free licence; show the out-of-licenses prompt. */
  outOfSeats?: boolean;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * BACKLOG-3851: the two database refusals that mean "no free licence" on an
 * invite insert. Matched on code AND message: 42501 is also used for other
 * refusals (a malformed row, row-level security), which stay errors.
 *   - insert guard (guard_invite_acceptance): 42501 'Organization has reached maximum seats'
 *   - seat trigger, a race loser under the lock: P0001 'seat_limit_reached'
 */
function isInviteSeatRefusal(error: { code?: string; message?: string }): boolean {
  return (
    (error.code === '42501' && error.message === 'Organization has reached maximum seats') ||
    (error.code === 'P0001' && error.message === 'seat_limit_reached')
  );
}

/**
 * Basic email format validation
 */
/**
 * BACKLOG-3851 PR-2f: an unlicensed insert refused by the insert guard's SHAPE check
 * means the database does not accept unlicensed invitations yet (M4 not applied).
 * Matched on code AND message, and only for an unlicensed insert.
 */
function isUnlicensedInviteUnsupported(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42501' &&
    error.message === 'Only a pending invitation can be added from a client session'
  );
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// ============================================================================
// Main Action
// ============================================================================

/**
 * Create an invitation for a new organization member
 *
 * @param input - Email, role, and organization ID
 * @returns Result with invite link or error
 */
export async function inviteUser(input: InviteUserInput): Promise<InviteUserResult> {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  const supabase = await createClient();

  // Validate email format
  if (!isValidEmail(input.email)) {
    return { success: false, error: 'Invalid email format' };
  }

  // Normalize email
  const normalizedEmail = input.email.toLowerCase().trim();

  const withoutLicense = input.withoutLicense === true;
  if (withoutLicense && !inviteWithoutLicenseAvailable()) {
    return { success: false, error: INVITE_WITHOUT_LICENSE_UNAVAILABLE };
  }

  const firstName = normalizeInviteName(input.firstName);
  const lastName = normalizeInviteName(input.lastName);
  if (inviteNameTooLong(firstName) || inviteNameTooLong(lastName)) {
    return { success: false, error: 'Names must be 100 characters or fewer' };
  }

  // Verify current user is admin/it_admin
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // Check user cannot invite themselves
  const { data: currentUserData } = await supabase
    .from('users')
    .select('email, display_name')
    .eq('id', user.id)
    .maybeSingle();

  if (currentUserData?.email?.toLowerCase() === normalizedEmail) {
    return { success: false, error: 'You cannot invite yourself' };
  }

  // BACKLOG-3917: role, access-granting status and licence, in this organization.
  const membership = await requireActiveOrgRole(supabase, user.id, input.organizationId, ['admin', 'it_admin']);

  if (!membership.ok) {
    return { success: false, error: 'Not authorized to invite users' };
  }

  // Check for pending invitation with this email (separate query - no string interpolation)
  const { data: existingInvite } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', input.organizationId)
    .eq('invited_email', normalizedEmail)
    .maybeSingle();

  if (existingInvite) {
    return { success: false, error: 'This email already has a pending invitation' };
  }

  // Check if a user with this email is already a member (separate queries)
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingUser) {
    const { data: existingMember } = await supabase
      .from('organization_members')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('user_id', existingUser.id)
      .maybeSingle();

    if (existingMember) {
      return { success: false, error: 'This user is already a member of the organization' };
    }
  }

  // Organization name, for the invite email.
  // BACKLOG-3851: no portal seat count here. The database decides, with its own
  // rule (an expired, unclaimed invite holds no seat): the insert guard refuses
  // a full organization, and the seat trigger refuses again under the lock.
  const { data: organization } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', input.organizationId)
    .maybeSingle();

  // Generate secure invitation token
  const invitationToken = randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 day expiry

  // Create invitation record
  const { error: insertError } = await supabase
    .from('organization_members')
    .insert({
      organization_id: input.organizationId,
      invited_email: normalizedEmail,
      role: input.role,
      // BACKLOG-3851 PR-2f: an unlicensed invitation is 'unassigned' and holds no seat.
      license_status: withoutLicense ? 'unassigned' : 'pending',
      invitation_token: invitationToken,
      invitation_expires_at: expiresAt.toISOString(),
      invited_by: user.id,
      invited_at: new Date().toISOString(),
      provisioned_by: 'invite',
      invited_first_name: firstName,
      invited_last_name: lastName,
    });

  if (insertError) {
    if (isInviteSeatRefusal(insertError)) {
      return { success: false, outOfSeats: true };
    }
    if (withoutLicense && isUnlicensedInviteUnsupported(insertError)) {
      return { success: false, error: INVITE_WITHOUT_LICENSE_UNAVAILABLE };
    }
    // BACKLOG-3853 PR-2B: the brokerage is suspended; the member trigger refused.
    if (isBrokerageSuspendedError(insertError)) return { success: false, error: BROKERAGE_SUSPENDED_ERROR };
    Sentry.captureException(insertError, {
      tags: { action: 'invite_user' },
      extra: { email: normalizedEmail, organizationId: input.organizationId },
    });
    return { success: false, error: 'Failed to create invitation' };
  }

  // Generate invite link
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  const inviteLink = `${baseUrl}/invite/${invitationToken}`;

  // Send invite email (non-blocking -- invite is created regardless of email success)
  let emailSent = false;
  let emailOutcome: InviteUserResult['emailOutcome'] = 'failed';
  try {
    const inviterName = currentUserData?.display_name || currentUserData?.email || 'Your administrator';
    const orgName = organization?.name || 'your organization';

    Sentry.addBreadcrumb({
      category: 'email.invite',
      message: 'Sending invite email',
      level: 'info',
      data: { recipientEmail: normalizedEmail, organizationName: orgName },
    });

    const emailResult = await sendInviteEmail({
      recipientEmail: normalizedEmail,
      organizationName: orgName,
      inviterName,
      role: input.role,
      inviteLink,
      expiresInDays: 7,
      withoutLicense,
      recipientFirstName: firstName ?? undefined,
    });

    emailSent = emailResult.success;
    emailOutcome = emailResult.outcome ?? (emailResult.success ? 'sent' : 'failed');
    // BACKLOG-2009: a 'queued' outcome means a transient send failure was
    // persisted to the retry queue and will be delivered by the cron — surface
    // that to the admin as pending rather than a hard failure.
    if (!emailResult.success && emailOutcome !== 'queued') {
      Sentry.captureMessage('Failed to send invite email', {
        level: 'warning',
        extra: { error: emailResult.error, recipientEmail: normalizedEmail, organizationId: input.organizationId },
      });
    }
  } catch (emailError) {
    Sentry.captureException(emailError, {
      tags: { action: 'invite_email' },
      extra: { recipientEmail: normalizedEmail, organizationId: input.organizationId },
    });
  }

  return {
    success: true,
    inviteLink,
    emailSent,
    emailOutcome,
  };
}
