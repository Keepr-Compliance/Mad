/**
 * Invite Validation API Route
 *
 * Validates an invitation token and returns invite details.
 * Does NOT require authentication — the token itself is the auth.
 *
 * Uses the public_validate_invitation_token RPC (SECURITY DEFINER)
 * to bypass RLS on organization_members, since unauthenticated users
 * clicking invite links have no auth.uid() and all SELECT policies
 * require it. See BACKLOG-1536.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { mapValidInvitation, type ValidateInvitationRpcResult } from '@/lib/invite/validateResult';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ valid: false, error: 'No token provided' });
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc('public_validate_invitation_token', {
    p_token: token,
  });

  if (error) {
    console.error('[invite/validate] RPC error:', error.message);
    return NextResponse.json({ valid: false, error: 'Invitation not found' });
  }

  // The RPC returns JSONB with { valid, error?, email?, org_name?, role?, licensed?, first_name? }
  const result = data as ValidateInvitationRpcResult;

  if (!result.valid) {
    return NextResponse.json({ valid: false, error: result.error });
  }

  return NextResponse.json(mapValidInvitation(result));
}
