'use client';

/**
 * BACKLOG-3976: Change Role button in the user profile header. One brokerage membership opens the
 * shared role dialog directly; several first ask which brokerage. The picker lives here so the
 * shared ChangeMemberRoleDialog (also used by the organization members table) is unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield } from 'lucide-react';
import { Button, Label, Select } from '@keepr/design-system';
import { ChangeMemberRoleDialog, type ChangeMemberRoleTarget } from '@/components/shared/ChangeMemberRoleDialog';

export interface BrokerageMembership {
  organization_id: string;
  org_name: string | null;
  role: string | null;
}

interface UserRoleActionProps {
  userId: string;
  userName: string | null;
  /** Non-personal memberships only. */
  memberships: BrokerageMembership[];
}

export function UserRoleAction({ userId, userName, memberships }: UserRoleActionProps) {
  const router = useRouter();
  const pickerRef = useRef<HTMLDialogElement>(null);
  const [picking, setPicking] = useState(false);
  const [pickedOrgId, setPickedOrgId] = useState('');
  const [target, setTarget] = useState<ChangeMemberRoleTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = pickerRef.current;
    if (!dialog) return;
    if (picking && !dialog.open) dialog.showModal();
    else if (!picking && dialog.open) dialog.close();
  }, [picking]);

  const targetFor = useCallback(
    (orgId: string): ChangeMemberRoleTarget | null => {
      const m = memberships.find((x) => x.organization_id === orgId);
      return m ? { organizationId: m.organization_id, userId, name: userName, role: m.role } : null;
    },
    [memberships, userId, userName]
  );

  const handleChanged = useCallback(
    (t: ChangeMemberRoleTarget, roleLabel: string) => {
      setTarget(null);
      setMessage(`Changed ${t.name || 'Member'}'s role to ${roleLabel}.`);
      router.refresh();
    },
    [router]
  );

  if (memberships.length === 0) return null;

  const openAction = () => {
    setMessage(null);
    if (memberships.length === 1) {
      setTarget(targetFor(memberships[0].organization_id));
    } else {
      setPickedOrgId(memberships[0].organization_id);
      setPicking(true);
    }
  };

  const continueFromPicker = () => {
    const t = targetFor(pickedOrgId);
    setPicking(false);
    setTarget(t);
  };

  return (
    <>
      <button
        type="button"
        onClick={openAction}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors max-md:min-h-[44px] text-primary-700 bg-primary-50 hover:bg-primary-100"
      >
        <Shield className="h-4 w-4" />
        Change Role
      </button>
      {message && (
        <p role="status" className="basis-full text-xs text-success-600">
          {message}
        </p>
      )}

      <dialog
        ref={pickerRef}
        onClose={() => setPicking(false)}
        aria-label="Choose organization"
        className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
      >
        {picking && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-gray-900">Choose organization</h3>
            <p className="mt-2 text-sm text-gray-600">
              {userName || 'This user'} belongs to more than one brokerage. Pick the one whose role you want to change.
            </p>
            <div className="mt-4">
              <Label htmlFor="role-org-picker">Organization</Label>
              <Select id="role-org-picker" value={pickedOrgId} onChange={(e) => setPickedOrgId(e.target.value)}>
                {memberships.map((m) => (
                  <option key={m.organization_id} value={m.organization_id}>
                    {m.org_name || 'Unnamed Organization'}
                    {m.role ? ` (${m.role})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setPicking(false)}>
                Cancel
              </Button>
              <Button onClick={continueFromPicker}>Continue</Button>
            </div>
          </div>
        )}
      </dialog>

      <ChangeMemberRoleDialog target={target} onClose={() => setTarget(null)} onChanged={handleChanged} />
    </>
  );
}
