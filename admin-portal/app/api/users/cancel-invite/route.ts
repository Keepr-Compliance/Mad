/**
 * API Route: Cancel User Invite
 *
 * Deletes a pending org-member invitation.
 * Uses service role client to bypass RLS (admin portal users are not org members).
 *
 * POST /api/users/cancel-invite
 * Body: { membershipId: string }
 *
 * BACKLOG-1581: Add resend invite button for pending invitations
 * BACKLOG-4007 People v2: the live billing contact's invitation (a billing-only login not yet
 * claimed) is refused with the founder's sentence. The database cannot tell this service-client
 * delete from a cascade or an IdP removal (both reassign the contact), so the check is here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

/** Founder R9 (BACKLOG-4007): the exact sentence, the same as the Users-page removal. */
const BILLING_CONTACT_CANCEL_REFUSED = 'Pick another billing contact first.';

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

  // Use service role client to bypass RLS — admin portal users are not org members
  const adminClient = createServiceClient({ actorId: user.id });

  // Verify it is actually a pending invitation before deleting
  const { data: membership, error: lookupError } = await adminClient
    .from('organization_members')
    .select('id, user_id, invited_email')
    .eq('id', membershipId)
    .maybeSingle();

  if (lookupError) {
    console.error('[cancel-invite] Lookup error:', lookupError.message);
    return NextResponse.json({ error: 'Failed to look up invitation' }, { status: 500 });
  }

  if (!membership) {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }

  // Only allow cancelling pending invitations (user_id is null)
  if (membership.user_id) {
    return NextResponse.json({ error: 'This is not a pending invitation' }, { status: 400 });
  }

  // BACKLOG-4007 People v2 (PM 6a68d0a2, F3): not the live billing contact's invitation.
  const { data: billingContact, error: contactError } = await adminClient
    .from('org_contacts')
    .select('id')
    .eq('member_id', membershipId)
    .eq('role', 'billing')
    .is('removed_at', null)
    .maybeSingle();

  if (contactError) {
    console.error('[cancel-invite] Contact lookup error:', contactError.message);
    return NextResponse.json({ error: 'Failed to look up invitation' }, { status: 500 });
  }

  if (billingContact) {
    return NextResponse.json({ error: BILLING_CONTACT_CANCEL_REFUSED }, { status: 409 });
  }

  const { error: deleteError } = await adminClient
    .from('organization_members')
    .delete()
    .eq('id', membershipId);

  if (deleteError) {
    console.error('[cancel-invite] Delete error:', deleteError.message);
    return NextResponse.json({ error: 'Failed to cancel invitation' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
