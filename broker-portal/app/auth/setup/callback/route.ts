/**
 * Setup Callback Route
 *
 * Dedicated callback for IT admin organization setup flow.
 * Validates Azure provider, blocks consumer accounts,
 * extracts email with fallback chain, and provisions org + IT admin.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { extractEmail, orgNameFromEmail } from '@/lib/auth/helpers';

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
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=azure_only`);
  }

  // Extract tenant ID from Microsoft claims
  const customClaims = user.user_metadata?.custom_claims as { tid?: string } | undefined;
  const tenantId = customClaims?.tid;

  if (!tenantId) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=no_tenant`);
  }

  // Block consumer tenant (personal Microsoft accounts)
  if (tenantId === CONSUMER_TENANT_ID) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=consumer_account`);
  }

  // Extract email with fallback chain
  const email = extractEmail(user);
  if (!email) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=no_email`);
  }

  // Check if user already has a membership (redirect to dashboard)
  const { data: membership } = await supabase
    .from('organization_members')
    .select('role, organization_id')
    .eq('user_id', user.id)
    .limit(1)
    .single();

  if (membership) {
    // If IT admin and consent not yet granted, redirect to consent page
    if (canGrantAdminConsent(membership.role)) {
      const { data: org } = await supabase
        .from('organizations')
        .select('graph_admin_consent_granted, microsoft_tenant_id')
        .eq('id', membership.organization_id)
        .single();

      if (org && !org.graph_admin_consent_granted) {
        return NextResponse.redirect(
          `${origin}/setup/consent?tenant=${encodeURIComponent(org.microsoft_tenant_id || tenantId)}&org=${encodeURIComponent(membership.organization_id)}`
        );
      }
    }

    return NextResponse.redirect(`${origin}/dashboard`);
  }

  // Provision organization and IT admin
  const orgName = orgNameFromEmail(email);
  const slug = orgName.toLowerCase().replace(/\s+/g, '-');

  if (process.env.NODE_ENV === 'development') {
    console.log(`Setup provisioning: ${email}, tenant: ${tenantId}, org: ${orgName}`);
  }

  const { data, error: rpcError } = await supabase.rpc('auto_provision_it_admin', {
    p_tenant_id: tenantId,
    p_org_name: orgName,
    p_org_slug: slug,
  });

  if (rpcError) {
    console.error('Setup provision RPC failed:', rpcError.message);
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=provision_failed`);
  }

  if (!data?.success) {
    console.error('Setup provision failed:', data?.error);
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/setup?error=provision_failed`);
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(
      `Setup complete: org=${data.organization_id}, user=${data.user_id}, role=${data.role}`
    );
  }

  // BACKLOG-3096. Until first-user-wins landed, auto_provision_it_admin made
  // EVERY caller an admin, so sending every fresh provision to the consent page
  // was always right. It is not any more: the second employee through /setup
  // now joins as the org's default role, and a plain agent cannot complete a
  // tenant-wide Microsoft admin-consent grant. Sending them there is a dead end.
  //
  // Branch on the role the RPC actually wrote — not a re-query — so the
  // callback and the database cannot disagree about which branch was taken.
  if (!canGrantAdminConsent(data.role)) {
    // /download is where middleware.ts already sends an agent who touches a
    // protected route, so this is that role's existing destination rather than
    // a new one. BACKLOG-3080 owns changing where agents land; this must not
    // pre-empt it by inventing a third destination.
    return NextResponse.redirect(`${origin}/download`);
  }

  // An admin can pre-approve Graph API permissions for all tenant users.
  return NextResponse.redirect(
    `${origin}/setup/consent?tenant=${encodeURIComponent(tenantId)}&org=${encodeURIComponent(data.organization_id)}`
  );
}
