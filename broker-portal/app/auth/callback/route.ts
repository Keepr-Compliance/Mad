/**
 * OAuth Callback Route
 *
 * Handles the OAuth redirect from Supabase Auth:
 * 1. Exchanges authorization code for session
 * 2. Verifies user has broker/admin/it_admin role
 * 3. JIT-joins users to their existing org (Azure AD by tenant, Google by domain)
 * 4. Redirects to dashboard or login with error
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { extractEmail } from '@/lib/auth/helpers';
import { PORTAL_MEMBERSHIP_SELECT, pickBrokerageMembership } from '@/lib/auth/membership';

// Allowed roles for broker portal access (dashboard)
const PORTAL_ROLES = ['broker', 'admin', 'it_admin'];
// Roles that should be redirected to the desktop app download page
const DESKTOP_ROLES = ['agent'];

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next') ?? '/dashboard';
  const next = /^\/[a-zA-Z0-9\-_/?&=#.]+$/.test(rawNext) ? rawNext : '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error('Auth exchange error:', error);
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }

    // Get authenticated user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      // Check for an existing BROKERAGE membership.
      //
      // BACKLOG-3364: a solo user's own personal organization is not one. Read
      // as a placement it would return /download two lines below — before the
      // pending-invite branch has run — and a solo user could never accept a
      // brokerage invite through the portal again. Skipping it leaves them
      // where they were before personal organizations existed: no membership,
      // so invite linking and JIT both get their turn.
      const { data: memberships } = await supabase
        .from('organization_members')
        .select(PORTAL_MEMBERSHIP_SELECT)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });

      const membership = pickBrokerageMembership(memberships);

      if (membership && DESKTOP_ROLES.includes(membership.role)) {
        // Agent role - redirect to desktop app download
        return NextResponse.redirect(`${origin}/download`);
      }

      if (membership && PORTAL_ROLES.includes(membership.role)) {
        // If IT admin, check if org needs admin consent for desktop app permissions
        if (membership.role === 'it_admin' || membership.role === 'admin') {
          const { data: org } = await supabase
            .from('organizations')
            .select('graph_admin_consent_granted, microsoft_tenant_id')
            .eq('id', membership.organization_id)
            .single();

          if (org && !org.graph_admin_consent_granted && org.microsoft_tenant_id) {
            return NextResponse.redirect(
              `${origin}/setup/consent?tenant=${encodeURIComponent(org.microsoft_tenant_id)}&org=${encodeURIComponent(membership.organization_id)}`
            );
          }
        }

        // User has valid role - redirect to dashboard
        return NextResponse.redirect(`${origin}${next}`);
      }

      // No membership by user_id - check if there's a pending invite for this email
      const userEmail = extractEmail(user);
      if (userEmail) {
        const { data: pendingInvite } = await supabase
          .from('organization_members')
          .select('id, role, organization_id')
          .eq('invited_email', userEmail)
          .is('user_id', null)
          .limit(1)
          .single();

        if (pendingInvite) {
          // Found pending invite - link user to the membership
          if (process.env.NODE_ENV === 'development') {
            console.log(`Linking user to pending invite for ${userEmail}`);
          }

          // First ensure user exists in users table
          const provider = user.app_metadata?.provider || 'email';
          const oauthId = user.user_metadata?.provider_id || user.id;

          const { error: upsertError } = await supabase
            .from('users')
            .upsert({
              id: user.id,
              email: userEmail,
              oauth_provider: provider,
              oauth_id: oauthId,
              display_name: user.user_metadata?.full_name || user.user_metadata?.name || null,
              first_name: user.user_metadata?.given_name || null,
              last_name: user.user_metadata?.family_name || null,
            }, { onConflict: 'id' });

          if (upsertError) {
            console.error('Error creating user record:', upsertError);
          }

          // Update the membership to link user_id and mark as joined
          const { error: updateError } = await supabase
            .from('organization_members')
            .update({
              user_id: user.id,
              license_status: 'active',
              joined_at: new Date().toISOString(),
              invitation_token: null, // Clear the token
            })
            .eq('id', pendingInvite.id);

          if (updateError) {
            console.error('Error linking invite:', updateError);
          } else {
            if (process.env.NODE_ENV === 'development') {
              console.log('Successfully linked invite to user');
            }
            // Redirect agents to download page, portal users to dashboard
            if (DESKTOP_ROLES.includes(pendingInvite.role)) {
              return NextResponse.redirect(`${origin}/download`);
            }
            return NextResponse.redirect(`${origin}${next}`);
          }
        }
      }

      // No membership and no pending invite - check if user can JIT-join an existing org
      // Supports Azure AD (by tenant ID) and Google Workspace (by hosted domain)
      const provider = user.app_metadata?.provider;

      let jitProviderType: string | null = null;
      let jitIdentifier: string | null = null;

      if (provider === 'azure') {
        const customClaims = user.user_metadata?.custom_claims as { tid?: string } | undefined;
        const tenantId = customClaims?.tid;
        if (tenantId) {
          jitProviderType = 'azure_ad';
          jitIdentifier = tenantId;
        }
      } else if (provider === 'google') {
        // Only Google Workspace accounts with a corporate "hd" (hosted domain) claim
        // can JIT-join. Consumer Gmail accounts are excluded:
        //   - No hd claim        -> consumer Gmail (personal @gmail.com)
        //   - hd = gmail.com     -> consumer with domain display
        //   - hd = googlemail.com -> consumer alias domain
        // Only proceed with JIT if hd is present and is a real corporate domain.
        const hd = user.user_metadata?.hd as string | undefined;
        const CONSUMER_GMAIL_DOMAINS = ['gmail.com', 'googlemail.com'];
        const workspaceDomain = hd && !CONSUMER_GMAIL_DOMAINS.includes(hd.toLowerCase())
          ? hd.toLowerCase()
          : undefined;

        if (workspaceDomain) {
          jitProviderType = 'google_workspace';
          jitIdentifier = workspaceDomain;
        }
      }

      if (jitProviderType && jitIdentifier) {
        const { data: jitResult, error: jitError } = await supabase.rpc('jit_join_organization', {
          p_provider_type: jitProviderType,
          p_identifier: jitIdentifier,
        });
        if (jitResult?.success) {
          if (process.env.NODE_ENV === 'development') {
            console.log(`JIT joined org ${jitResult.organization_id} with role ${jitResult.role}`);
          }
          return NextResponse.redirect(`${origin}${next}`);
        }
        if (jitError) {
          console.error('JIT join RPC failed:', jitError);
        }
        // Determine appropriate error for user
        const jitErrorCode = jitResult?.error === 'jit_disabled' ? 'jit_disabled' : 'org_not_setup';
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=${jitErrorCode}`);
      }

      // User not authorized - sign them out
      console.warn('User attempted portal access without valid role');
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=not_authorized`);
    }
  }

  // No code provided or auth failed
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
