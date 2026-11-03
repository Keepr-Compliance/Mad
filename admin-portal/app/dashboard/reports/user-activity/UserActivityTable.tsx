'use client';

/**
 * User Activity report — user table (BACKLOG-3720)
 *
 * Every column sortable both ways. Header, row-cap notice and footer come
 * from the @keepr/ui report kit.
 */

import Link from 'next/link';
import { ShowMoreFooter, SortableTh, TruncationNotice } from '@keepr/ui';
import {
  EDITED_DEFINITION,
  LATEST_ONLY_NOTE,
  USER_ACTIVITY_SORT_SPECS,
  type SortDirection,
  type UserActivityRow,
  type UserActivitySortKey,
} from '@/lib/reports/user-activity';

const COLUMNS: { key: UserActivitySortKey; align: 'left' | 'right' }[] = [
  { key: 'user', align: 'left' },
  { key: 'org', align: 'left' },
  { key: 'lastSignIn', align: 'left' },
  { key: 'lastSeen', align: 'left' },
  { key: 'devices', align: 'right' },
  { key: 'active', align: 'left' },
  { key: 'created', align: 'right' },
  { key: 'edited', align: 'right' },
  { key: 'submissions', align: 'right' },
  { key: 'exports', align: 'right' },
];

export interface UserActivityTableProps {
  rows: UserActivityRow[];
  visibleCount: number;
  sortKey: UserActivitySortKey;
  sortDirection: SortDirection;
  truncated: boolean;
  rowCap: number;
  periodLabel: string;
  showMoreStep: number;
  orphanEventCount: number;
  onSort: (key: UserActivitySortKey) => void;
  onShowMore: () => void;
}

export function UserActivityTable({
  rows,
  visibleCount,
  sortKey,
  sortDirection,
  truncated,
  rowCap,
  periodLabel,
  showMoreStep,
  orphanEventCount,
  onSort,
  onShowMore,
}: UserActivityTableProps) {
  const visible = rows.slice(0, visibleCount);

  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Users</h2>
      <p className="mb-3 text-xs text-gray-500" data-latest-note>
        {LATEST_ONLY_NOTE} Transactions edited: {EDITED_DEFINITION} Internal staff are not listed.
      </p>

      {truncated ? (
        <TruncationNotice
          noun="activity events"
          capPhrase={`at most ${rowCap} events`}
          periodLabel={periodLabel}
          scope="every period column and card"
        />
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="font-medium text-gray-900">No users match</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Nothing matched the filters you have set. Clear a filter to see every user.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                {COLUMNS.map((column) => (
                  <SortableTh
                    key={column.key}
                    sortKey={column.key}
                    activeKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    align={column.align}
                    className="whitespace-nowrap"
                  >
                    {USER_ACTIVITY_SORT_SPECS[column.key].label}
                  </SortableTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.userId}
                  data-user-row={r.userId}
                  className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                >
                  <td className="py-2 px-3">
                    <Link href={`/dashboard/users/${r.userId}`} className="text-gray-900 hover:text-primary-700">
                      {r.userLabel}
                    </Link>
                    <div className="text-xs text-gray-500">{r.email}</div>
                  </td>
                  <td className="py-2 px-3 text-gray-700">{r.orgLabel}</td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700" data-cell="last-sign-in">
                    {r.lastSignInUtc}
                  </td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700" data-cell="last-seen">
                    {r.lastSeenUtc}
                  </td>
                  <td className="whitespace-nowrap py-2 px-3 text-right tabular-nums text-gray-700" data-cell="devices">
                    {r.activeDevices} / {r.totalDevices}
                    <div className="text-xs text-gray-500">{r.platforms}</div>
                  </td>
                  <td className="py-2 px-3 text-gray-700" data-cell="active">
                    {r.activeInPeriod ? 'Yes' : 'No'}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="created">
                    {r.transactionsCreated}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="edited">
                    {r.transactionsEdited}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="submissions">
                    {r.submissions}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="exports">
                    {r.exports}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ShowMoreFooter
        shown={visible.length}
        total={rows.length}
        noun={{ one: 'user', other: 'users' }}
        step={showMoreStep}
        onShowMore={onShowMore}
      />

      {orphanEventCount > 0 ? (
        <p className="mt-3 text-xs text-gray-500" data-orphan-note>
          {orphanEventCount} {orphanEventCount === 1 ? 'event' : 'events'} in this period from users no
          longer in Keepr are not shown.
        </p>
      ) : null}
    </section>
  );
}
