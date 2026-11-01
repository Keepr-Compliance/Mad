/**
 * Todo — BACKLOG-3965 PR-4b (mock v6, option D, right panel; founder: "Todo").
 *
 * Required checklist items not yet ticked, across the user's active, unlocked
 * deals (PR-3's read). The panel renders an ORDERED LIST of groups
 * (`visibleTodoGroups`): 3965 ships one, the required items; a group with no
 * rows and no status line renders nothing. A row opens its deal on the
 * Checklist tab. Its checkbox ticks the item through
 * `checklists:set-item-checked`, which main refuses on a locked deal or a plan
 * without checklists; the row then stays and shows main's reason.
 *
 * The header count is the uncapped `totalCount`, which can exceed the rows
 * read (at most 50), so "Show more" never promises every row.
 */
import React, { useState } from "react";
import type {
  OpenRequiredChecklistItem,
  TodoGroup,
} from "../../../../electron/types/checklistTodo";
import {
  requiredItemsGroup,
  visibleTodoGroups,
} from "../../../services/todoGroups";
import type { TickError, TodoState } from "./useDashboardPanels";
import { closingBadge, daysUntilClosing, localDay } from "./panelFormat";
import { PanelCard, PanelMessage } from "./PanelCard";

/** Rows shown before "Show more" (UI rule: lists of 3-5). */
export const TODO_VISIBLE_ROWS = 5;

const BADGE_TONE_CLASS = {
  danger: "bg-danger-100 text-danger-800",
  warning: "bg-warning-100 text-warning-800",
} as const;

export interface TodoPanelProps {
  state: TodoState;
  disabled?: boolean;
  onOpenTransaction: (transactionId: string) => void;
  onRetry: () => void;
  onTick: (itemId: string) => void;
  tickingItemId?: string | null;
  tickError?: TickError | null;
  /**
   * BACKLOG-3966 PR-3: the plan has no checklists, so Todo holds My items only.
   * Says so where the template items would have been. U1: the sentence comes
   * from `templateChecklistHint` (src/utils/checklistPlanHint.ts), the same one
   * the Checklist tab shows; null shows nothing.
   */
  templateHint?: string | null;
  /** Injected in tests; defaults to the current time. */
  now?: Date;
}

interface RowActions {
  disabled: boolean;
  onOpenTransaction: (transactionId: string) => void;
  onTick: (itemId: string) => void;
  tickingItemId: string | null;
  tickError: TickError | null;
}

function TodoRow({
  row,
  today,
  actions,
}: {
  row: OpenRequiredChecklistItem;
  today: string;
  actions: RowActions;
}): React.ReactElement {
  const { disabled, onOpenTransaction, onTick, tickingItemId, tickError } =
    actions;
  const badge = closingBadge(daysUntilClosing(row.closingDeadline, today));
  const error =
    tickError && tickError.itemId === row.itemId ? tickError.message : null;
  return (
    <li
      className="px-3 py-3 bg-white hover:bg-gray-50 min-w-0"
      data-testid="dashboard-todo-row"
    >
      <div className="flex items-center gap-3 min-w-0">
        <input
          type="checkbox"
          checked={false}
          onChange={() => onTick(row.itemId)}
          disabled={disabled || tickingItemId === row.itemId}
          aria-label={`Mark done: ${row.title}`}
          className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 shrink-0"
        />
        <button
          type="button"
          onClick={() => onOpenTransaction(row.transactionId)}
          disabled={disabled}
          className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-gray-900 truncate">
              {row.title}
            </span>
            <span className="block text-xs text-gray-500 truncate">
              {row.propertyAddress || "No address"}
            </span>
          </span>
          {badge && (
            <span
              data-testid="closing-badge"
              data-tone={badge.tone}
              className={`inline-flex items-center rounded-full text-xs font-medium py-0.5 px-2.5 whitespace-nowrap ${BADGE_TONE_CLASS[badge.tone]}`}
            >
              {badge.label}
            </span>
          )}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-1 pl-7 text-xs text-danger-700"
          data-testid="dashboard-todo-tick-error"
        >
          {error}
        </p>
      )}
    </li>
  );
}

function TodoGroupView({
  group,
  showHeader,
  today,
  actions,
}: {
  group: TodoGroup<OpenRequiredChecklistItem>;
  showHeader: boolean;
  today: string;
  actions: RowActions;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? group.rows : group.rows.slice(0, TODO_VISIBLE_ROWS);
  const hidden = group.rows.length - rows.length;
  return (
    <div data-testid="dashboard-todo-group" data-group-id={group.id}>
      {showHeader && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 border-y border-gray-200 text-xs font-semibold text-gray-600">
          <span className="truncate">{group.header}</span>
          <span className="tabular-nums">{group.count}</span>
        </div>
      )}
      {group.status !== null && <PanelMessage>{group.status}</PanelMessage>}
      {rows.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {rows.map((row) => (
            <TodoRow
              key={row.itemId}
              row={row}
              today={today}
              actions={actions}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-4 py-2 text-sm font-medium text-primary-700 hover:underline border-t border-gray-100"
        >
          Show more
        </button>
      )}
      {expanded && group.count > group.rows.length && (
        <p
          className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100"
          data-testid="dashboard-todo-partial"
        >
          Showing {group.rows.length} of {group.count}. Open a deal to see the
          rest.
        </p>
      )}
    </div>
  );
}

export function TodoPanel({
  state,
  disabled = false,
  onOpenTransaction,
  onRetry,
  onTick,
  tickingItemId = null,
  tickError = null,
  templateHint = null,
  now,
}: TodoPanelProps): React.ReactElement {
  const actions: RowActions = {
    disabled,
    onOpenTransaction,
    onTick,
    tickingItemId,
    tickError,
  };
  const today = localDay(now ?? new Date());
  const groups =
    state.status === "ready"
      ? visibleTodoGroups([requiredItemsGroup(state.data)])
      : [];
  return (
    <PanelCard
      title="Todo"
      testId="dashboard-todo"
      aside={
        state.status === "ready" ? (
          <span
            className="text-sm font-medium text-primary-700 whitespace-nowrap"
            data-testid="dashboard-todo-count"
          >
            {state.data.totalCount} required
          </span>
        ) : undefined
      }
    >
      {state.status === "error" && (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-gray-500">
            Couldn&apos;t load your checklist items.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-sm font-medium text-primary-700 hover:underline"
          >
            Try again
          </button>
        </div>
      )}
      {state.status === "ready" && groups.length === 0 && (
        <PanelMessage>Nothing required left.</PanelMessage>
      )}
      {groups.map((group) => (
        <TodoGroupView
          key={group.id}
          group={group}
          showHeader={groups.length > 1}
          today={today}
          actions={actions}
        />
      ))}
      {templateHint && state.status !== "off" && (
        <p
          className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100"
          data-testid="dashboard-todo-template-hint"
        >
          {templateHint}
        </p>
      )}
    </PanelCard>
  );
}

export default TodoPanel;
