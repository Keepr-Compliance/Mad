/**
 * OAuth Callback Route
 *
 * Handles the OAuth redirect from Supabase Auth:
 * 1. Exchanges authorization code for session
 * 2. Routes a brokerage member (full portal or floor) to `next`
 * 3. Accepts the invitation whose link the user signed in from (BACKLOG-3684:
 *    only through the link; a pending invite without it is not accepted)
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
import { clearAuthCookies, signOutLocal } from '@/lib/auth/signOutLocal';
import { clearInviteCookie, readInviteToken } from '@/lib/auth/inviteCookie';
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  pickBrokerageMembership,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

/** accept_invitation refusals that have their own /login message. */
const INVITE_REFUSALS = ['invalid_invite', 'email_mismatch', 'expired', 'already_placed'] as const;

/** The /login code for an accept_invitation refusal; anything else is invite_failed. */
function inviteRefusalFor(error: unknown): string {
  return INVITE_REFUSALS.find((code) => code === error) ?? 'invite_failed';
}

/**
 * Every exit of this route: a redirect that also deletes the invite cookie, so
 * a token is never left behind for a later sign-in to use.
 */
function finish(location: string): NextResponse {
  const response = NextResponse.redirect(location);
  clearInviteCookie(response);
  return response;
}

/**
 * BACKLOG-3684: signs this browser out (local scope only) and sends the caller
 * to /login with `code`. The auth cookies are deleted on the response too, so a
 * sign-out that fails cannot leave a session that middleware would bounce off
 * /login (the rejectSetup shape, BACKLOG-3601).
 */
async function refuse(
  request: Request,
  supabase: Awaited<ReturnType<typeof createClient>>,
  origin: string,
  code: string
): Promise<NextResponse> {
  await signOutLocal(supabase);
  const response = finish(`${origin}/login?error=${code}`);
  clearAuthCookies(request, response);
  return response;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const inviteToken = readInviteToken(request, 'invite');
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next') ?? '/dashboard';
  const next = /^\/[a-zA-Z0-9\-_/?&=#.]+$/.test(rawNext) ? rawNext : '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error('Auth exchange error:', error);
      return finish(`${origin}/login?error=auth_failed`);
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
            return finish(
              `${origin}/setup/consent?tenant=${encodeURIComponent(org.microsoft_tenant_id)}&org=${encodeURIComponent(access.organizationId)}`
            );
          }
        }

        // User has valid role - redirect to dashboard
        return finish(`${origin}${next}`);
      }

      // BACKLOG-3917 / 3851: ANY brokerage row that does not open the full
      // portal places the member: an agent, a deactivated member, one with no
      // license assigned, and a deactivated member the classifier routes on
      // their own personal organization (pay-as-you-go). They land on `next`
      // and middleware decides; they never reach the invite-link or JIT-join
      // paths below. Read from the brokerage row itself, not from `access`,
      // because a reverted member's access is personal_owner.
      if (pickBrokerageMembership(memberships as PortalMembershipRow[] | null)) {
        return finish(`${origin}${next}`);
      }

      // BACKLOG-3684: an invitation is accepted only through its link. The
      // invitation page put the link's token in the keepr_invite cookie; the
      // database accepts it only for the account the invitation was sent to.
      if (inviteToken) {
        const { data: accepted, error: acceptError } = await supabase.rpc('accept_invitation', {
          p_token: inviteToken,
        });
        if (acceptError) {
          console.error('accept_invitation RPC failed:', acceptError.message);
          return refuse(request, supabase, origin, 'invite_failed');
        }
        if (!accepted?.success) {
          return refuse(request, supabase, origin, inviteRefusalFor(accepted?.error));
        }
        // accept_invitation wrote a minimal users row if there was none; fill in
        // the profile fields as this route always has.
        const userEmail = extractEmail(user);
        if (userEmail) {
          const provider = user.app_metadata?.provider || 'email';
          const oauthId = user.user_metadata?.provider_id || user.id;
          const { error: upsertError } = await supabase.from('users').upsert(
            {
              id: user.id,
              email: userEmail,
              oauth_provider: provider,
              oauth_id: oauthId,
              display_name: user.user_metadata?.full_name || user.user_metadata?.name || null,
              first_name: user.user_metadata?.given_name || null,
              last_name: user.user_metadata?.family_name || null,
            },
            { onConflict: 'id' }
          );
          if (upsertError) {
            console.error('Error creating user record:', upsertError);
          }
        }

        // Every accepted member lands on `next`; middleware floors an agent.
        return finish(`${origin}${next}`);
      }

      // No link: a pending invitation for this account is not accepted here.
      // Except the owner of a personal organization (founder question open;
      // option a): they keep their floor below and the invite stays pending.
      if (access.kind !== 'floor') {
        const { data: hasPendingInvite, error: detectError } = await supabase.rpc(
          'caller_has_pending_invite'
        );
        if (detectError) {
          console.error('caller_has_pending_invite RPC failed:', detectError.message);
        } else if (hasPendingInvite === true) {
          return refuse(request, supabase, origin, 'invite_link_required');
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
          return finish(`${origin}${next}`);
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
        return finish(`${origin}${next}`);
      }

      // User not authorized - sign this browser out. `local` ends only the
      // portal session; the user's other sessions are theirs to keep.
      if (!jitErrorCode) {
        console.warn('User attempted portal access without valid role');
      }
      await signOutLocal(supabase);
      return finish(`${origin}/login?error=${jitErrorCode ?? 'not_authorized'}`);
    }
  }

  // No code provided or auth failed
  return finish(`${origin}/login?error=auth_failed`);
}
