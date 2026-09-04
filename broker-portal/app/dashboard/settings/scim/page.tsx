/**
 * SCIM settings route — server-side gate. BACKLOG-3087.
 *
 * Hiding the link on the settings page is not a gate: anyone who has seen this
 * URL once, or guessed it, can come straight back. This server component is the
 * refusal that actually holds, and it runs before any SCIM markup is produced.
 *
 * notFound() rather than a "not available on your plan" page: the surface
 * promises a SCIM endpoint that returns 404 today, so there is nothing to
 * upsell and no reason to advertise that it exists.
 *
 * The four SCIM server actions carry the same check independently
 * (lib/scim-access.ts) — a gate on the route alone would leave the actions
 * callable directly.
 */

import { notFound } from 'next/navigation';
import { isScimProvisioningEnabled } from '@/lib/scim-access';
import ScimSettingsClient from './ScimSettingsClient';

export default async function ScimSettingsPage() {
  if (!(await isScimProvisioningEnabled())) {
    notFound();
  }

  return <ScimSettingsClient />;
}
