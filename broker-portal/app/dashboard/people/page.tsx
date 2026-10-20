/**
 * People route — BACKLOG-4007 PR-4 (founder e8571c1f).
 *
 * The brokerage's billing contact, IT contact, office contacts and IT provider (MSP), and the
 * one billing-only login. Its own route so a broker can reach it without Org Settings, which
 * stays admin / IT admin only (SSO, SCIM, JIT are not widened).
 *
 * Who: lib/people-roles.ts (admin, IT admin, broker; the billing row is admin and broker only).
 * The database refuses everyone else as well (public._org_contact_caller).
 *
 * A support session has no authenticated user, and the People actions run as the signed-in
 * user, so impersonation goes back to the dashboard (the panel was never shown to support in
 * the broker portal; staff use the admin portal's organization page).
 */

import { redirect } from 'next/navigation';
import { PageHeader } from '@keepr/design-system';
import { getImpersonationSession } from '@/lib/impersonation';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { checkPeopleAccess } from '@/lib/people-access';
import { PeopleCard } from '@/components/settings/PeopleCard';

export default async function PeoplePage() {
  if (await getImpersonationSession()) redirect('/dashboard');
  const access = await checkPeopleAccess();
  if (!access.allowed) redirect('/dashboard');

  return (
    <div className="max-w-7xl mx-auto space-y-6 max-md:space-y-3">
      <PageHeader
        phoneHideTitle
        phoneHideSubtitle
        title={PAGE_TITLES.people}
        subtitle="Your brokerage's contacts and the billing-only login"
        className="max-md:mb-0"
      />
      <PeopleCard organizationId={access.organizationId} />
    </div>
  );
}
