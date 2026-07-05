'use client';

/**
 * User Table Row Component
 *
 * Renders a single row in the users table (list view).
 * Includes checkbox for selection and action dropdown.
 */

import Link from 'next/link';
import Image from 'next/image';
import { Badge, Checkbox } from '@keepr/design-system';
import type { BadgeHue } from '@keepr/design-system';
import UserActionsDropdown from './UserActionsDropdown';
import { ROLE_LABELS, LICENSE_STATUS_LABELS } from '@/lib/types/users';
import type { MemberLicenseStatus, OrganizationMember, Role } from '@/lib/types/users';
import { formatUserDisplayName, getUserInitials } from '@/lib/utils/userDisplay';
import { formatDate } from '@/lib/utils';

interface UserTableRowProps {
  member: OrganizationMember;
  isSelected: boolean;
  isCurrentUser: boolean;
  canManage: boolean;
  onToggleSelect: () => void;
  onEditRole: () => void;
  onResendInvite: () => void;
  onDeactivate: () => void;
  onRemove: () => void;
}

const ROLE_HUES: Record<Role, BadgeHue> = {
  admin: 'purple',
  it_admin: 'blue',
  broker: 'green',
  agent: 'gray',
};

const STATUS_HUES: Record<MemberLicenseStatus, BadgeHue> = {
  active: 'green',
  pending: 'yellow',
  suspended: 'red',
  expired: 'gray',
};

export default function UserTableRow({
  member,
  isSelected,
  isCurrentUser,
  canManage,
  onToggleSelect,
  onEditRole,
  onResendInvite,
  onDeactivate,
  onRemove,
}: UserTableRowProps) {
  const userOrNull = member.user ?? null;
  const displayName = formatUserDisplayName(userOrNull, member.invited_email);
  const initials = getUserInitials(userOrNull, member.invited_email);
  const email = member.user?.email || member.invited_email || '';
  const isPending = !member.user_id;

  return (
    <tr className={`hover:bg-gray-50 transition-colors ${isSelected ? 'bg-primary-50' : ''}`}>
      {canManage && (
        <td className="w-12 px-4 py-3">
          <Checkbox checked={isSelected} onChange={onToggleSelect} />
        </td>
      )}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {member.user?.avatar_url ? (
              <Image
                src={member.user.avatar_url}
                alt={displayName}
                width={32}
                height={32}
                className="rounded-full object-cover"
              />
            ) : (
              <span className="text-gray-500 text-xs font-medium">{initials}</span>
            )}
          </div>
          <div className="min-w-0">
            <Link
              href={`/dashboard/users/${member.id}`}
              className="text-sm font-medium text-gray-900 hover:text-primary-600 truncate block transition-colors"
            >
              {displayName}
              {isCurrentUser && <span className="text-xs text-gray-500 ml-1">(You)</span>}
            </Link>
            <p className="text-xs text-gray-500 truncate">{email}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge size="sm" hue={ROLE_HUES[member.role]}>{ROLE_LABELS[member.role]}</Badge>
      </td>
      <td className="px-4 py-3">
        <Badge size="sm" hue={STATUS_HUES[member.license_status]}>
          {isPending ? 'Invited' : LICENSE_STATUS_LABELS[member.license_status]}
        </Badge>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">
        {member.joined_at
          ? formatDate(member.joined_at)
          : isPending && member.invited_at
          ? `Invited ${formatDate(member.invited_at)}`
          : member.invited_at
          ? formatDate(member.invited_at)
          : '-'}
      </td>
      {canManage && (
        <td className="w-12 px-4 py-3">
          {!isCurrentUser && (
            <UserActionsDropdown
              memberId={member.id}
              memberName={displayName}
              isPending={isPending}
              isCurrentUser={isCurrentUser}
              invitationToken={member.invitation_token}
              onEditRole={onEditRole}
              onResendInvite={onResendInvite}
              onDeactivate={onDeactivate}
              onRemove={onRemove}
            />
          )}
        </td>
      )}
    </tr>
  );
}
