/**
 * Setup Callback Route
 *
 * Callback for /setup: a person their brokerage invited (admin, IT admin or
 * any other role) signs in with Microsoft to accept the invitation, and an
 * admin's sign-in links the brokerage to their Microsoft organization.
 * Validates Azure provider, blocks consumer accounts, extracts email with the
 * fallback chain, then calls auto_provision_it_admin. /setup never creates a
 * brokerage: without an invitation the RPC returns no_invite.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { extractEmail } from '@/lib/auth/helpers';
import { PORTAL_MEMBERSHIP_SELECT, pickBrokerageMembership } from '@/lib/auth/membership';
import { clearAuthCookies, signOutLocal } from '@/lib/auth/signOutLocal';

// Microsoft consumer tenant ID (personal Outlook/Hotmail accounts)
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/**
 * Roles that can complete a tenant-wide Microsoft admin-consent grant.
 *
 * One definition for the whole file: the existing-membership branch below and
 * the fresh-provision branch must not drift into disagreeing about who the
 * consent page is for. `auto_provision_it_admin` only ever writes 'admin' on
 * that branch; 'it_admin' is here because the membership branch has always
 * accepted it, and a role check that silently narrowed would be a regression
 * for anyone already holding it.
 */
function canGrantAdminConsent(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'it_admin';
}

/** The /setup error codes that end the session this callback just created. */
type SetupRejection =
  | 'azure_only'
  | 'no_tenant'
  | 'consumer_account'
  | 'no_email'
  | 'no_invite'
  | 'tenant_in_use'
  | 'tenant_mismatch'
  | 'provision_failed';

/** auto_provision_it_admin refusals that have their own /setup message. */
const RPC_REJECTIONS: readonly SetupRejection[] = ['no_invite', 'tenant_in_use', 'tenant_mismatch'];

/** The /setup code for an RPC refusal; anything unrecognised is provision_failed. */
function rejectionFor(error: unknown): SetupRejection {
  return RPC_REJECTIONS.find((code) => code === error) ?? 'provision_failed';
}

/**
 * BACKLOG-3601: signs this browser out (local scope only), then sends the
 * caller back to /setup with `code`. Not used for `auth_failed`: those exits
 * never had a session to end.
 */
