'use client';

/**
 * RemoveUserDialog - Confirmation dialog before removing internal user(s)
 *
 * Supports removing a single user or multiple users in bulk.
 * Shows user details for single removal, or a count summary for bulk removal.
 * Calls admin_remove_internal_user RPC for each user sequentially and
 * handles partial failures gracefully.
 *
 * Uses the shared ConfirmationDialog for the dialog shell (backdrop, ARIA,
 * escape key, focus management, buttons).
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ConfirmationDialog } from '@/components/shared/ConfirmationDialog';
import type { InternalUser } from '../page';
import { describeRoleError } from '@/lib/internal-roles';

interface RemoveUserDialogProps {
  users: InternalUser[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function RemoveUserDialog({ users, onConfirm, onCancel }: RemoveUserDialogProps) {
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const isBulk = users.length > 1;

  // Single-user display
  const singleUser = users[0];
  const displayName = singleUser
    ? singleUser.display_name || singleUser.email || 'Unknown User'
    : 'Unknown User';

  async function handleRemove() {
    setError(null);
    setIsRemoving(true);

    const supabase = createClient();
    const failures: string[] = [];

    if (isBulk) {
      setProgress({ done: 0, total: users.length });
    }

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      try {
        const { error: rpcError } = await supabase.rpc('admin_remove_internal_user', {
          p_user_id: user.user_id,
        });

        if (rpcError) {
          const name = user.display_name || user.email || 'Unknown User';
          failures.push(`${name}: ${describeRoleError(rpcError, 'Failed to remove user')}`);
        }
      } catch (err) {
        const name = user.display_name || user.email || 'Unknown User';
        failures.push(`${name}: ${err instanceof Error ? err.message : 'Unexpected error'}`);
      }

      if (isBulk) {
        setProgress({ done: i + 1, total: users.length });
      }
    }

    if (failures.length > 0 && failures.length === users.length) {
      // All failed
      setError(failures.join('\n'));
      setIsRemoving(false);
      setProgress(null);
      return;
    }

    if (failures.length > 0) {
      // Partial failure — some succeeded, refresh and show errors
      setError(`Removed ${users.length - failures.length} of ${users.length} users. Failures:\n${failures.join('\n')}`);
      // Still call onConfirm to refresh the list (some users were removed)
      setTimeout(() => onConfirm(), 2000);
      return;
    }

    onConfirm();
  }

  const title = isBulk
    ? `Remove ${users.length} Internal Users`
    : 'Remove Internal User';

  const description = isBulk
    ? `Are you sure you want to remove ${users.length} users from the internal users? They will all lose access to the admin portal.`
    : `Are you sure you want to remove ${displayName} from the internal users? They will lose access to the admin portal.`;

  const confirmLabel = isRemoving
    ? 'Removing...'
    : (isBulk ? `Remove ${users.length} Users` : 'Remove User');

  return (
    <ConfirmationDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel="Cancel"
      onConfirm={handleRemove}
      onCancel={onCancel}
      isDestructive
      isLoading={isRemoving}
    >
      {/* Single-user role info */}
      {!isBulk && singleUser && (
        <p className="mt-1 text-sm text-gray-500">
          Current role: <span className="font-medium">{singleUser.role_name}</span>
        </p>
      )}

      {/* Bulk user list */}
      {isBulk && (
        <ul className="mt-2 max-h-32 overflow-y-auto space-y-1">
          {users.map((u) => (
            <li key={u.id} className="text-sm text-gray-600">
              {u.display_name || u.email || 'Unknown User'}
              <span className="text-gray-400 ml-1">({u.role_name})</span>
            </li>
          ))}
        </ul>
      )}

      {/* Progress bar for bulk operations */}
      {progress && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>Removing users...</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-1.5">
            <div
              className="bg-red-500 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2">
          <p className="text-sm text-red-700 whitespace-pre-line">{error}</p>
        </div>
      )}
    </ConfirmationDialog>
  );
}
