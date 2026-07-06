'use client';

/**
 * Bulk Edit Role Modal Component
 *
 * Modal for changing the role of multiple users at once.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
// Modal/ModalFooter/Label/Select are Tier-2 (no @keepr/ui equivalent yet).
import { Label, Modal, ModalFooter, Select } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { bulkUpdateRole } from '@/lib/actions/bulkUpdateRole';
import { ROLE_LABELS, ASSIGNABLE_ROLES_BY_ADMIN, ASSIGNABLE_ROLES_BY_IT_ADMIN } from '@/lib/types/users';
import type { Role } from '@/lib/types/users';

interface BulkEditRoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberIds: string[];
  memberCount: number;
  currentUserRole: Role;
}

export default function BulkEditRoleModal({
  isOpen,
  onClose,
  memberIds,
  memberCount,
  currentUserRole,
}: BulkEditRoleModalProps) {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<Role>('agent');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get assignable roles based on current user's role
  const assignableRoles =
    currentUserRole === 'it_admin'
      ? ASSIGNABLE_ROLES_BY_IT_ADMIN
      : ASSIGNABLE_ROLES_BY_ADMIN;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await bulkUpdateRole({
        memberIds,
        newRole: selectedRole,
      });

      if (result.error) {
        setError(result.error);
      } else {
        router.refresh();
        onClose();
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedRole('agent');
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      size="sm"
      title={<>Change Role for {memberCount} User{memberCount !== 1 ? 's' : ''}</>}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="bulk-role">New Role</Label>
          <Select
            id="bulk-role"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value as Role)}
          >
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
        </div>

        <p className="text-sm text-gray-500">
          This will change the role for all {memberCount} selected user
          {memberCount !== 1 ? 's' : ''} to {ROLE_LABELS[selectedRole]}.
        </p>

        {error && <AlertBanner variant="destructive">{error}</AlertBanner>}

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Updating...' : 'Update Role'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
