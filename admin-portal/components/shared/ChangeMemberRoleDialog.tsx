'use client';

/**
 * BACKLOG-3976: the Change Role dialog, shared by the organization members table and the
 * user detail page's Organizations card. Calls the changeMemberRole server action; the
 * admin_update_org_member_role RPC re-checks users.edit and the shared triggers apply the
 * last-admin and identity-provider rules. A refusal is shown inside the dialog.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Label, Select } from '@keepr/design-system';
import { changeMemberRole } from '@/lib/actions/changeMemberRole';
import { MEMBER_ROLE_OPTIONS, type MemberRole } from '@/lib/actions/changeMemberRole.helpers';

export interface ChangeMemberRoleTarget {
  organizationId: string;
  userId: string;
  /** Shown in the dialog; falls back to "this member". */
  name: string | null;
  role: string | null;
}

interface ChangeMemberRoleDialogProps {
  /** The member to change. null keeps the dialog closed. */
  target: ChangeMemberRoleTarget | null;
  onClose: () => void;
  /** Called after a successful change with the new role's label. */
  onChanged: (target: ChangeMemberRoleTarget, roleLabel: string) => void;
}

function initialRole(role: string | null): MemberRole {
  return MEMBER_ROLE_OPTIONS.find((o) => o.value === role)?.value ?? 'agent';
}

export function ChangeMemberRoleDialog({ target, onClose, onChanged }: ChangeMemberRoleDialogProps) {
  const roleRef = useRef<HTMLDialogElement>(null);
  const [roleChoice, setRoleChoice] = useState<MemberRole>('agent');
  const [roleError, setRoleError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const dialog = roleRef.current;
    if (!dialog) return;
    if (target) {
      setRoleChoice(initialRole(target.role));
      setRoleError(null);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [target]);

  const executeRoleChange = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setRoleError(null);
    const result = await changeMemberRole({
      organizationId: target.organizationId,
      userId: target.userId,
      role: roleChoice,
    });
    setLoading(false);
    if (!result.success) {
      setRoleError(result.error ?? 'Failed to change role');
      return;
    }
    const label = MEMBER_ROLE_OPTIONS.find((o) => o.value === roleChoice)?.label ?? roleChoice;
    roleRef.current?.close();
    onChanged(target, label);
  }, [target, roleChoice, onChanged]);

  return (
    <dialog
      ref={roleRef}
      onClose={onClose}
      className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
    >
      {target && (
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900">Change Role</h3>

          <p className="mt-2 text-sm text-gray-600">
            Change the role of{' '}
            <span className="font-medium text-gray-900">{target.name || 'this member'}</span> in this
            organization. The change is recorded in the audit log.
          </p>

          <div className="mt-4">
            <Label htmlFor="member-role">Role</Label>
            <Select
              id="member-role"
              value={roleChoice}
              onChange={(e) => setRoleChoice(e.target.value as MemberRole)}
              disabled={loading}
            >
              {MEMBER_ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>

          {roleError && (
            <div role="alert" className="mt-4 rounded-lg px-4 py-2.5 text-sm bg-danger-50 text-danger-600">
              {roleError}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => roleRef.current?.close()} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={executeRoleChange} disabled={loading || roleChoice === target.role}>
              {loading ? 'Processing...' : 'Change Role'}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
