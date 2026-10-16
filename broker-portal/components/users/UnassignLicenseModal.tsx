'use client';

/**
 * Unassign License Modal — BACKLOG-3851 PR-2b.
 *
 * Confirmation for taking a member's licence away while keeping their account.
 * Shown only while MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED is on.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, ModalFooter } from '@keepr/design-system';
import { setMemberLicense } from '@/lib/actions/memberLicense';

interface UnassignLicenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  memberName: string;
}

export default function UnassignLicenseModal({ isOpen, onClose, memberId, memberName }: UnassignLicenseModalProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnassign = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await setMemberLicense({ memberId, action: 'unassign' });
      if (result.success) {
        router.refresh();
        onClose();
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
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" title="Unassign license" dismissible={!isSubmitting}>
      <p className="text-sm text-gray-600 mb-4">
        Remove <strong>{memberName}</strong>&apos;s license? They keep their account and can still sign in to the
        broker portal (My Account and Support only). This frees one license.
      </p>

      {error && (
        <p className="text-sm text-red-600 mt-4" role="alert">
          {error}
        </p>
      )}

      <ModalFooter>
        <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="button" variant="warning" onClick={handleUnassign} disabled={isSubmitting}>
          {isSubmitting ? 'Unassigning...' : 'Unassign'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
