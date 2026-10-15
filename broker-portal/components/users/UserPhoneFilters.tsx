'use client';

/**
 * Users phone filters (below md) — BACKLOG-3904.
 *
 * The shared phone bar (search + Role / Status buttons) and results row
 * ("Showing X of Y users", Invite user, Clear filters) from @keepr/ui, with a
 * bottom sheet per filter. State stays in UserListClient; this only presents it.
 * The filters and their options are the desktop ones (UserSearchFilter).
 */

import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { BottomSheet, Button, PhoneClearFilters, PhoneFilterBar, PhoneResultsRow } from '@keepr/ui';
import { ROLE_LABELS, LICENSE_STATUS_LABELS } from '@/lib/types/users';

export const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Roles' },
  ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
];

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Statuses' },
  ...Object.entries(LICENSE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

interface Props {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  roleFilter: string;
  onRoleChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  /** Members matching (X) and all members (Y). */
  shown: number;
  total: number;
  /** Members that would match a role and status, with the search applied. */
  countFor: (role: string, status: string) => number;
  hasFilters: boolean;
  onClearAll: () => void;
  /** Present only when the viewer may invite. */
  onInvite?: () => void;
}

function usersText(n: number): string {
  return `${n} user${n === 1 ? '' : 's'}`;
}

export default function UserPhoneFilters(p: Props) {
  const [sheet, setSheet] = useState<'role' | 'status' | null>(null);
  const [pending, setPending] = useState('all');

  function open(which: 'role' | 'status') {
    setPending(which === 'role' ? p.roleFilter : p.statusFilter);
    setSheet(which);
  }

  const options = sheet === 'status' ? STATUS_OPTIONS : ROLE_OPTIONS;
  const shownInSheet = sheet === 'role' ? p.countFor(pending, p.statusFilter) : p.countFor(p.roleFilter, pending);
  const label = (opts: typeof ROLE_OPTIONS, v: string) => opts.find((o) => o.value === v)?.label ?? v;

  const action: ReactNode = (
    <>
      {p.hasFilters ? <PhoneClearFilters onClick={p.onClearAll} /> : null}
      {p.onInvite ? (
        <Button onClick={p.onInvite} className="h-11 px-3">
          <Plus className="h-4 w-4" />
          Invite user
        </Button>
      ) : null}
    </>
  );

  return (
    <PhoneFilterBar
      className="md:hidden"
      search={{
        id: 'user-search-phone',
        label: 'Search users',
        placeholder: 'Search by name or email...',
        value: p.searchQuery,
        onChange: p.onSearchChange,
        onClear: () => p.onSearchChange(''),
      }}
      filters={[
        {
          label: 'Role',
          value: label(ROLE_OPTIONS, p.roleFilter),
          active: p.roleFilter !== 'all',
          expanded: sheet === 'role',
          onClick: () => open('role'),
        },
        {
          label: 'Status',
          value: label(STATUS_OPTIONS, p.statusFilter),
          active: p.statusFilter !== 'all',
          expanded: sheet === 'status',
          onClick: () => open('status'),
        },
      ]}
      results={
        <PhoneResultsRow
          shown={p.shown}
          total={p.total}
          noun="user"
          action={p.hasFilters || p.onInvite ? action : null}
        />
      }
    >
      <BottomSheet
        open={sheet !== null}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet === 'status' ? 'Status' : 'Role'}
        headerAction={
          <button
            type="button"
            onClick={() => setPending('all')}
            className="min-h-11 px-2 text-sm font-semibold text-primary-700"
          >
            Clear
          </button>
        }
        primaryAction={
          <button
            type="button"
            onClick={() => {
              if (sheet === 'role') p.onRoleChange(pending);
              if (sheet === 'status') p.onStatusChange(pending);
              setSheet(null);
            }}
            className="flex min-h-12 w-full items-center justify-center rounded-lg bg-primary-600 text-base font-semibold text-white"
          >
            Show {usersText(shownInSheet)}
          </button>
        }
      >
        {sheet ? (
          <fieldset className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
            <legend className="sr-only">{sheet === 'status' ? 'Status' : 'Role'}</legend>
            {options.map((o) => (
              <label
                key={o.value}
                className={`flex min-h-12 items-center gap-3 px-3 text-base text-gray-900 ${pending === o.value ? 'bg-primary-50' : 'bg-white'}`}
              >
                <input
                  type="radio"
                  name={`users-${sheet}`}
                  value={o.value}
                  checked={pending === o.value}
                  aria-label={o.label}
                  onChange={() => setPending(o.value)}
                  className="h-5 w-5 accent-primary-600"
                />
                <span className="flex-1 truncate">{o.label}</span>
                <span className="text-sm text-gray-500">
                  {sheet === 'role' ? p.countFor(o.value, p.statusFilter) : p.countFor(p.roleFilter, o.value)}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </BottomSheet>
    </PhoneFilterBar>
  );
}
