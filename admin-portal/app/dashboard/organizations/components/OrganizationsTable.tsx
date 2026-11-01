'use client';

/**
 * OrganizationsTable - Client component for filtering and displaying organizations
 *
 * Receives server-fetched data. BACKLOG-4098: Type (brokerages by default),
 * Plan, "Show test organizations", search and column sort, all mirrored into
 * the URL (lib/organizations/org-list.ts holds the rules).
 * Each row links to the organization detail page.
 * Includes "Create Organization" button gated on canEdit prop.
 */

import { useMemo, useState } from 'react';
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
import { Checkbox, Dropdown, SortableTh, useReportUrlState } from '@keepr/ui';
import { formatDate } from '@/lib/format';
import { startNavigationProgress } from '@/components/pwa/NavigationProgress';
import { CreateOrganizationDialog } from './CreateOrganizationDialog';
import {
  DEFAULT_ORG_LIST_STATE,
  ORG_LIST_CODEC,
  filterOrgs,
  flagsAvailable,
  planOptions,
  showAllState,
  sortAfterClick,
  sortOrgs,
  type OrgListState,
  type OrgSortKey,
  type OrgTypeFilter,
} from '@/lib/organizations/org-list';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan_name: string | null;
  plan_tier: string | null;
  created_at: string | null;
  member_count: number;
  /** Personal organization. null or absent when the list RPC did not return the flag. */
  is_personal?: boolean | null;
  /** Test organization. null or absent when the list RPC did not return the flag. */
  is_test?: boolean | null;
}

interface OrganizationsTableProps {
  organizations: OrganizationRow[];
  canEdit: boolean;
  /** Brokerage billing is live: Create Organization does not ask for Max Seats. */
  billingLive: boolean;
  /** Filters, search and sort parsed from the URL by the page. Defaults when absent. */
  initialState?: OrgListState;
}

const TYPE_OPTIONS: Array<{ value: OrgTypeFilter; label: string }> = [
  { value: 'brokerages', label: 'Brokerages' },
  { value: 'personal', label: 'Personal' },
  { value: 'all', label: 'All' },
];

/** Same look as the design-system Th, so sortable and plain headers match in one row. */
const SORTABLE_TH_CLASS = 'px-6 py-3 text-xs uppercase tracking-wider';

const SHOW_TEST_ID = 'org-list-show-test';

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

export function OrganizationsTable({ organizations, canEdit, billingLive, initialState }: OrganizationsTableProps) {
  const router = useRouter();
  const [state, setState] = useReportUrlState(ORG_LIST_CODEC, initialState ?? DEFAULT_ORG_LIST_STATE);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const haveFlags = useMemo(() => flagsAvailable(organizations), [organizations]);
  const plans = useMemo(() => planOptions(organizations), [organizations]);
  const visible = useMemo(
    () => sortOrgs(filterOrgs(organizations, state, haveFlags), state.sort),
    [organizations, state, haveFlags]
  );

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

  const onSort = (key: OrgSortKey) => setState((s) => sortAfterClick(s, key));
  const sortProps = { activeKey: state.sort.key, direction: state.sort.direction, onSort, className: SORTABLE_TH_CLASS };
  const total = organizations.length;
  const query = state.q.trim();

  return (
    <div className="space-y-4">
      {/* Search, filters + Create button */}
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <SearchInput
          containerClassName="flex-1 min-w-[12rem]"
          placeholder="Filter by name or slug..."
          value={state.q}
          onChange={(e) => {
            const q = e.target.value;
            setState((s) => ({ ...s, q }));
          }}
        />
        <Dropdown
          variant="filter"
          ariaLabel="Type"
          searchable={false}
          options={TYPE_OPTIONS}
          value={state.type}
          disabled={!haveFlags}
          onChange={(type) => setState((s) => ({ ...s, type }))}
        />
        <Dropdown
          mode="multi"
          variant="filter"
          ariaLabel="Plan"
          options={plans}
          value={state.plan}
          onChange={(plan) => setState((s) => ({ ...s, plan }))}
          onClear={() => setState((s) => ({ ...s, plan: [] }))}
        />
        <label htmlFor={SHOW_TEST_ID} className="flex items-center gap-2 text-sm text-gray-700 whitespace-nowrap">
          <Checkbox
            id={SHOW_TEST_ID}
            checked={state.showTest}
            disabled={!haveFlags}
            onCheckedChange={(checked) => setState((s) => ({ ...s, showTest: checked === true }))}
          />
          Show test organizations
        </label>
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

      <div className="space-y-1">
        <p className="text-sm text-gray-500" data-testid="org-list-count">
          {visible.length} of {total} organization{total !== 1 ? 's' : ''}
        </p>
        {!haveFlags && (
          <p className="text-sm text-amber-700" role="note">
            Type and test filters are unavailable: this list did not include the personal and test flags.
          </p>
        )}
      </div>

      {/* Table */}
      <TableContainer scrollX>
        <Table>
          <TableHead>
            <tr>
              <SortableTh sortKey="name" {...sortProps}>Name</SortableTh>
              <Th>Slug</Th>
              <SortableTh sortKey="plan" {...sortProps}>Plan</SortableTh>
              <SortableTh sortKey="members" {...sortProps}>Members</SortableTh>
              <SortableTh sortKey="created" {...sortProps}>Created</SortableTh>
              <Th>Actions</Th>
            </tr>
          </TableHead>
          <TableBody>
            {visible.length > 0 ? (
              visible.map((org) => (
                <Tr
                  key={org.id}
                  clickable
                  onClick={() => {
                    startNavigationProgress();
                    router.push(`/dashboard/organizations/${org.id}`);
                  }}
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
                <div className="space-y-2">
                  <p>
                    {query
                      ? <>No organizations match &apos;{query}&apos;</>
                      : 'No organizations match these filters.'}
                  </p>
                  <button
                    type="button"
                    className="text-sm font-medium text-primary-600 hover:text-primary-800"
                    onClick={() => setState((s) => showAllState(s))}
                  >
                    Show all organizations
                  </button>
                </div>
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
          billingLive={billingLive}
        />
      )}
    </div>
  );
}
