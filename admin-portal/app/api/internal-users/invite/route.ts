/**
 * API Route: Add Internal User
 *
 * Handles two cases:
 *   1. An account with this sign-in email exists -> the RPC assigns the role
 *   2. No such account (RPC SQLSTATE P0002) -> create a pending invitation
 *      (role is auto-assigned on first SSO login via /auth/callback)
 *
 * POST /api/internal-users/invite
 * Body: { email: string, role: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  // ── 1. Auth check ──────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 1b. Permission check ──────────────────────────────────────────
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'internal_users.manage',
  });
  if (!hasPerm) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  // ── 2. Parse & validate request body ──────────────────────────────
  let email: string;
  let roleSlug: string;
  try {
    const body = await request.json();
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    roleSlug = typeof body.role === 'string' ? body.role.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!email || !email.includes('@') || email.length > 254) {
    return NextResponse.json({ error: 'Missing or invalid email' }, { status: 400 });
  }
  if (!roleSlug) {
    return NextResponse.json({ error: 'Missing role' }, { status: 400 });
  }

  // ── 3. Validate roleSlug against admin_roles table ────────────────
  const { data: roleRow, error: roleError } = await supabase
    .from('admin_roles')
    .select('id, slug')
    .eq('slug', roleSlug)
    .maybeSingle();

  if (roleError) {
    console.error('[invite-internal-user] admin_roles lookup error:', roleError.message);
    return NextResponse.json({ error: 'Failed to validate role' }, { status: 500 });
  }
  if (!roleRow) {
    return NextResponse.json(
      { error: `Unknown role: "${roleSlug}". Please select a valid role.` },
      { status: 400 }
    );
  }

  // ── 4. Assign the role to the account whose sign-in email matches ──
  // admin_add_internal_user finds the account by its auth.users email
  // (BACKLOG-3998); SQLSTATE P0002 means no account has this email yet.
  const { data, error } = await supabase.rpc('admin_add_internal_user', {
    p_email: email,
    p_role: roleSlug,
  });

  if (!error) {
    const result = data as { success: boolean; user_id: string; role: string } | null;

    // Fire-and-forget: send notification email
    sendInternalInviteNotification(email, roleSlug);

    return NextResponse.json({
      success: true,
      user_id: result?.user_id,
      role: result?.role ?? roleSlug,
    });
  }

  if (error.code !== 'P0002') {
    console.error('[invite-internal-user] RPC error:', error.message);

    if (error.message?.includes('already has') || error.message?.includes('already an internal')) {
      return NextResponse.json(
        { error: `${email} already has an internal role assigned.` },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Failed to assign role' },
      { status: 500 }
    );
  }

  // ── Case B: User not in system → create pending invitation ──────
  // Check if already invited
  const { data: existingInvite } = await supabase
    .from('pending_internal_invitations')
    .select('id, email')
    .eq('email', email)
    .maybeSingle();

  if (existingInvite) {
    return NextResponse.json(
      { error: `${email} already has a pending invitation.` },
      { status: 409 }
    );
  }

  const { error: inviteError } = await supabase
    .from('pending_internal_invitations')
    .insert({
      email,
      role_id: roleRow.id,
      invited_by: user.id,
    });

  if (inviteError) {
    console.error('[invite-internal-user] invitation insert error:', inviteError.message);
    return NextResponse.json(
      { error: 'Failed to create invitation' },
      { status: 500 }
    );
  }

  const roleName = roleRow.slug;

  // Fire-and-forget: send invite email
  sendInternalInviteNotification(email, roleName);

  return NextResponse.json({
    success: true,
    pending: true,
    message: `Invitation created for ${email} as ${roleName}. Role will be assigned on first login.`,
  });
}

// ---------------------------------------------------------------------------
// Email notification helper
// ---------------------------------------------------------------------------

function sendInternalInviteNotification(email: string, roleName: string) {
  const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
  const apiSecret = process.env.INTERNAL_API_SECRET;

  if (!brokerPortalUrl || !apiSecret) {
    console.warn('[invite-internal-user] Email skipped: BROKER_PORTAL_URL or INTERNAL_API_SECRET not configured');
    return;
  }

  const adminPortalUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://admin.keeprcompliance.com';

  fetch(`${brokerPortalUrl}/api/email/internal-invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': apiSecret,
    },
    body: JSON.stringify({
      email,
      roleName,
      loginUrl: adminPortalUrl,
    }),
  }).catch((err) => {
    console.error('[invite-internal-user] Failed to send invite email:', err);
  });
}
