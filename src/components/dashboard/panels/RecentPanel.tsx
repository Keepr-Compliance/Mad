/**
 * Recent — BACKLOG-3965 PR-4b (mock v6, option D, left panel).
 *
 * The deals this user opened most recently, newest first. A row opens the deal
 * on its Overview tab. The ring and "N of M" are the deal's REQUIRED checklist
 * items (PR-2's numbers, summed across every checklist on the deal), shown only
 * when the plan includes checklists.
 */
import React from "react";
import { ProgressRing } from "../../ui/ProgressRing";
import type { RecentState } from "./useDashboardPanels";
import { openedAgo, requiredProgressText } from "./panelFormat";
import { PanelCard, PanelMessage } from "./PanelCard";

export interface RecentPanelProps {
  state: RecentState;
  /** The plan includes checklists: show the ring and "N of M". */
  showProgress: boolean;
  /** Rows and the link are disabled while a sync runs. */
  disabled?: boolean;
  onOpenTransaction: (transactionId: string) => void;
  onViewAll: () => void;
  /** Injected in tests; defaults to the current time. */
  now?: Date;
}

export function RecentPanel({
  state,
  showProgress,
  disabled = false,
  onOpenTransaction,
  onViewAll,
  now,
}: RecentPanelProps): React.ReactElement {
  const at = now ?? new Date();
  return (
    <PanelCard
      title="Recent"
      testId="dashboard-recent"
      aside={
        <button
          type="button"
          onClick={onViewAll}
          disabled={disabled}
          className="text-sm font-medium text-primary-700 hover:underline whitespace-nowrap disabled:opacity-50"
        >
          All →
        </button>
      }
    >
      {state.status === "error" && <PanelMessage>Couldn&apos;t load recent deals.</PanelMessage>}
      {state.status === "ready" && state.rows.length === 0 && (
        <PanelMessage>Deals you open show here.</PanelMessage>
      )}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {state.rows.map((row) => {
            const ago = openedAgo(row.openedAt, at);
            const detail = showProgress
              ? [requiredProgressText(row.requiredDone, row.requiredTotal), ago].filter(Boolean).join(" · ")
              : ago;
            return (
              <li key={row.transactionId}>
                <button
                  type="button"
                  onClick={() => onOpenTransaction(row.transactionId)}
                  disabled={disabled}
                  data-testid="dashboard-recent-row"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {showProgress && <ProgressRing done={row.requiredDone} total={row.requiredTotal} />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-gray-900 truncate">
                      {row.propertyAddress || "No address"}
                    </span>
                    <span className="block text-xs text-gray-500">{detail}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}

export default RecentPanel;
