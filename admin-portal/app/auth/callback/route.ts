/**
 * OAuth Callback Route - Admin Portal
 *
 * Handles the OAuth redirect from Supabase Auth:
 * 1. Exchanges authorization code for session
 * 2. Logs authentication events (success/failure) for SOC 2 CC6.2
 * 3. Processes pending internal invitations (auto-assigns role on first login)
 * 4. Verifies user has an internal_roles entry
 * 5. Redirects to dashboard or login with error
 */

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { clearAuthCookies, signOutLocal } from '@/lib/auth/signOutLocal';
import { safeNextPath } from '@/lib/auth/safeNextPath';

/**
 * Log an authentication event to admin_audit_logs.
 * Never blocks the auth flow - failures are caught and logged to console.
 */
async function logAuthEvent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
  request?: Request
) {
  try {
    const ip = request
      ? (request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
        request.headers.get('x-real-ip') ??
        'unknown')
      : null;
    const userAgent = request?.headers.get('user-agent') ?? null;

    await supabase.rpc('log_admin_action', {
      p_action: action,
      p_target_type: targetType,
      p_target_id: targetId,
      p_metadata: metadata,
      p_ip_address: ip,
      p_user_agent: userAgent,
    });
  } catch (err) {
    // Never block auth flow for audit logging failures
    console.error('[auth-callback] Failed to log auth event:', err);
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  // Early return when no code is provided (CodeQL alert #232).
  // Ensures the auth flow is not wrapped inside a user-controlled condition.
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('Auth exchange error:', error);
    // Log failed auth exchange
    await logAuthEvent(supabase, 'auth.login_failed', 'auth', 'unknown', {
      error: error.message,
      source: 'admin_portal',
      stage: 'code_exchange',
    }, request);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Get authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Log successful login
    await logAuthEvent(supabase, 'auth.login', 'user', user.id, {
      email: user.email,
      source: 'admin_portal',
      provider: user.app_metadata?.provider || 'unknown',
    }, request);

    // Process any pending internal invitation for this user
    const oauthProvider = user.app_metadata?.provider ?? 'azure';
    const invitationOutcome = await processPendingInvitation(
      supabase,
      user.id,
      user.email ?? '',
      oauthProvider
    );

    // Check for internal role
    const { data: internalRole } = await supabase
      .from('internal_roles')
      .select('role_id')
      .eq('user_id', user.id)
      .single();

    if (internalRole) {
      // User has internal role - redirect to dashboard
      return NextResponse.redirect(`${origin}${next}`);
    }

    // User does not have an internal role - sign them out and reject
    await logAuthEvent(supabase, 'auth.login_denied', 'user', user.id, {
      email: user.email,
      source: 'admin_portal',
      reason: invitationOutcome === 'refused' ? 'invitation_not_accepted' : 'no_internal_role',
    }, request);
    await signOutLocal(supabase);
    const response = NextResponse.redirect(`${origin}/login?error=not_authorized`);
    clearAuthCookies(request, response);
    return response;
  }

  // Auth succeeded but no user returned
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}

/**
 * Check for a pending invitation and auto-assign the internal role.
 *
 * When an admin invites a user who doesn't have a Keepr account yet,
 * admin_add_internal_user stores the invitation in pending_internal_invitations.
 * On first SSO login, this function picks it up:
 *   1. Ensures public.users record exists
 *   2. Calls admin_accept_internal_invitation (service role only), which
 *      re-checks the inviter, assigns the role and clears the invitation
 *
 * Returns 'refused' when an invitation exists but was not accepted; no role is
 * assigned in that case.
 */
async function processPendingInvitation(
  _supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  email: string,
  provider: string
): Promise<InvitationOutcome> {
  if (!email) return 'none';

  // Use service role client to bypass RLS for auto-provisioning
  const adminClient = createServiceClient();

  try {
    // Check for pending invitation
    const { data: invitation } = await adminClient
      .from('pending_internal_invitations')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (!invitation) return 'none';

    // Ensure public.users record exists
    const { data: existingUser } = await adminClient
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!existingUser) {
      // Create public.users record for this user
      const { error: insertError } = await adminClient.from('users').insert({
        id: userId,
        email: email.toLowerCase(),
        oauth_provider: provider,
        oauth_id: userId,
        status: 'active',
        is_active: true,
      });

      if (insertError) {
        console.error('[auth-callback] Failed to create public.users record:', insertError.message);
        return 'refused';
      }
    }

    // Accept the invitation through the database (BACKLOG-4168). The RPC re-checks
    // that the inviter may still grant the role, assigns it and clears the
    // invitation in one transaction. It needs the public.users row above.
    const { data: accepted, error: acceptError } = await adminClient.rpc(
      'admin_accept_internal_invitation',
      { p_user_id: userId, p_email: email.toLowerCase() }
    );

    if (acceptError) {
      // No role is assigned. The internal_roles check in GET then signs the user out.
      console.error(
        '[auth-callback] Invitation not accepted:',
        acceptError.code ?? 'no-code',
        acceptError.message
      );
      return 'refused';
    }

    const result = accepted as AcceptInvitationResult | null;
    if (result?.assigned === true) {
      console.log(`[auth-callback] Processed invitation: ${email} assigned role ${result.role}`);
      return 'assigned';
    }
    return 'none';
  } catch (err) {
    console.error('[auth-callback] Error processing pending invitation:', err);
    return 'refused';
  }
}

type InvitationOutcome = 'none' | 'assigned' | 'refused';

/** RETURN shapes of admin_accept_internal_invitation (migration 20261107100000). */
type AcceptInvitationResult =
  | { success: true; assigned: false }
  | { success: true; assigned: true; user_id: string; role: string };
