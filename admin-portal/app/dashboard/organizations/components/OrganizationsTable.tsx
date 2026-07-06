'use client';

/**
 * OrganizationsTable - Client component for filtering and displaying organizations
 *
 * Receives server-fetched data and provides client-side search filtering.
 * Each row links to the organization detail page.
 * Includes "Create Organization" button gated on canEdit prop.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Plus } from 'lucide-react';
import {
  Button,
  SearchInput,
  Table,
  TableBody,
  TableContainer,
  TableEmptyRow,
  TableHead,
  Td,
  Th,
  Tr,
} from '@keepr/design-system';
import { formatDate } from '@/lib/format';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan_name: string | null;
  plan_tier: string | null;
  created_at: string | null;
  member_count: number;
}

interface OrganizationsTableProps {
  organizations: OrganizationRow[];
  canEdit: boolean;
}

function PlanBadge({ name, tier }: { name: string | null; tier: string | null }) {
  const displayText = name || 'none';
  const tierKey = tier?.toLowerCase() || 'none';
  const colorMap: Record<string, string> = {
    enterprise: 'bg-purple-100 text-purple-800',
    professional: 'bg-primary-100 text-primary-800',
    starter: 'bg-blue-100 text-blue-800',
    trial: 'bg-yellow-100 text-yellow-800',
    none: 'bg-gray-100 text-gray-600',
  };
  const color = colorMap[tierKey] || 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {displayText}
    </span>
  );
}

export function OrganizationsTable({ organizations, canEdit }: OrganizationsTableProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const filtered = organizations.filter((org) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      org.name.toLowerCase().includes(q) ||
      org.slug.toLowerCase().includes(q)
    );
  });

  // Empty state - no organizations at all
  if (organizations.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <Building2 className="mx-auto h-12 w-12 text-gray-300" />
        <p className="mt-4 text-sm text-gray-500">
          No organizations found.
        </p>
      </div>
    );
  }

  const handleCreated = () => {
    setShowCreateDialog(false);
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {/* Search bar + Create button */}
      <div className="flex items-center gap-3">
        <SearchInput
          containerClassName="flex-1"
          placeholder="Filter by name or slug..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {canEdit && (
          <Button
            onClick={() => setShowCreateDialog(true)}
            className="whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            Create Organization
          </Button>
        )}
      </div>

      {/* Table */}
      <TableContainer>
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Slug</Th>
              <Th>Plan</Th>
              <Th>Members</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </TableHead>
          <TableBody>
            {filtered.length > 0 ? (
              filtered.map((org) => (
                <Tr
                  key={org.id}
                  clickable
                  onClick={() => router.push(`/dashboard/organizations/${org.id}`)}
                >
                  <Td>
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center">
                        <Building2 className="h-4 w-4" />
                      </div>
                      <span className="text-sm font-medium text-gray-900">
                        {org.name}
                      </span>
                    </div>
                  </Td>
                  <Td>{org.slug}</Td>
                  <Td>
                    <PlanBadge name={org.plan_name} tier={org.plan_tier} />
                  </Td>
                  <Td>{org.member_count}</Td>
                  <Td>{formatDate(org.created_at)}</Td>
                  <Td>
                    <span className="text-primary-600 hover:text-primary-800 font-medium">
                      View
                    </span>
                  </Td>
                </Tr>
              ))
            ) : (
              <TableEmptyRow colSpan={6}>
                No organizations match &apos;{searchQuery}&apos;
              </TableEmptyRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create Organization Dialog */}
      {showCreateDialog && (
        <CreateOrganizationDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
