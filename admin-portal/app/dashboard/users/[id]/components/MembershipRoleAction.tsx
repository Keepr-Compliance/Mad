'use client';

/**
 * BACKLOG-3976: Change Role for one brokerage membership on the user detail page.
 * Same dialog and server action as the organization members table; refreshes the page after a change.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield } from 'lucide-react';
import { ChangeMemberRoleDialog, type ChangeMemberRoleTarget } from '@/components/shared/ChangeMemberRoleDialog';

interface MembershipRoleActionProps {
  organizationId: string;
  userId: string;
  userName: string | null;
  role: string | null;
}

export function MembershipRoleAction({ organizationId, userId, userName, role }: MembershipRoleActionProps) {
  const router = useRouter();
  const [target, setTarget] = useState<ChangeMemberRoleTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleChanged = useCallback(
    (t: ChangeMemberRoleTarget, roleLabel: string) => {
      setTarget(null);
      setMessage(`Changed ${t.name || 'Member'}'s role to ${roleLabel}.`);
      router.refresh();
    },
    [router]
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMessage(null);
          setTarget({ organizationId, userId, name: userName, role });
        }}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
      >
        <Shield className="h-3.5 w-3.5" />
        Change Role
      </button>
      {message && (
        <p role="status" className="mt-1 text-xs text-success-600">
          {message}
        </p>
      )}
      <ChangeMemberRoleDialog target={target} onClose={() => setTarget(null)} onChanged={handleChanged} />
    </>
  );
}
