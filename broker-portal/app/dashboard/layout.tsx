import { redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { resolveViewerIdentity } from '@/lib/utils/userDisplay';
import { CHECKLIST_FEATURE_KEY, getChecklistNavPolicy } from '@/lib/checklist-access';
import { featureUnlockLabel } from '@/lib/feature-availability';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { getMyTransactionsGate } from '@/lib/my-transactions-access';

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const impersonation = await getImpersonationSession();
  const isImpersonating = !!impersonation;

  // During impersonation, we don't need a real auth session
  // The impersonation cookie provides the identity
  const portal = isImpersonating ? null : await getPortalAccess();

  if (!portal && !isImpersonating) {
    redirect('/login');
  }

  // BACKLOG-3080: the same classifier middleware uses. Someone who is not a
  // portal user at all has this browser's portal session ended.
  if (portal?.access.kind === 'none') {
    redirect('/auth/logout?error=not_authorized');
  }

  const access = portal?.access;
  const role = access && (access.kind === 'full' || access.kind === 'floor') ? access.role : undefined;
  // Anyone who is not a full-portal user sees the floor navigation.
  const floorOnly = !isImpersonating && access?.kind !== 'full';

  // During impersonation, use target user info from the session.
  // BACKLOG-3077: one resolution, shared with the dashboard header.
  const { displayName, displayEmail } = resolveViewerIdentity(impersonation, portal?.user ?? null);
  const displayRole = isImpersonating ? undefined : role;
  // BACKLOG-3474: the same gate the route and its actions use.
  // BACKLOG-3477: a full-portal user whose plan lacks the feature sees the
  // entry grayed (presentation only; the route still 404s).
  const checklistsPolicy = await getChecklistNavPolicy({
    isImpersonating,
    isFullPortalUser: access?.kind === 'full',
  });
  const showChecklists = checklistsPolicy === 'enabled';
  const checklistsUnavailableLabel =
    checklistsPolicy === 'grayed' ? featureUnlockLabel(CHECKLIST_FEATURE_KEY, checklistsPolicy) : null;
  // BACKLOG-3080: the same gate the My Transactions pages use. Shown when the
  // pages would render (the list, or the plan message), hidden when they 404.
  const showMyTransactions = !isImpersonating && (await getMyTransactionsGate()) !== null;

  return (
    <DashboardShell
      role={role}
      floorOnly={floorOnly}
      isImpersonating={isImpersonating}
      displayName={displayName}
      displayEmail={displayEmail}
      displayRole={displayRole}
      showChecklists={showChecklists}
      checklistsUnavailableLabel={checklistsUnavailableLabel}
      showMyTransactions={showMyTransactions}
    >
      {children}
    </DashboardShell>
  );
}
