/**
 * API Route: Add Internal User
 *
 * One RPC, admin_add_internal_user, handles both cases:
 *   1. An account with this sign-in email exists -> the role is assigned
 *   2. No such account -> the RPC records a pending invitation and returns
 *      {pending: true} (the role is assigned at first sign-in via /auth/callback)
 * A refusal (SQLSTATE 42501) is a 403 with one generic message.
 *
 * POST /api/internal-users/invite
 * Body: { email: string, role: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { NOT_PERMITTED_CODE, NOT_PERMITTED_MESSAGE } from '@/lib/internal-roles';

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

  // ── 4. Assign or invite through the RPC ──────────────────────────
  // admin_add_internal_user (BACKLOG-4168) assigns the role when an account has
  // this sign-in email and otherwise records the invitation itself, returning
  // {success, pending: true}. Every refusal is SQLSTATE 42501 'Not permitted'.
  const { data, error } = await supabase.rpc('admin_add_internal_user', {
    p_email: email,
    p_role: roleSlug,
  });

  if (error) {
    if (error.code === NOT_PERMITTED_CODE) {
      return NextResponse.json({ error: NOT_PERMITTED_MESSAGE }, { status: 403 });
    }
    console.error('[invite-internal-user] RPC error:', error.message);
    return NextResponse.json({ error: 'Failed to add user' }, { status: 500 });
  }

  const result = data as AddInternalUserResult | null;

  // Fire-and-forget: send notification email
  sendInternalInviteNotification(email, roleSlug);

  if (result?.pending === true) {
    return NextResponse.json({
      success: true,
      pending: true,
      outcome: 'invited',
      message: `Invitation created for ${email} as ${roleRow.slug}. Role will be assigned on first login.`,
    });
  }

  return NextResponse.json({
    success: true,
    outcome: 'assigned',
    user_id: result?.user_id,
    role: result?.role ?? roleSlug,
  });
}

/** RETURN shapes of admin_add_internal_user (migration 20261107100000). */
type AddInternalUserResult =
  | { success: true; pending: true; email: string; role: string; user_id?: undefined }
  | { success: true; user_id: string; role: string; pending?: undefined };

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
