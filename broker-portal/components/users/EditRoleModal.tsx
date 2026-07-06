'use client';

/**
 * Edit Role Modal Component
 *
 * Modal dialog for changing an organization member's role.
 * Shows role options filtered by current user's permissions.
 *
 * TASK-1811: Edit user role modal
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Label, Modal, ModalFooter, Select } from '@keepr/design-system';
import { updateUserRole } from '@/lib/actions/updateUserRole';
import {
  ASSIGNABLE_ROLES_BY_ADMIN,
  ASSIGNABLE_ROLES_BY_IT_ADMIN,
  ROLE_LABELS,
} from '@/lib/types/users';
import type { Role } from '@/lib/types/users';

// ============================================================================
// Types
// ============================================================================

interface EditRoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  memberName: string;
  currentRole: Role;
  currentUserRole: Role;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get a short description for each role
 */
function getRoleDescription(role: Role): string {
  switch (role) {
    case 'agent':
      return 'Can submit transactions';
    case 'broker':
      return 'Can review submissions';
    case 'admin':
      return 'Full organization access';
    case 'it_admin':
      return 'SSO/SCIM management';
    default:
      return '';
  }
}

/**
 * Get available roles based on current user's role
 */
function getAvailableRoles(currentUserRole: Role): Role[] {
  if (currentUserRole === 'it_admin') {
    return [...ASSIGNABLE_ROLES_BY_IT_ADMIN];
  }
  return [...ASSIGNABLE_ROLES_BY_ADMIN];
}

// ============================================================================
// Component
// ============================================================================

export default function EditRoleModal({
  isOpen,
  onClose,
  memberId,
  memberName,
  currentRole,
  currentUserRole,
}: EditRoleModalProps) {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<Role>(currentRole);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableRoles = getAvailableRoles(currentUserRole);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // No change needed
    if (selectedRole === currentRole) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await updateUserRole({
        memberId,
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
    setSelectedRole(currentRole);
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" title={<>Change Role for {memberName}</>}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Current role display */}
        <div className="bg-gray-50 p-3 rounded-md">
          <p className="text-sm text-gray-600">
            Current role: <span className="font-medium">{ROLE_LABELS[currentRole]}</span>
          </p>
        </div>

        {/* Role select */}
        <div>
          <Label htmlFor="edit-role">New Role</Label>
          <Select
            id="edit-role"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value as Role)}
          >
            {availableRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]} - {getRoleDescription(role)}
              </option>
            ))}
          </Select>
        </div>

        {/* Error message */}
        {error && <Alert variant="error">{error}</Alert>}

        {/* Buttons */}
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || selectedRole === currentRole}>
            {isSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