async function rejectSetup(
  request: Request,
  supabase: Awaited<ReturnType<typeof createClient>>,
  origin: string,
  code: SetupRejection
): Promise<NextResponse> {
  await signOutLocal(supabase);
  const response = NextResponse.redirect(`${origin}/setup?error=${code}`);
  clearAuthCookies(request, response);
  return response;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(`${origin}/setup?error=auth_failed`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('Setup auth exchange error:', error.message);
    return NextResponse.redirect(`${origin}/setup?error=auth_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/setup?error=auth_failed`);
  }

  // Validate Azure provider (reject Google or other providers)
  const provider = user.app_metadata?.provider;
  if (provider !== 'azure') {
    return rejectSetup(request, supabase, origin, 'azure_only');
  }

  // Extract tenant ID from Microsoft claims
  const customClaims = user.user_metadata?.custom_claims as { tid?: string } | undefined;
  const tenantId = customClaims?.tid;

  if (!tenantId) {
    return rejectSetup(request, supabase, origin, 'no_tenant');
  }

  // Block consumer tenant (personal Microsoft accounts)
  if (tenantId === CONSUMER_TENANT_ID) {
    return rejectSetup(request, supabase, origin, 'consumer_account');
  }

  // Extract email with fallback chain
  const email = extractEmail(user);
  if (!email) {
    return rejectSetup(request, supabase, origin, 'no_email');
  }

  // Check if the user already belongs to a BROKERAGE (redirect to dashboard).
  //
  // BACKLOG-3364: a solo user's own personal organization is not one. Counted
  // as a membership it would return /dashboard below without ever calling
  // auto_provision_it_admin, so a solo agent who later starts a brokerage could
  // never set one up through /setup. Skipping it leaves them where they were
  // before personal organizations existed: no membership, so provisioning runs.
  // The membership the RPC then writes retires the personal one in the database.
  const { data: memberships } = await supabase
    .from('organization_members')
    .select(PORTAL_MEMBERSHIP_SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  const membership = pickBrokerageMembership(memberships);

  if (membership) {
    // If IT admin and consent not yet granted, redirect to consent page
    if (canGrantAdminConsent(membership.role)) {
      const { data: org } = await supabase
        .from('organizations')
        .select('graph_admin_consent_granted, microsoft_tenant_id')
        .eq('id', membership.organization_id)
        .single();

      // BACKLOG-3851: an active admin whose brokerage has no Microsoft
      // organization linked yet (e.g. they accepted the emailed invitation
      // through /login) links it here. The RPC checks the tenant; a refusal
      // gets its own /setup message. Members who are not active, and
      // brokerages that already have a tenant, keep the routing below.
      if (org && !org.microsoft_tenant_id && membership.license_status === 'active') {
        const { data: linked, error: linkError } = await supabase.rpc('auto_provision_it_admin', {
          p_tenant_id: tenantId,
          p_org_name: '',
          p_org_slug: '',
        });
        if (linkError) {
          console.error('Setup tenant link RPC failed:', linkError.message);
          return rejectSetup(request, supabase, origin, 'provision_failed');
        }
        if (!linked?.success) {
          console.error('Setup tenant link failed:', linked?.error);
          return rejectSetup(request, supabase, origin, rejectionFor(linked?.error));
        }
        if (!org.graph_admin_consent_granted) {
          return NextResponse.redirect(
            `${origin}/setup/consent?tenant=${encodeURIComponent(tenantId)}&org=${encodeURIComponent(membership.organization_id)}`
          );
        }
        return NextResponse.redirect(`${origin}/dashboard`);
      }

      if (org && !org.graph_admin_consent_granted) {
        return NextResponse.redirect(
          `${origin}/setup/consent?tenant=${encodeURIComponent(org.microsoft_tenant_id || tenantId)}&org=${encodeURIComponent(membership.organization_id)}`
        );
      }
    }

    return NextResponse.redirect(`${origin}/dashboard`);
  }

  // BACKLOG-3851: accept the caller's invitation. The RPC creates no
  // organization; p_org_name / p_org_slug are kept for its signature only.
  if (process.env.NODE_ENV === 'development') {
    console.log(`Setup: completing invitation for ${email}, tenant: ${tenantId}`);
  }

  const { data, error: rpcError } = await supabase.rpc('auto_provision_it_admin', {
    p_tenant_id: tenantId,
    p_org_name: '',
    p_org_slug: '',
  });

  if (rpcError) {
    console.error('Setup provision RPC failed:', rpcError.message);
    return rejectSetup(request, supabase, origin, 'provision_failed');
  }

  if (!data?.success) {
    console.error('Setup provision failed:', data?.error);
    return rejectSetup(request, supabase, origin, rejectionFor(data?.error));
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(
      `Setup complete: org=${data.organization_id}, user=${data.user_id}, role=${data.role}`
    );
  }

  // The role is the invitation's role (BACKLOG-3851; first-user-wins, 3096,
  // is gone). Only an admin can complete a tenant-wide Microsoft admin-consent
  // grant, so anyone else goes to /dashboard; the consent page is a dead end
  // for them.
  //
  // Branch on the role the RPC actually wrote — not a re-query — so the
  // callback and the database cannot disagree about which branch was taken.
  if (!canGrantAdminConsent(data.role)) {
    // /dashboard, NOT a per-role destination.
    //
    // This callback deliberately does not own a role -> destination table.
    // middleware.ts already owns that decision and applies it to every
    // protected request: since BACKLOG-3080 it gives broker, admin and
    // it_admin the whole portal and an agent the floor (lib/auth/membership.ts).
    // If this file also decided, the two would drift the moment either
    // changed -- and they already had once: an earlier version of this branch
    // sent every non-admin to /download, which was wrong for a broker.
    //
    // So there is ONE destination here and ONE routing authority.
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  // An admin can pre-approve Graph API permissions for all tenant users.
  return NextResponse.redirect(
    `${origin}/setup/consent?tenant=${encodeURIComponent(tenantId)}&org=${encodeURIComponent(data.organization_id)}`
  );
}
