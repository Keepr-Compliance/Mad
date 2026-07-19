'use server';

/**
 * Invite User Server Action - Admin Portal
 *
 * Two supported flows (BACKLOG-1914):
 *
 *   1. ORG invite (organizationId set) — uses the admin_invite_user RPC
 *      (SECURITY DEFINER) to bypass RLS on organization_members, then emails a
 *      branded /invite/{token} acceptance link. This path is unchanged and works
 *      end-to-end.
 *
 *   2. INDIVIDUAL invite (no organization) — sends a branded "Get Keepr"
 *      download email pointing at the canonical download page. The invitee
 *      downloads Keepr, signs in with their email, and a 14-day trial is
 *      provisioned automatically on first sign-in (create_trial_license).
 *
 *      The old individual path wrote an `individual_invitations` row whose token
 *      the acceptance side never resolved (0/8 organic accepts — dead on
 *      arrival). BACKLOG-1914 removes that path: no orphan rows are created, and
 *      the RPC hard-errors if called with a null organization id.
 *
 * Auth: has_internal_role + has_permission(user_id, 'users.edit') — enforced in RPC.
 *
 * BACKLOG-1492: Admin invite users
 * BACKLOG-1534: Fix RLS-blocked INSERT via SECURITY DEFINER RPC
 * BACKLOG-1914: Remove dead individual-invite path; download-CTA email instead
 */

import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { isValidEmail, resolveInviteFlow, buildDownloadInvitePayload } from './inviteUser.helpers';

// ============================================================================
// Types
// ============================================================================

interface InviteUserInput {
  email: string;
  firstName: string;
  lastName: string;
  role: 'agent' | 'broker' | 'admin';
  organizationId: string | null;
  licenseStatus?: 'trial' | 'active';
  planId?: string | null;
}

interface InviteUserResult {
  success: boolean;
  /** Present for ORG invites only (the /invite/{token} acceptance link). */
  inviteLink?: string;
  emailSent?: boolean;
  error?: string;
  existingOrgId?: string | null;
  existingOrgName?: string | null;
  /** 'org' | 'download' — which flow ran (download = individual, no link). */
  flow?: 'org' | 'download';
}

// ============================================================================
// Error Mapping
// ============================================================================

/** Map RPC error codes to user-friendly messages */
const RPC_ERROR_MAP: Record<string, string> = {
  not_authenticated: 'Not authenticated',
  not_internal_user: 'Not authorized to invite users',
  insufficient_permissions: 'Not authorized to invite users',
  invalid_email: 'Invalid email format',
  invalid_role: 'Invalid role',
  duplicate_invitation: 'This email already has a pending invitation',
  already_member: 'This user is already a member of the organization',
  organization_not_found: 'Organization not found',
  seat_limit_reached: 'Organization has reached maximum seats',
  invalid_license_status: 'Invalid license status (must be trial or active)',
  organization_required: 'An organization is required for org invites',
};

// ============================================================================
// Main Action
// ============================================================================

/**
 * Create an invitation for a new user.
 *
 * - With an organizationId → org member invite via admin_invite_user RPC.
 * - Without one → individual download-invite email (no RPC, no orphan row).
 *
 * @param input - Email, name, role, and organization ID
 * @returns Result with invite link (org) or email status (download) or error
 */
