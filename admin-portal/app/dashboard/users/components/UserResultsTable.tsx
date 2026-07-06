'use client';

/**
 * UserResultsTable - Displays search results in a table format
 *
 * Handles three states: empty (no query), loading (skeleton), and no results.
 * Each row links to the user detail page at /dashboard/users/[id].
 */

import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';
import {
  TableContainer,
  Table,
  TableHead,
  TableBody,
  Tr,
  Th,
  Td,
  TableEmptyRow,
} from '@keepr/design-system';
import { getUserDisplayName, type AdminSearchUser } from '@/lib/admin-queries';

interface UserResultsTableProps {
  users: AdminSearchUser[] | null;
  query: string;
  isLoading: boolean;
  error: string | null;
}

function UserAvatar({ name, avatarUrl }: { name: string | null; avatarUrl: string | null }) {
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name || 'User avatar'}
        className="h-8 w-8 rounded-full object-cover"
      />
    );
  }

  return (
    <div className="h-8 w-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-xs font-medium">
      {initials}
    </div>
  );
}

function OrgBadges({ orgName }: { orgName: string | null }) {
  if (!orgName) {
    return <span className="text-gray-400">&mdash;</span>;
  }

  const orgs = orgName.split(', ').filter(Boolean);

  return (
    <div className="flex flex-wrap gap-1">
      {orgs.map((org) => (
        <span
          key={org}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-50 text-primary-700"
        >
          {org}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const statusText = status || 'unknown';
  const isActive = statusText.toLowerCase() === 'active';

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        isActive
          ? 'bg-success-50 text-success-600'
          : 'bg-gray-100 text-gray-600'
      }`}
    >
      {statusText}
    </span>
  );
}

function formatLastLogin(dateStr: string | null): string {
  if (!dateStr) return 'Never';

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-gray-200" />
              <div className="h-4 w-32 bg-gray-200 rounded" />
            </div>
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="h-4 w-40 bg-gray-200 rounded" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="h-4 w-24 bg-gray-200 rounded" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="h-4 w-16 bg-gray-200 rounded" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="h-5 w-14 bg-gray-200 rounded-full" />
          </td>
          <td className="px-6 py-4 whitespace-nowrap">
            <div className="h-4 w-20 bg-gray-200 rounded" />
          </td>
        </tr>
      ))}
    </>
  );
}

export function UserResultsTable({ users, query, isLoading, error }: UserResultsTableProps) {
  const router = useRouter();

  // Error state
  if (error) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-danger-500/20 p-8 text-center">
        <p className="text-danger-600 text-sm">{error}</p>
      </div>
    );
  }

  // Empty state — no query entered yet
  if (!query) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <Users className="mx-auto h-12 w-12 text-gray-300" />
        <p className="mt-4 text-sm text-gray-500">
          Search for users by name, email, organization, or user ID
        </p>
      </div>
    );
  }

  // Table wrapper (shared by loading and results states)
  return (
    <TableContainer>
      <Table>
        <TableHead>
          <Tr>
            <Th>
              Name
            </Th>
            <Th>
              Email
            </Th>
            <Th>
              Organization
            </Th>
            <Th>
              Role
            </Th>
            <Th>
              Status
            </Th>
            <Th>
              Last Login
            </Th>
          </Tr>
        </TableHead>
        <TableBody>
          {isLoading ? (
            <SkeletonRows />
          ) : users && users.length > 0 ? (
            users.map((user) => (
              <Tr
                key={user.id}
                onClick={() => router.push(`/dashboard/users/${user.id}`)}
                clickable
              >
                <Td emphasis="primary">
                  <div className="flex items-center gap-3">
                    <UserAvatar name={getUserDisplayName(user)} avatarUrl={user.avatar_url} />
                    <span className="text-sm font-medium text-gray-900">
                      {getUserDisplayName(user)}
                    </span>
                  </div>
                </Td>
                <Td>
                  {user.email || '--'}
                </Td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  <OrgBadges orgName={user.org_name || user.org_slug} />
                </td>
                <Td>
                  {user.org_role || '--'}
                </Td>
                <Td>
                  <StatusBadge status={user.status} />
                </Td>
                <Td>
                  {formatLastLogin(user.last_login_at)}
                </Td>
              </Tr>
            ))
          ) : (
            <TableEmptyRow colSpan={6}>
              No users found for &apos;{query}&apos;
            </TableEmptyRow>
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
