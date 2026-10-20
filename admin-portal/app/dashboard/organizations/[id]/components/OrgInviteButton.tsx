'use client';

/**
 * OrgInviteButton - "Invite" on the organization page (BACKLOG-4007).
 *
 * Opens InviteUserDialog with this organization prefilled and locked. It stays disabled
 * until the organization has a deal: an invite accepted before the deal exists would skip
 * the customer's billing setup. The license comes from the deal, so there is no license
 * field. The first invite into an organization with nobody in it defaults to Admin.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@keepr/design-system';
import { InviteUserDialog } from '@/app/dashboard/users/components/InviteUserDialog';

export interface OrgInviteButtonProps {
  organizationId: string;
  organizationName: string;
  /** users.edit: the same permission the Users page invite needs. */
  canInvite: boolean;
  /** billing.view: without it the deal cannot be read, so the button stays off. */
  canViewBilling: boolean;
  hasDeal: boolean;
  /** No member and no open invite yet. */
  isFirstInvite: boolean;
}

/** Why the button is off, or null when it is on. */
export function inviteBlockedReason(p: Pick<OrgInviteButtonProps, 'canViewBilling' | 'hasDeal'>): string | null {
  if (!p.canViewBilling) return 'Needs billing access to check the deal.';
  if (!p.hasDeal) return 'Set up billing first.';
  return null;
}

export function OrgInviteButton({ organizationId, organizationName, canInvite, canViewBilling, hasDeal, isFirstInvite }: OrgInviteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!canInvite) return null;
  const blocked = inviteBlockedReason({ canViewBilling, hasDeal });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={() => setOpen(true)} disabled={blocked !== null} aria-describedby={blocked ? 'org-invite-blocked' : undefined}>
        Invite
      </Button>
      {blocked && (
        <p id="org-invite-blocked" className="text-xs text-gray-500">{blocked}</p>
      )}
      {open && (
        <InviteUserDialog
          lockedOrganization={{ id: organizationId, name: organizationName }}
          defaultRole={isFirstInvite ? 'admin' : 'agent'}
          onClose={() => setOpen(false)}
          onInvited={() => router.refresh()}
        />
      )}
    </div>
  );
}