export async function inviteUser(input: InviteUserInput): Promise<InviteUserResult> {
  const supabase = await createClient();

  // --- Client-side input validation (fast-fail before RPC) ---

  if (!input.email?.trim()) {
    return { success: false, error: 'Email is required' };
  }
  if (!input.firstName?.trim()) {
    return { success: false, error: 'First name is required' };
  }
  if (!input.lastName?.trim()) {
    return { success: false, error: 'Last name is required' };
  }
  if (!isValidEmail(input.email)) {
    return { success: false, error: 'Invalid email format' };
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // Branch: org invite (RPC + link) vs individual download invite (email only).
  if (resolveInviteFlow(input.organizationId) === 'download') {
    return sendIndividualDownloadInvite(input.email);
  }

  return sendOrgInvite(supabase, input, user);
}

// ============================================================================
// ORG invite (unchanged acceptance path — organization_members + /invite link)
// ============================================================================

async function sendOrgInvite(
  supabase: Awaited<ReturnType<typeof createClient>>,
  input: InviteUserInput,
  user: { id: string; email?: string; user_metadata?: Record<string, string> },
): Promise<InviteUserResult> {
  // --- Call the SECURITY DEFINER RPC ---
  // The RPC handles: auth, permission check, duplicate detection,
  // seat limits, token generation, and the INSERT (bypassing RLS).
  const { data: rpcResult, error: rpcError } = await supabase.rpc('admin_invite_user', {
    p_organization_id: input.organizationId,
    p_email: input.email,
    p_role: input.role,
    p_invited_by: user.id,
    p_license_status: input.licenseStatus || 'trial',
    p_plan_id: input.planId || null,
  });

  if (rpcError) {
    Sentry.captureException(rpcError, {
      tags: { action: 'invite_user' },
      extra: { email: input.email, organizationId: input.organizationId },
    });
    return { success: false, error: 'Failed to create invitation' };
  }

  // The RPC returns JSONB: { success, error?, invitation_token?, org_name? }
  if (!rpcResult?.success) {
    const errorCode = rpcResult?.error as string;
    const friendlyMessage = RPC_ERROR_MAP[errorCode] || 'Failed to create invitation';
    return {
      success: false,
      error: friendlyMessage,
      existingOrgId: (rpcResult?.existing_org_id as string | null) ?? undefined,
      existingOrgName: (rpcResult?.existing_org_name as string | null) ?? undefined,
      flow: 'org',
    };
  }

  const invitationToken = rpcResult.invitation_token as string;
  const orgName = (rpcResult.org_name as string) || null;

  // --- Generate invite link ---
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  const inviteLink = `${baseUrl}/invite/${invitationToken}`;

  // --- Send invite email via broker portal proxy (non-blocking) ---
  // The broker portal owns the Azure Graph email service; we proxy through it
  // using the shared INTERNAL_API_SECRET, same pattern as support ticket emails.
  // BACKLOG-1535: Proxy invite email through broker portal
  let emailSent = false;
  try {
    const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
    const apiSecret = process.env.INTERNAL_API_SECRET;

    if (!brokerPortalUrl || !apiSecret) {
      console.warn(
        '[inviteUser] Email skipped: missing env vars --',
        `BROKER_PORTAL_URL=${brokerPortalUrl ? 'set' : 'MISSING'}`,
        `INTERNAL_API_SECRET=${apiSecret ? 'set' : 'MISSING'}`
      );
    } else {
      // Use the admin's name (from auth metadata), not the invited user's name
      const inviterName = [user.user_metadata?.first_name, user.user_metadata?.last_name]
        .filter(Boolean).join(' ') || user.email || 'Keepr Support';

      const response = await fetch(`${brokerPortalUrl}/api/email/send-invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-secret': apiSecret,
        },
        body: JSON.stringify({
          recipientEmail: input.email.toLowerCase().trim(),
          organizationName: orgName ?? 'Keepr',
          inviterName,
          role: input.role,
          inviteLink,
          expiresInDays: 7,
        }),
      });

      const result = await response.json();
      emailSent = result.success === true;

      if (!emailSent) {
        Sentry.captureMessage('Failed to send invite email via broker portal', {
          level: 'warning',
          extra: { error: result.error, recipientEmail: input.email },
        });
      }
    }
  } catch (emailError) {
    Sentry.captureException(emailError, {
      tags: { action: 'invite_user_email' },
      extra: { recipientEmail: input.email },
    });
  }

  return {
    success: true,
    inviteLink,
    emailSent,
    flow: 'org',
  };
}

// ============================================================================
// INDIVIDUAL invite → branded "Get Keepr" download email (BACKLOG-1914)
// ============================================================================

async function sendIndividualDownloadInvite(email: string): Promise<InviteUserResult> {
  const payload = buildDownloadInvitePayload(email);
  let emailSent = false;

  try {
    const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
    const apiSecret = process.env.INTERNAL_API_SECRET;

    if (!brokerPortalUrl || !apiSecret) {
      console.warn(
        '[inviteUser] Download-invite email skipped: missing env vars --',
        `BROKER_PORTAL_URL=${brokerPortalUrl ? 'set' : 'MISSING'}`,
        `INTERNAL_API_SECRET=${apiSecret ? 'set' : 'MISSING'}`
      );
      return { success: false, error: 'Email service is not configured', flow: 'download' };
    }

    const response = await fetch(`${brokerPortalUrl}/api/email/send-download-invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': apiSecret,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    emailSent = result.success === true;

    if (!emailSent) {
      Sentry.captureMessage('Failed to send download-invite email via broker portal', {
        level: 'warning',
        extra: { error: result.error, recipientEmail: payload.recipientEmail },
      });
      return { success: false, error: 'Failed to send invitation email', flow: 'download' };
    }
  } catch (emailError) {
    Sentry.captureException(emailError, {
      tags: { action: 'invite_download_email' },
      extra: { recipientEmail: payload.recipientEmail },
    });
    return { success: false, error: 'Failed to send invitation email', flow: 'download' };
  }

  return { success: true, emailSent, flow: 'download' };
}
