/**
 * Domain verification settings — server-side gate. BACKLOG-3962.
 *
 * A brokerage admin or IT admin proves it owns an email domain by publishing a DNS TXT record.
 * The refusal here runs before any claim is read or rendered; the server actions in
 * lib/actions/domainClaim.ts carry the same check (lib/domain/access.ts), and the table's
 * select policy is a third gate.
 *
 * A support session (impersonation) has no authenticated user, so the claims cannot be read;
 * it is sent back to the settings page, which hides this link in that mode.
 */

import { redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { requireDomainClaimAccess } from '@/lib/domain/access';
import { loadDomainClaims } from '@/lib/domain/claimView';
import DomainSettingsClient from './DomainSettingsClient';
import { loadCaptureSection } from '@/lib/domain/captureView';
import { createServiceClient } from '@/lib/supabase/service';
import CaptureSection from './CaptureSection';

export const dynamic = 'force-dynamic';

export default async function DomainSettingsPage() {
  if (await getImpersonationSession()) {
    redirect('/dashboard/settings');
  }

  const access = await requireDomainClaimAccess();
  if (!access.ok) {
    redirect('/dashboard');
  }

  const loaded = await loadDomainClaims(access.supabase, access.organizationId);
  // BACKLOG-3962 PR3b: shown only with at least one verified domain (null otherwise).
  const capture = await loadCaptureSection(access, loaded.ok ? loaded.claims : [], {
    history: () => createServiceClient(),
  });

  return (
    <>
      <DomainSettingsClient
        claims={loaded.ok ? loaded.claims : []}
        loadState={loaded.ok ? 'ok' : loaded.reason}
      />
      {capture && <CaptureSection domains={capture} />}
    </>
  );
}
