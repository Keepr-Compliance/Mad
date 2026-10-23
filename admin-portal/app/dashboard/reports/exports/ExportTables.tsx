'use client';

/**
 * Exports report — per-user table, per-organization table and the user
 * drill-down (BACKLOG-4004). Both tables show Exports and Unique exports, from
 * the same filtered set as the cards and the chart.
 */

import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react';
import {
  ORG_SORT_LABELS,
  shortDeal,
  USER_SORT_LABELS,
  type ExportEvent,
  type ExportOrgRow,
  type ExportOrgSortKey,
  type ExportUserRow,
  type ExportUserSortKey,
  type SortDirection,
} from '@/lib/reports/exports';

function SortHeader<K extends string>({
  column,
  label,
  align,
  sortKey,
  sortDirection,
  onSort,
}: {
  column: K;
  label: string;
  align: 'left' | 'right';
  sortKey: K;
  sortDirection: SortDirection;
  onSort: (key: K) => void;
}) {
  const active = sortKey === column;
  const Icon = !active ? ArrowUpDown : sortDirection === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`whitespace-nowrap py-2 px-3 font-medium text-gray-500 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

const USER_COLUMNS: { key: ExportUserSortKey; align: 'left' | 'right' }[] = [
  { key: 'user', align: 'left' },
  { key: 'org', align: 'left' },
  { key: 'exports', align: 'right' },
  { key: 'unique', align: 'right' },
  { key: 'formats', align: 'left' },
  { key: 'first', align: 'left' },
  { key: 'last', align: 'left' },
];

const ORG_COLUMNS: { key: ExportOrgSortKey; align: 'left' | 'right' }[] = [
  { key: 'org', align: 'left' },
  { key: 'exports', align: 'right' },
  { key: 'unique', align: 'right' },
  { key: 'users', align: 'right' },
];

export interface ExportUserTableProps {
  rows: ExportUserRow[];
  visibleCount: number;
  sortKey: ExportUserSortKey;
  sortDirection: SortDirection;
  openUserKey: string | null;
  /** The open user's events, oldest first. */
  openEvents: ExportEvent[];
  truncated: boolean;
  rowCap: number;
  periodLabel: string;
  onSort: (key: ExportUserSortKey) => void;
  onShowMore: () => void;
  onToggleUser: (key: string) => void;
}

export function ExportUserTable({
  rows,
  visibleCount,
  sortKey,
  sortDirection,
  openUserKey,
  openEvents,
  truncated,
  rowCap,
  periodLabel,
  onSort,
  onShowMore,
  onToggleUser,
}: ExportUserTableProps) {
  const visible = rows.slice(0, visibleCount);
  const more = rows.length - visible.length;
  const openRow = rows.find((r) => r.key === openUserKey) ?? null;

  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-gray-900">Exports per user</h2>

      {truncated ? (
        <div
          className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          data-notice="truncated"
        >
          <strong>This period holds more exports than are shown.</strong> The query returns the{' '}
          {rowCap} most recent exports and {periodLabel.toLowerCase()} reached that cap — every count
          and chart on this page is therefore a floor, not a total. Narrow the period to see all of it.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="font-medium text-gray-900">No exports in this period</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Nothing matched {periodLabel.toLowerCase()} with the filters you have set. That is a real
            zero, not a failure to read — widen the period or clear a filter.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm" data-table="users">
            <thead>
              <tr className="border-b border-gray-200">
                {USER_COLUMNS.map((c) => (
                  <SortHeader
                    key={c.key}
                    column={c.key}
                    label={USER_SORT_LABELS[c.key]}
                    align={c.align}
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.key}
                  data-user-row={r.key}
                  onClick={() => onToggleUser(r.key)}
                  className={`cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 ${
                    openUserKey === r.key ? 'bg-primary-50' : ''
                  }`}
                >
                  <td className="py-2 px-3 text-gray-900">{r.label}</td>
                  <td className="py-2 px-3 text-gray-700">{r.orgLabel}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="exports">
                    {r.exports}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="unique">
                    {r.unique}
                  </td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{r.formats}</td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{r.first}</td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{r.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-500">
            Showing {visible.length} of {rows.length} {rows.length === 1 ? 'user' : 'users'}
          </p>
          {more > 0 ? (
            <button
              type="button"
              onClick={onShowMore}
              className="text-sm font-medium text-primary-600 hover:text-primary-800"
            >
              Show more
            </button>
          ) : null}
        </div>
      ) : null}

      {openRow ? (
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-user-detail={openRow.key}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {openRow.label} · {openRow.exports} exports · {openRow.unique} unique
            </h3>
            <div className="flex items-center gap-3">
              {openRow.userId ? (
                <Link
                  href={`/dashboard/users/${openRow.userId}`}
                  className="text-sm text-primary-600 hover:text-primary-800"
                >
                  Open user
                </Link>
              ) : null}
              <button
                type="button"
                onClick={() => onToggleUser(openRow.key)}
                className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Close
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-1 px-2 font-medium">When (UTC)</th>
                <th className="py-1 px-2 font-medium">Format</th>
                <th className="py-1 px-2 font-medium">Deal</th>
                <th className="py-1 px-2 font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {openEvents.map((e) => (
                <tr key={e.id} data-event-row={e.id} className="border-b border-gray-100 last:border-0">
                  <td className="whitespace-nowrap py-1 px-2 text-gray-700">{e.whenUtc}</td>
                  <td className="py-1 px-2 text-gray-700">{e.format}</td>
                  <td className="py-1 px-2 font-mono text-xs text-gray-700">{shortDeal(e.dealId)}</td>
                  <td className="py-1 px-2 text-gray-700">{e.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export interface ExportOrgTableProps {
  rows: ExportOrgRow[];
  sortKey: ExportOrgSortKey;
  sortDirection: SortDirection;
  onSort: (key: ExportOrgSortKey) => void;
}

export function ExportOrgTable({ rows, sortKey, sortDirection, onSort }: ExportOrgTableProps) {
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Exports per organization</h2>
      <p className="mb-3 text-xs text-gray-500">
        A user in two organizations counts in each, so these rows can add up to more than the cards.
        Organization is the user&apos;s membership today, not at the time of the export.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No exports in this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm" data-table="orgs">
            <thead>
              <tr className="border-b border-gray-200">
                {ORG_COLUMNS.map((c) => (
                  <SortHeader
                    key={c.key}
                    column={c.key}
                    label={ORG_SORT_LABELS[c.key]}
                    align={c.align}
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-org-row={r.key} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 px-3 text-gray-900">{r.label}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="exports">
                    {r.exports}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="unique">
                    {r.unique}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="users">
                    {r.users}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
