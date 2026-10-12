'use client';

/**
 * User Search and Filter Component
 *
 * Provides search and filter controls for the user list.
 * Filters by name/email search, role, and license status.
 *
 * TASK-1809: User list component implementation
 */

import ListFilterCard from '@/components/ui/ListFilterCard';
import { ROLE_LABELS, LICENSE_STATUS_LABELS } from '@/lib/types/users';

interface UserSearchFilterProps {
  searchQuery: string;
  onSearchChange: (_value: string) => void;
  roleFilter: string;
  onRoleChange: (_value: string) => void;
  statusFilter: string;
  onStatusChange: (_value: string) => void;
}

const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Roles' },
  ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Statuses' },
  ...Object.entries(LICENSE_STATUS_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

export default function UserSearchFilter({
  searchQuery,
  onSearchChange,
  roleFilter,
  onRoleChange,
  statusFilter,
  onStatusChange,
}: UserSearchFilterProps) {
  return (
    <ListFilterCard
      search={{
        id: 'user-search',
        label: 'Search users',
        placeholder: 'Search by name or email...',
        value: searchQuery,
        onChange: onSearchChange,
      }}
      filters={[
        { id: 'role-filter', label: 'Filter by role', value: roleFilter, onChange: onRoleChange, options: ROLE_OPTIONS },
        { id: 'status-filter', label: 'Filter by status', value: statusFilter, onChange: onStatusChange, options: STATUS_OPTIONS },
      ]}
    />
  );
}
