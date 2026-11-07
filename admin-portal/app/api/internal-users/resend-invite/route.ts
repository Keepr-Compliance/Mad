/**
 * API Route: Resend Internal User Invite
 *
 * Re-sends the notification email for a pending internal invitation.
 *
 * POST /api/internal-users/resend-invite
 * Body: { invitationId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendInternalInviteNotification } from '@/lib/internal-invite-email';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Permission check
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'internal_users.manage',
  });
  if (!hasPerm) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  // Parse body
  let invitationId: string;
  try {
    const body = await request.json();
    invitationId = typeof body.invitationId === 'string' ? body.invitationId.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!invitationId) {
    return NextResponse.json({ error: 'Missing invitationId' }, { status: 400 });
  }

  // Get the pending invitation
  const { data: invitation, error: lookupError } = await supabase
    .from('pending_internal_invitations')
    .select('id, email, role_id')
    .eq('id', invitationId)
    .maybeSingle();

  if (lookupError) {
    console.error('[resend-invite] Lookup error:', lookupError.message);
    return NextResponse.json({ error: 'Failed to look up invitation' }, { status: 500 });
  }

  if (!invitation) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  // Get the role name for the email
  const { data: role } = await supabase
    .from('admin_roles')
    .select('name, slug')
    .eq('id', invitation.role_id)
    .maybeSingle();

  const roleName = role?.name || role?.slug || 'Team Member';

  // Send the email and wait for the outcome
  const sent = await sendInternalInviteNotification(invitation.email, roleName, 'resend-invite');
  if (!sent) {
    return NextResponse.json({ error: 'Invite email could not be sent' }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
