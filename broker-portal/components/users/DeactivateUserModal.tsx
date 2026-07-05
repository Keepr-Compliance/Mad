'use client';

/**
 * Deactivate User Modal Component
 *
 * Confirmation dialog for deactivating (suspending) a user.
 * Shows warning about access removal and calls deactivateUser action.
 *
 * TASK-1812: Deactivate/Remove user flow
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, ModalFooter } from '@keepr/design-system';
import { deactivateUser } from '@/lib/actions/deactivateUser';

interface DeactivateUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  memberName: string;
}

export default function DeactivateUserModal({
  isOpen,
  onClose,
  memberId,
  memberName,
}: DeactivateUserModalProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDeactivate = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await deactivateUser({ memberId });

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
      title="Deactivate User"
      dismissible={!isSubmitting}
    >
      <p className="text-sm text-gray-600 mb-4">
        Are you sure you want to deactivate <strong>{memberName}</strong>?
        They will no longer be able to access the broker portal or submit transactions.
      </p>

      <p className="text-sm text-gray-500">
        You can reactivate this user later if needed.
      </p>

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
          variant="warning"
          onClick={handleDeactivate}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Deactivating...' : 'Deactivate'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
