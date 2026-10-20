import { redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { resolveViewerIdentity } from '@/lib/utils/userDisplay';
import { CHECKLIST_FEATURE_KEY, isChecklistPageEnabled } from '@/lib/checklist-access';
import { getChecklistNavPolicy } from '@/lib/checklist-nav';
import { featureUnlockLabel } from '@/lib/feature-availability';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { getMyTransactionsGate } from '@/lib/my-transactions-access';
import { billingEnabled } from '@/lib/billing/flag';
import { billingNavVisible } from '@/lib/billing/capabilities';

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
    editorEnabled: !isImpersonating && (await isChecklistPageEnabled()),
    isImpersonating,
    isFullPortalUser: access?.kind === 'full',
  });
  const showChecklists = checklistsPolicy === 'enabled';
  const checklistsUnavailableLabel =
    checklistsPolicy === 'grayed' ? featureUnlockLabel(CHECKLIST_FEATURE_KEY, checklistsPolicy) : null;
  // BACKLOG-3080: the same gate the My Transactions pages use. Shown when the
  // pages would render (the list, or the plan message), hidden when they 404.
  const showMyTransactions = !isImpersonating && (await getMyTransactionsGate()) !== null;
  // BACKLOG-3844: the rule the billing page uses, on access only. No read: the
  // access above is reused. The page refuses on its own.
  // BACKLOG-3878: a suspended account sees Billing (personal owner only), Support
  // and My Account. The pages and middleware refuse the rest on their own. Never
  // read while impersonating (portal is null then).
  const suspended = portal?.suspended === true;
  const personalOwner = access?.kind === 'floor' && access.via === 'personal_owner';
  const showBilling =
    billingNavVisible({
      access,
      isImpersonating,
      enabled: billingEnabled(),
      // BACKLOG-4007 PR-4: the billing-only login.
      billingContact: portal?.billingContact === true,
    }) && (!suspended || personalOwner);
  // BACKLOG-3853 PR-2B: a suspended BROKERAGE (org_deals), not the licence above.
  // A broker, admin or IT admin sees Billing, Support and My Account; an agent
  // keeps the floor (Checklists is already hidden by the checklist gate). A
  // failed read (null) shows the normal navigation; the pages refuse on their own.
  const orgSuspended = !suspended && portal?.orgSuspended === true && access?.kind === 'full';

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
      showBilling={showBilling}
      suspended={suspended}
      orgSuspended={orgSuspended}
    >
      {children}
    </DashboardShell>
  );
}
