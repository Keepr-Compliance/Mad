'use client';

/**
 * User Actions Dropdown Component
 *
 * Provides a three-dot menu for user actions (deactivate, remove).
 * Only visible to admin/it_admin users, not shown for self.
 *
 * TASK-1812: Deactivate/Remove user flow
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { MoreVertical } from 'lucide-react';
import { getInvitationLink } from '@/lib/actions/getInvitationLink';

interface UserActionsDropdownProps {
  memberId: string;
  memberName: string;
  isPending: boolean; // No user_id yet (pending invite)
  isCurrentUser: boolean;
  organizationId: string;
  onEditRole?: () => void;
  onResendInvite?: () => void;
  onDeactivate: () => void;
  onRemove: () => void;
}

export default function UserActionsDropdown({
  memberId,
  memberName,
  isPending,
  isCurrentUser,
  organizationId,
  onEditRole,
  onResendInvite,
  onDeactivate,
  onRemove,
}: UserActionsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // The invite token is fetched on demand rather than shipped with every row
  // (BACKLOG-3541) — this is a live invite-acceptance URL, not an inert id.
  const handleCopyInviteLink = useCallback(async () => {
    try {
      const result = await getInvitationLink({ memberId, organizationId });
      if (result.success && result.inviteLink) {
        await navigator.clipboard.writeText(result.inviteLink);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      }
    } catch {
      // silent fail
    }
    setIsOpen(false);
  }, [memberId, organizationId]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on Escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  // Don't render for current user
  if (isCurrentUser) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 rounded-full hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
        aria-label={`Actions for ${memberName}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <MoreVertical className="h-5 w-5 text-gray-500" />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-10"
          role="menu"
          aria-orientation="vertical"
        >
          {/* Copy Invite Link - for pending invites. Every pending row has a
              token (inviteUser.ts always sets one on creation); fetched via
              getInvitationLink on click rather than checked here. */}
          {isPending && (
            <button
              onClick={handleCopyInviteLink}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              role="menuitem"
            >
              {linkCopied ? 'Copied!' : 'Copy Invite Link'}
            </button>
          )}
          {/* Resend Invite - for pending invites */}
          {isPending && onResendInvite && (
            <button
              onClick={() => {
                setIsOpen(false);
                onResendInvite();
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              role="menuitem"
            >
              Resend Invite
            </button>
          )}
          {/* Edit Role - for active members */}
          {onEditRole && !isPending && (
            <button
              onClick={() => {
                setIsOpen(false);
                onEditRole();
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              role="menuitem"
            >
              Edit Role
            </button>
          )}
          {/* Deactivate - only for active members, not pending invites */}
          {!isPending && (
            <button
              onClick={() => {
                setIsOpen(false);
                onDeactivate();
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              role="menuitem"
            >
              Deactivate User
            </button>
          )}
          {/* Remove - for both active members and pending invites */}
          <button
            onClick={() => {
              setIsOpen(false);
              onRemove();
            }}
            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
            role="menuitem"
          >
            {isPending ? 'Revoke Invitation' : 'Remove from Organization'}
          </button>
        </div>
      )}
    </div>
  );
}
