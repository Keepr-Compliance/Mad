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
import { sendInviteEmail } from '@/lib/email';

// ============================================================================
// Types
// ============================================================================

interface InviteUserInput {
  email: string;
  role: 'agent' | 'broker' | 'admin';
  organizationId: string;
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
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Basic email format validation
 */
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

  const { data: membership } = await supabase
    .from('organization_members')
    .select('role, organization_id')
    .eq('user_id', user.id)
    .eq('organization_id', input.organizationId)
    .maybeSingle();

  if (!membership || !['admin', 'it_admin'].includes(membership.role)) {
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

  // Check organization seat limits (optional - get org info)
  const { data: organization } = await supabase
    .from('organizations')
    .select('name, max_seats')
    .eq('id', input.organizationId)
    .maybeSingle();

  if (organization?.max_seats) {
    // Count current members (active + pending)
    const { count: memberCount } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', input.organizationId)
      .in('license_status', ['active', 'pending']);

    if (memberCount && memberCount >= organization.max_seats) {
      return { success: false, error: 'Organization has reached maximum seats' };
    }
  }

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
      license_status: 'pending',
      invitation_token: invitationToken,
      invitation_expires_at: expiresAt.toISOString(),
      invited_by: user.id,
      invited_at: new Date().toISOString(),
      provisioned_by: 'invite',
    });

  if (insertError) {
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
