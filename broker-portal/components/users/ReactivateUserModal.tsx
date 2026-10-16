'use client';

/**
 * Reactivate User Modal — BACKLOG-3851 PR-2b.
 *
 * Confirmation for giving a deactivated member their licence back. When the
 * organization has no free licence the modal stays open and shows the
 * out-of-licenses prompt; the row is unchanged.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, ModalFooter } from '@keepr/design-system';
import { setMemberLicense } from '@/lib/actions/memberLicense';
import OutOfLicensesNotice from './OutOfLicensesNotice';

interface ReactivateUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  memberName: string;
  callerRole: string;
}

export default function ReactivateUserModal({
  isOpen,
  onClose,
  memberId,
  memberName,
  callerRole,
}: ReactivateUserModalProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outOfSeats, setOutOfSeats] = useState(false);

  const handleReactivate = async () => {
    setIsSubmitting(true);
    setError(null);
    setOutOfSeats(false);
    try {
      const result = await setMemberLicense({ memberId, action: 'reactivate' });
      if (result.success) {
        router.refresh();
        onClose();
      } else if (result.outOfSeats) {
        setOutOfSeats(true);
      } else {
        setError(result.error ?? 'An unexpected error occurred');
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setError(null);
      setOutOfSeats(false);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" title="Reactivate User" dismissible={!isSubmitting}>
      <p className="text-sm text-gray-600 mb-4">
        Reactivate <strong>{memberName}</strong>? They get their brokerage license back and can use the broker
        portal and Keepr again.
      </p>

      {outOfSeats && <OutOfLicensesNotice callerRole={callerRole} />}

      {error && (
        <p className="text-sm text-red-600 mt-4" role="alert">
          {error}
        </p>
      )}

      <ModalFooter>
        <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="button" onClick={handleReactivate} disabled={isSubmitting}>
          {isSubmitting ? 'Reactivating...' : 'Reactivate'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
