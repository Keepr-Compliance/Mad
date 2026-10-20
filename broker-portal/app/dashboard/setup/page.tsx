/**
 * Brokerage setup guide — BACKLOG-4007 PR-3.
 *
 * One invitation creates the broker's account; this guide then completes the brokerage:
 *   1. Billing (confirm the order, company details, billing contact, Terms) -> starts billing
 *   2. Connect Microsoft (admins signed in with Microsoft; "Skip for now")
 *   3. Done
 * Order: Billing before Microsoft (founder 88a1f065). Step choice: lib/billing/setupSteps.ts.
 *
 * Gate: a broker or admin with full portal access (the database refuses everyone else too:
 * broker_get_billing_setup answers 42501). Support/impersonation sessions get a 404. With no
 * deal on record (or a failed read) the guide says there is nothing to set up.
 */

import { notFound, redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { readBillingSetup, setupRoleOf } from '@/lib/billing/setupState';
import { setupStepFor } from '@/lib/billing/setupSteps';
import { NothingToSetUp, SetupGuide } from '@/components/setup/SetupGuide';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SetupGuideRoute({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  if (await getImpersonationSession()) notFound();
  const portal = await getPortalAccess();
  if (!portal) redirect('/login');
  const who = setupRoleOf(portal.access);
  if (!who) redirect('/dashboard');

  const view = await readBillingSetup(portal.supabase, who.organizationId);
  if (!view) return <NothingToSetUp />;

  const { data: org } = await portal.supabase
    .from('organizations')
    .select('name, microsoft_tenant_id')
    .eq('id', who.organizationId)
    .maybeSingle();
  const orgRow = org as { name?: string | null; microsoft_tenant_id?: string | null } | null;

  const sp = (await searchParams) ?? {};
  const requested = typeof sp.step === 'string' ? sp.step : null;
  const signInProvider = (portal.user.app_metadata?.provider as string | undefined) ?? null;
  const step = setupStepFor({
    state: view.state,
    role: who.role,
    hasMicrosoftTenant: !!orgRow?.microsoft_tenant_id,
    signInProvider,
    requested,
  });

  return (
    <SetupGuide
      step={step}
      organizationId={who.organizationId}
      brokerageName={orgRow?.name ?? null}
      view={view}
      isGoogleSignIn={signInProvider === 'google'}
      role={who.role}
    />
  );
}
