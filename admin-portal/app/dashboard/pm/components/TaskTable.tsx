'use client';

/**
 * TaskTable - PM Backlog
 *
 * Renders the backlog items as a table with pagination.
 * Supports checkbox selection for bulk operations and tree indentation.
 * Each row navigates to the item detail page on click.
 * Column headers are clickable to sort by that column.
 * Status, Priority, Type, Assignee, and Area columns support inline editing.
 */

import { Table, TableHead, TableBody, Checkbox, PaginationBar, PaginationButton } from '@keepr/design-system';
import type { PmBacklogItem, SortableColumn, SortDirection } from '@/lib/pm-types';
import { SortableHeader } from './TaskTableHeader';
import { TaskTableRow } from './TaskTableRow';
import type { AssignableUser } from './InlineAssigneePicker';

// Re-export AssignableUser for backward compatibility
export type { AssignableUser } from './InlineAssigneePicker';

interface TaskTableProps {
  items: PmBacklogItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  searchActive?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  treeMode?: boolean;
  sortBy?: SortableColumn | null;
  sortDir?: SortDirection;
  onSort?: (column: SortableColumn) => void;
  /** Build a custom URL for each item row. Defaults to `/dashboard/pm/tasks/${itemId}`. */
  buildItemUrl?: (itemId: string) => string;
  /** Map of user ID -> { display_name, email } for resolving assignee names. */
  userMap?: Map<string, { display_name: string | null; email: string }>;
  /** Callback invoked after any inline edit mutation succeeds. */
  onItemUpdated?: () => void;
  /** List of assignable users for the assignee dropdown. */
  users?: AssignableUser[];
  /**
   * When true, each row exposes a grip handle that emits a dnd-kit draggable
   * with `data = { type: 'sprint-item', item }`. Off by default so other
   * callsites (backlog, my-tasks, search) remain unaffected.
   */
  enableDrag?: boolean;
}

export function TaskTable({
  items,
  totalCount,
  page,
  pageSize,
  totalPages,
  onPageChange,
  loading,
  selectedIds,
  onSelectionChange,
  treeMode,
  sortBy,
  sortDir,
  onSort,
  buildItemUrl,
  userMap,
  onItemUpdated,
  users,
  enableDrag = false,
}: TaskTableProps) {
  const editable = !!onItemUpdated;

  function getItemUrl(itemId: string): string {
    if (buildItemUrl) return buildItemUrl(itemId);
    return `/dashboard/pm/tasks/${itemId}`;
  }

  const allSelected = items.length > 0 && selectedIds?.size === items.length &&
    items.every((item) => selectedIds?.has(item.id));

  function toggleAll() {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(items.map((item) => item.id)));
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="animate-pulse">
          <div className="h-12 bg-gray-50 border-b border-gray-200" />
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-14 border-b border-gray-100 px-6 py-4">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
        <p className="text-gray-500 text-sm">No backlog items found.</p>
      </div>
    );
  }

  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);

  const paginationControls = (position: 'top' | 'bottom') => (
    <PaginationBar position={position}>
      <div className="text-sm text-gray-500">
        Showing {startItem}-{endItem} of {totalCount}
      </div>
      <div className="flex items-center gap-2">
        <PaginationButton
          direction="prev"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </PaginationButton>
        <span className="text-sm text-gray-500">
          Page {page} of {totalPages}
        </span>
        <PaginationButton
          direction="next"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </PaginationButton>
      </div>
    </PaginationBar>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {totalPages > 1 && paginationControls('top')}
      <div className="overflow-x-auto">
        <Table>
          <TableHead>
            <tr>
              {enableDrag && <th className="w-8 pl-2 pr-1" aria-hidden />}
              {onSelectionChange && (
                <th className="px-4 py-3 w-10">
                  <Checkbox checked={allSelected} onChange={toggleAll} />
                </th>
              )}
              <SortableHeader column="item_number" label="ID" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="title" label="Title" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="type" label="Type" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="status" label="Status" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="priority" label="Priority" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Assignee
              </th>
              <SortableHeader column="area" label="Area" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="est_tokens" label="Est" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
              <SortableHeader column="created_at" label="Created" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
            </tr>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TaskTableRow
                key={item.id}
                item={item}
                itemUrl={getItemUrl(item.id)}
                editable={editable}
                treeMode={treeMode}
                selectedIds={selectedIds}
                onSelectionChange={onSelectionChange}
                onItemUpdated={onItemUpdated}
                users={users}
                userMap={userMap}
                draggable={enableDrag}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {paginationControls('bottom')}
    </div>
  );
}
