/**
 * OAuth Callback Route
 *
 * Handles the OAuth redirect from Supabase Auth:
 * 1. Exchanges authorization code for session
 * 2. Routes a brokerage member (full portal or floor) to `next`
 * 3. Links a pending invite
 * 4. JIT-joins users to their existing org (Azure AD by tenant, Google by domain)
 * 5. Admits the OWNER of a personal organization to the floor
 * 6. Otherwise signs this browser out and returns to login with an error
 *
 * BACKLOG-3080: every portal user now lands on `next`; middleware and the
 * dashboard decide what each of them may open. The desktop download page is no
 * longer a destination here.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { extractEmail } from '@/lib/auth/helpers';
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

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
      // BACKLOG-3364: a solo user's own personal organization is not one. It
      // must not decide the destination before the pending-invite branch and
      // JIT have had their turn, or a solo user could never accept a brokerage
      // invite through the portal. The personal-owner check is therefore LAST
      // (BACKLOG-3080), after invite linking and JIT.
      const { data: memberships } = await supabase
        .from('organization_members')
        .select(PORTAL_MEMBERSHIP_SELECT)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });

      const access = classifyPortalAccess(memberships as PortalMembershipRow[] | null, user.id);

      if (access.kind === 'full') {
        // If IT admin, check if org needs admin consent for desktop app permissions
        if (access.role === 'it_admin' || access.role === 'admin') {
          const { data: org } = await supabase
            .from('organizations')
            .select('graph_admin_consent_granted, microsoft_tenant_id')
            .eq('id', access.organizationId)
            .single();

          if (org && !org.graph_admin_consent_granted && org.microsoft_tenant_id) {
            return NextResponse.redirect(
              `${origin}/setup/consent?tenant=${encodeURIComponent(org.microsoft_tenant_id)}&org=${encodeURIComponent(access.organizationId)}`
            );
          }
        }

        // User has valid role - redirect to dashboard
        return NextResponse.redirect(`${origin}${next}`);
      }

      if (access.kind === 'floor' && access.via === 'brokerage') {
        // A brokerage agent (or any non-full role): the portal floor.
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
            // Every linked member lands on `next`; middleware floors an agent.
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

      // A failed JIT join does not sign out yet: the owner of a personal
      // organization still gets the floor below. Its error code is kept for
      // everyone else.
      let jitErrorCode: string | null = null;

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
        jitErrorCode = jitResult?.error === 'jit_disabled' ? 'jit_disabled' : 'org_not_setup';
      }

      // BACKLOG-3080: the owner of a personal organization gets the floor.
      // `floor` here can only come from a personal organization this user
      // OWNS — a brokerage floor returned above. A failed membership read is
      // `unknown`, not `floor`, and is signed out below as before.
      if (access.kind === 'floor') {
        return NextResponse.redirect(`${origin}${next}`);
      }

      // User not authorized - sign this browser out. `local` ends only the
      // portal session; the user's other sessions are theirs to keep.
      if (!jitErrorCode) {
        console.warn('User attempted portal access without valid role');
      }
      await supabase.auth.signOut({ scope: 'local' });
      return NextResponse.redirect(`${origin}/login?error=${jitErrorCode ?? 'not_authorized'}`);
    }
  }

  // No code provided or auth failed
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
