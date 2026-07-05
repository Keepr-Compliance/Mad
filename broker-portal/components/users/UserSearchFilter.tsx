'use client';

/**
 * User Search and Filter Component
 *
 * Provides search and filter controls for the user list.
 * Filters by name/email search, role, and license status.
 *
 * TASK-1809: User list component implementation
 */

import { Card, SearchInput, Select } from '@keepr/design-system';
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
    <Card padding="sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* Search Input */}
        <div className="flex-1">
          <label htmlFor="user-search" className="sr-only">
            Search users
          </label>
          <SearchInput
            id="user-search"
            type="text"
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {/* Role Filter */}
        <div className="sm:w-40">
          <label htmlFor="role-filter" className="sr-only">
            Filter by role
          </label>
          <Select
            id="role-filter"
            value={roleFilter}
            onChange={(e) => onRoleChange(e.target.value)}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {/* Status Filter */}
        <div className="sm:w-40">
          <label htmlFor="status-filter" className="sr-only">
            Filter by status
          </label>
          <Select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => onStatusChange(e.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Card>
  );
}
