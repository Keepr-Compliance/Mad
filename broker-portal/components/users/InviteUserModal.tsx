'use client';

/**
 * Invite User Modal Component
 *
 * Modal dialog for inviting new members to the organization.
 * Includes email input, role selection, and displays invite link on success.
 *
 * TASK-1810: Invite user modal and server action
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check } from 'lucide-react';
// Modal/ModalFooter/Input/Label/Select are Tier-2 (no @keepr/ui equivalent yet).
import { Input, Label, Modal, ModalFooter, Select } from '@keepr/design-system';
import { AlertBanner, Button } from '@keepr/ui';
import { inviteUser } from '@/lib/actions/inviteUser';
import OutOfLicensesNotice from './OutOfLicensesNotice';
import { ASSIGNABLE_ROLES_BY_ADMIN, ROLE_LABELS } from '@/lib/types/users';
import { inviteWithoutLicenseAvailable } from '@/lib/users/memberLicenseActions';
import { INVITE_NAME_MAX_LENGTH } from '@/lib/users/inviteNames';
import type { Role } from '@/lib/types/users';

// ============================================================================
// Types
// ============================================================================

interface InviteUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  organizationId: string;
  /** BACKLOG-3851: the caller's role picks the out-of-licenses wording. */
  callerRole?: string;
  /** BACKLOG-3851 PR-2f: for the prefilled "more licenses" support request. */
  organizationName?: string | null;
  /** BACKLOG-3851 PR-2f: "Invite without a license" offered (default: the release switches). */
  allowInviteWithoutLicense?: boolean;
}

// Roles that can be assigned via invite (excludes it_admin)
type InvitableRole = 'agent' | 'broker' | 'admin';

// ============================================================================
// Component
// ============================================================================

export default function InviteUserModal({
  isOpen,
  onClose,
  organizationId,
  callerRole = 'admin',
  organizationName = null,
  allowInviteWithoutLicense = inviteWithoutLicenseAvailable(),
}: InviteUserModalProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState<InvitableRole>('agent');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outOfSeats, setOutOfSeats] = useState(false);

  // BACKLOG-3851 PR-2f: withoutLicense re-sends the same form as an unlicensed invitation.
  const sendInvite = async (withoutLicense: boolean) => {
    setIsSubmitting(true);
    setError(null);
    setOutOfSeats(false);

    try {
      const result = await inviteUser({
        email,
        role,
        organizationId,
        firstName,
        lastName,
        ...(withoutLicense ? { withoutLicense: true } : {}),
      });

      if (result.outOfSeats) {
        // BACKLOG-3851: the form stays open; no invite was created.
        setOutOfSeats(true);
      } else if (result.error) {
        setError(result.error);
      } else if (result.inviteLink) {
        setInviteLink(result.inviteLink);
        setEmailSent(result.emailSent ?? false);
        router.refresh(); // Refresh the user list
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendInvite(false);
  };

  const handleClose = () => {
    setEmail('');
    setFirstName('');
    setLastName('');
    setRole('agent');
    setError(null);
    setOutOfSeats(false);
    setInviteLink(null);
    setEmailSent(false);
    setCopied(false);
    onClose();
  };

  const handleCopyLink = async () => {
    if (inviteLink) {
      try {
        await navigator.clipboard.writeText(inviteLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Fallback for older browsers
        setError('Failed to copy. Please select and copy manually.');
      }
    }
  };

  if (!isOpen) return null;

  // Filter to only invitable roles (agent, broker, admin - not it_admin)
  const invitableRoles = ASSIGNABLE_ROLES_BY_ADMIN.filter(
    (r): r is InvitableRole => r !== 'it_admin'
  );

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" title="Invite Team Member">
      {inviteLink ? (
        // Success state - varies based on whether email was sent
        <div className="space-y-4">
          {emailSent ? (
            <>
              <div className="flex items-center gap-2 text-green-600">
                <Check className="h-5 w-5" />
                <span className="font-medium">Invitation Email Sent</span>
              </div>

              <p className="text-sm text-gray-600">
                An invitation email has been sent to <strong>{email}</strong>.
                They will receive a link to join your organization.
              </p>

              <details className="text-sm">
                <summary className="text-gray-500 cursor-pointer hover:text-gray-700">
                  Or copy the invite link manually
                </summary>
                <div className="mt-2 bg-gray-50 p-3 rounded-md border border-gray-200">
                  <p className="break-all text-sm text-gray-800 font-mono">
                    {inviteLink}
                  </p>
                </div>
                <Button type="button" onClick={handleCopyLink} className="mt-2 w-full">
                  {copied ? 'Copied!' : 'Copy Link'}
                </Button>
              </details>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-yellow-600">
                <AlertTriangle className="h-5 w-5" />
                <span className="font-medium">Invitation Created</span>
              </div>

              <p className="text-sm text-gray-600">
                The invitation was created but the email could not be sent.
                Please share this link with <strong>{email}</strong> manually:
              </p>

              <div className="bg-gray-50 p-3 rounded-md border border-gray-200">
                <p className="break-all text-sm text-gray-800 font-mono">
                  {inviteLink}
                </p>
              </div>

              <Button type="button" onClick={handleCopyLink} className="w-full">
                {copied ? 'Copied!' : 'Copy Link'}
              </Button>
            </>
          )}

          <Button type="button" variant="secondary" onClick={handleClose} className="w-full">
            Done
          </Button>
        </div>
      ) : (
        // Form state
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* BACKLOG-3851 PR-2f: optional names, used in the email and shown until they sign in */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="invite-first-name">First name (optional)</Label>
              <Input
                className="!text-base md:!text-sm"
                type="text"
                id="invite-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                maxLength={INVITE_NAME_MAX_LENGTH}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="invite-last-name">Last name (optional)</Label>
              <Input
                className="!text-base md:!text-sm"
                type="text"
                id="invite-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                maxLength={INVITE_NAME_MAX_LENGTH}
                autoComplete="off"
              />
            </div>
          </div>

          {/* Email input */}
          <div>
            <Label htmlFor="invite-email">Email Address</Label>
            <Input
              className="!text-base md:!text-sm"
              type="email"
              id="invite-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="colleague@example.com"
              autoComplete="email"
            />
          </div>

          {/* Role select */}
          <div>
            <Label htmlFor="invite-role">Role</Label>
            <Select
              className="!text-base md:!text-sm"
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as InvitableRole)}
            >
              {invitableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r as Role]} - {getRoleDescription(r)}
                </option>
              ))}
            </Select>
          </div>

          {/* Error message */}
          {outOfSeats && (
            <OutOfLicensesNotice
              callerRole={callerRole}
              organizationName={organizationName}
              onInviteWithoutLicense={allowInviteWithoutLicense ? () => { void sendInvite(true); } : undefined}
              inviteWithoutLicensePending={isSubmitting}
            />
          )}
          {error && <AlertBanner variant="destructive">{error}</AlertBanner>}

          {/* Buttons */}
          <ModalFooter>
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !email}>
              {isSubmitting ? 'Inviting...' : 'Send Invite'}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get a short description for each role
 */
function getRoleDescription(role: InvitableRole): string {
  switch (role) {
    case 'agent':
      return 'Can submit transactions';
    case 'broker':
      return 'Can review submissions';
    case 'admin':
      return 'Full organization access';
    default:
      return '';
  }
}
