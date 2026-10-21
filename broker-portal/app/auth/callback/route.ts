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
 * BACKLOG-3991: before any of that, the names Microsoft or Google gave at this
 * sign-in go to sync_profile_names_from_idp (lib/auth/idpNames.ts), on every
 * branch. A failure there never changes where the user lands.
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
import { DEFAULT_NEXT_PATH, clearNextPathCookie, readNextPathCookie } from '@/lib/auth/safeNextPath';
import { syncIdpNames } from '@/lib/auth/idpNames';
import { isBrokerageSuspendedError } from '@/lib/auth/orgSuspension';
import { isBillingSetupIncompleteError, jitTargetFor } from '@/lib/auth/jitIdentity';
import { setupLanding } from '@/lib/billing/setupState';
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
 * a token is never left behind for a later sign-in to use, and the post-login
 * path cookie (BACKLOG-3863), so a stale destination never outlives one sign-in.
 */
function finish(location: string): NextResponse {
  const response = NextResponse.redirect(location);
  clearInviteCookie(response);
  clearNextPathCookie(response);
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
  // BACKLOG-3863 R7: the page middleware bounced to /login, from its cookie,
  // re-validated by safeNextPath(). It replaces only the /dashboard default;
  // the setup-guide, consent and invite branches below still decide first.
  // (The old `?next=` query parameter had no writer and is no longer read.)
  const next = readNextPathCookie(request) ?? DEFAULT_NEXT_PATH;

  if (code) {
    const supabase = await createClient();
    const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error('Auth exchange error:', error);
      return finish(`${origin}/login?error=auth_failed`);
    }

    // Get authenticated user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      // BACKLOG-3991: the identity provider's names, before any branch, on the
      // USER client (the function writes auth.uid()'s own row). Never throws.
      await syncIdpNames(supabase, user, exchanged?.session?.provider_token ?? null);

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
        // BACKLOG-4007 PR-3: a broker/admin whose brokerage waits for the Billing step goes to
        // the setup guide first. Billing comes before connecting Microsoft (founder 88a1f065),
        // so this runs before the consent redirect below.
        const guide = await setupLanding(supabase, { organizationId: access.organizationId, role: access.role });
        if (guide) return finish(`${origin}${guide}`);

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
          // BACKLOG-3853 PR-2B: the brokerage is suspended; the member trigger refused.
          if (isBrokerageSuspendedError(acceptError)) {
            return refuse(request, supabase, origin, 'brokerage_suspended');
          }
          console.error('accept_invitation RPC failed:', acceptError.message);
          return refuse(request, supabase, origin, 'invite_failed');
        }
        if (!accepted?.success) {
          return refuse(request, supabase, origin, inviteRefusalFor(accepted?.error));
        }
        // accept_invitation wrote a minimal users row if there was none; fill in
        // the sign-in fields. Names are not written here: sync_profile_names_from_idp
        // ran above (BACKLOG-3991), and accept_invitation fills blank names from
        // the invitation.
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
            },
            { onConflict: 'id' }
          );
          if (upsertError) {
            console.error('Error creating user record:', upsertError);
          }
        }

        // BACKLOG-4007 PR-3: the broker/admin who accepted the one onboarding invitation goes
        // straight to the setup guide while the brokerage waits for the Billing step.
        const guide = await setupLanding(supabase, {
          organizationId: accepted.organization_id,
          role: accepted.role,
          licenseStatus: accepted.license_status,
        });
        // Every other accepted member lands on `next`; middleware floors an agent.
        return finish(`${origin}${guide ?? next}`);
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

      // No membership and no pending invite - check if user can JIT-join an existing org:
      // Microsoft by tenant, Google Workspace by domain, from the identity THIS sign-in used
      // (BACKLOG-4012; lib/auth/jitIdentity.ts). Consumer Google accounts never JIT-join.
      const jitTarget = jitTargetFor(user);

      // A failed JIT join does not sign out yet: the owner of a personal
      // organization still gets the floor below. Its error code is kept for
      // everyone else.
      let jitErrorCode: string | null = null;

      if (jitTarget) {
        const { data: jitResult, error: jitError } = await supabase.rpc('jit_join_organization', {
          p_provider_type: jitTarget.providerType,
          p_identifier: jitTarget.identifier,
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
        // Determine appropriate error for user. BACKLOG-3853 PR-2B: the member
        // trigger refuses a join into a suspended brokerage. BACKLOG-4012: the
        // brokerage has not finished billing setup (the function's answer, or the
        // member trigger's refusal). Anything else, reauth_required included, is
        // org_not_setup.
        jitErrorCode = isBrokerageSuspendedError(jitError)
          ? 'brokerage_suspended'
          : jitResult?.error === 'billing_setup_pending' || isBillingSetupIncompleteError(jitError)
            ? 'billing_setup_pending'
            : jitResult?.error === 'jit_disabled'
              ? 'jit_disabled'
              : 'org_not_setup';
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
