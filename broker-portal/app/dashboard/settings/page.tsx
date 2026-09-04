/**
 * Organization settings route — server-side gate. BACKLOG-3078.
 *
 * This page carries ORG POLICY ONLY: Microsoft admin consent, Just-in-Time
 * provisioning, the org-wide email retention policy, and the SCIM link. One
 * person's own devices moved to /dashboard/account in the same change, so this
 * page never has to behave two ways for two roles — which is exactly where an
 * access-control mistake would hide once BACKLOG-3080 lets `agent` into the
 * portal.
 *
 * Until this item there was no server refusal here at all: the whole page was a
 * client component whose server actions each checked the role separately, so a
 * non-admin loading the URL got the chrome, an empty consent card, a retention
 * dropdown showing 7 years and a JIT toggle showing on. Those are org policy,
 * and they were rendered before anything refused.
 *
 * The card render policies are resolved HERE rather than in the client, so the
 * page and the server actions read the same fail-closed helper and cannot
 * disagree. A grayed or hidden card is still not a gate — the refusals live in
 * lib/scim-access.ts, lib/jit-access.ts and updateRetentionPolicy.
 */

import { redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import {
  checkOrgSettingsAccess,
  impersonationFeatureView,
  resolveOrgSettingsFeatures,
} from '@/lib/org-settings-access';
import OrgSettingsClient from './OrgSettingsClient';

export default async function SettingsPage() {
  // Support sessions read this page through impersonation and have no
  // authenticated user, so the role check below would refuse them and regress
  // the read-only view TASK-2138 shipped. Mirrors /dashboard/users.
  const impersonation = await getImpersonationSession();
  if (impersonation) {
    return <OrgSettingsClient features={impersonationFeatureView()} />;
  }

  const access = await checkOrgSettingsAccess();
  if (!access.allowed) {
    redirect('/dashboard');
  }

  const features = await resolveOrgSettingsFeatures(access.organizationId);

  return <OrgSettingsClient features={features} />;
}
