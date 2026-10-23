'use client';

/**
 * Edit Name Modal — BACKLOG-3991.
 *
 * An admin or it_admin changes a member's first and last name. Shown only for a
 * brokerage that manages users by hand; the note says the identity provider wins
 * at the member's next sign-in.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Modal, ModalFooter } from '@keepr/design-system';
import { setMemberName } from '@/lib/actions/memberName';
import { MEMBER_NAME_MAX_LENGTH, MEMBER_NAME_NOTE, memberNameInputError } from '@/lib/users/memberName';

interface EditNameModalProps {
  isOpen: boolean;
  onClose: () => void;
  memberId: string;
  initialFirstName: string | null;
  initialLastName: string | null;
}

export default function EditNameModal({ isOpen, onClose, memberId, initialFirstName, initialLastName }: EditNameModalProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialFirstName ?? '');
  const [lastName, setLastName] = useState(initialLastName ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFirstName(initialFirstName ?? '');
      setLastName(initialLastName ?? '');
      setError(null);
    }
  }, [isOpen, initialFirstName, initialLastName]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const inputError = memberNameInputError(firstName, lastName);
    if (inputError) {
      setError(inputError);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await setMemberName({ memberId, firstName, lastName });
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
    <Modal open={isOpen} onClose={handleClose} size="sm" title="Edit name" dismissible={!isSubmitting}>
      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="edit-first-name">First name</Label>
            <Input
              className="!text-base md:!text-sm"
              type="text"
              id="edit-first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={MEMBER_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={isSubmitting}
            />
          </div>
          <div>
            <Label htmlFor="edit-last-name">Last name</Label>
            <Input
              className="!text-base md:!text-sm"
              type="text"
              id="edit-last-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              maxLength={MEMBER_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={isSubmitting}
            />
          </div>
        </div>
        <p className="text-sm text-gray-500">{MEMBER_NAME_NOTE}</p>

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <ModalFooter>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
