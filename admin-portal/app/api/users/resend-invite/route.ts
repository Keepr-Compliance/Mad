/**
 * API Route: Resend User Invite
 *
 * Re-sends the invitation email for a pending org-member invitation.
 * Regenerates the token + extends expiration by 7 days.
 * Uses service role client to bypass RLS (admin portal users are not org members).
 *
 * POST /api/users/resend-invite
 * Body: { membershipId: string }
 *
 * BACKLOG-1581: Add resend invite button for pending invitations
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Permission check — same as inviteUser server action
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'users.edit',
  });
  if (!hasPerm) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  // Parse body
  let membershipId: string;
  try {
    const body = await request.json();
    membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!membershipId) {
    return NextResponse.json({ error: 'Missing membershipId' }, { status: 400 });
  }

  // Generate new token and expiry
  const newToken = generateToken();
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return handleOrgResend(membershipId, newToken, newExpiry, user);
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function handleOrgResend(
  membershipId: string,
  newToken: string,
  newExpiry: string,
  user: { id: string; email?: string; user_metadata?: Record<string, string> }
) {
  // Use service role client to bypass RLS — admin portal users are not org members
  const adminClient = createServiceClient({ actorId: user.id });

  // Look up the pending invitation
  const { data: membership, error: lookupError } = await adminClient
    .from('organization_members')
    .select('id, invited_email, role, organization_id, user_id')
    .eq('id', membershipId)
    .maybeSingle();

  if (lookupError) {
    console.error('[resend-invite] Org lookup error:', lookupError.message);
    return NextResponse.json({ error: 'Failed to look up invitation' }, { status: 500 });
  }

  if (!membership) {
    console.warn('[resend-invite] Invitation not found:', { membershipId });
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  // Fetch org name separately for the email
  const { data: org } = await adminClient
    .from('organizations')
    .select('name')
    .eq('id', membership.organization_id)
    .maybeSingle();

  // Must be a pending invitation (user_id is null, invited_email is set)
  if (membership.user_id || !membership.invited_email) {
    return NextResponse.json({ error: 'This is not a pending invitation' }, { status: 400 });
  }

  // Update token + expiry (updated_at is managed automatically)
  const { error: updateError } = await adminClient
    .from('organization_members')
    .update({
      invitation_token: newToken,
      invitation_expires_at: newExpiry,
    })
    .eq('id', membershipId);

  if (updateError) {
    console.error('[resend-invite] Org update error:', updateError.message);
    return NextResponse.json({ error: 'Failed to update invitation' }, { status: 500 });
  }

  const orgName = org?.name ?? 'Keepr';

  // Send email
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  const inviteLink = `${baseUrl}/invite/${newToken}`;
  const inviterName = getInviterName(user);

  const emailSent = await sendInviteEmail({
    recipientEmail: membership.invited_email,
    organizationName: orgName,
    inviterName,
    role: membership.role,
    inviteLink,
  });

  return NextResponse.json({ success: true, emailSent });
}

function getInviterName(user: { email?: string; user_metadata?: Record<string, string> }): string {
  return (
    [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(' ') ||
    user.email ||
    'Keepr Support'
  );
}

async function sendInviteEmail(params: {
  recipientEmail: string;
  organizationName: string;
  inviterName: string;
  role: string | null;
  inviteLink: string;
}): Promise<boolean> {
  const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
  const apiSecret = process.env.INTERNAL_API_SECRET;

  if (!brokerPortalUrl || !apiSecret) {
    console.warn('[resend-invite] Email skipped: BROKER_PORTAL_URL or INTERNAL_API_SECRET not configured');
    return false;
  }

  try {
    const response = await fetch(`${brokerPortalUrl}/api/email/send-invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': apiSecret,
      },
      body: JSON.stringify({
        recipientEmail: params.recipientEmail.toLowerCase().trim(),
        organizationName: params.organizationName,
        inviterName: params.inviterName,
        role: params.role,
        isResend: true,
        inviteLink: params.inviteLink,
        expiresInDays: 7,
      }),
    });

    const result = await response.json();
    return result.success === true;
  } catch (err) {
    console.error('[resend-invite] Failed to send invite email:', err);
    return false;
  }
}
