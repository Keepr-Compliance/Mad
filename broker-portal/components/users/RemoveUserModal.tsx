'use client';

/**
 * Remove User Modal Component
 *
 * Confirmation dialog for removing a user or revoking an invitation.
 * Shows warning about permanent removal and calls removeUser action.
 *
 * TASK-1812: Deactivate/Remove user flow
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, ModalFooter } from '@keepr/design-system';
import { removeUser } from '@/lib/actions/removeUser';

interface RemoveUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  memberName: string;
  isPending: boolean;
}

export default function RemoveUserModal({
  isOpen,
  onClose,
  memberId,
  memberName,
  isPending,
}: RemoveUserModalProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await removeUser({ memberId });

      if (result.error) {
        setError(result.error);
      } else {
        router.refresh();
        onClose();
      }
    } catch (err) {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setError(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      size="sm"
      title={isPending ? 'Revoke Invitation' : 'Remove User'}
      dismissible={!isSubmitting}
    >
      <p className="text-sm text-gray-600 mb-4">
        {isPending ? (
          <>Are you sure you want to revoke the invitation for <strong>{memberName}</strong>?</>
        ) : (
          <>Are you sure you want to remove <strong>{memberName}</strong> from the organization?</>
        )}
      </p>

      {!isPending && (
        <p className="text-sm text-red-600">
          This action cannot be undone. The user will need to be re-invited.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-600 mt-4" role="alert">
          {error}
        </p>
      )}

      <ModalFooter>
        <Button
          type="button"
          variant="secondary"
          onClick={handleClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={handleRemove}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Removing...' : (isPending ? 'Revoke' : 'Remove')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
