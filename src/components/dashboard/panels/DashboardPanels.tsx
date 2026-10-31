/**
 * Recent | Todo — BACKLOG-3965 PR-4b (mock v6, option D).
 *
 * Side by side from 768 px (Tailwind md), one column below with Recent first.
 * Todo shows only when the plan gate answered "allowed"; otherwise Recent
 * takes the whole row (no empty right column) and shows no rings.
 */
import React from "react";
import { useSessionStrictFeatureState } from "../../../contexts/StrictFeatureContext";
import type { TransactionTab } from "../../transactionDetailsModule/types";
import { useDashboardPanels } from "./useDashboardPanels";
import { RecentPanel } from "./RecentPanel";
import { TodoPanel } from "./TodoPanel";

/** The grid with both panels: one column under 768 px, two from 768 px. */
export const PANELS_GRID_TWO = "grid grid-cols-1 md:grid-cols-2 gap-4";
/** The grid when Todo is hidden: Recent spans the row. */
export const PANELS_GRID_ONE = "grid grid-cols-1 gap-4";

export interface DashboardPanelsProps {
  userId: string;
  /** The ONE helper from AppRouter: writes the open request and opens the view. */
  onOpenTransaction: (transactionId: string, tab: TransactionTab) => void;
  onViewTransactions: () => void;
  disabled?: boolean;
}

export function DashboardPanels({
  userId,
  onOpenTransaction,
  onViewTransactions,
  disabled = false,
}: DashboardPanelsProps): React.ReactElement {
  const gate = useSessionStrictFeatureState("transaction_checklists");
  const checklistsAllowed = gate === "allowed";
  const { recent, todo, reload } = useDashboardPanels(userId, checklistsAllowed);

  return (
    <div className={`mt-6 ${checklistsAllowed ? PANELS_GRID_TWO : PANELS_GRID_ONE}`} data-testid="dashboard-panels">
      <RecentPanel
        state={recent}
        showProgress={checklistsAllowed}
        disabled={disabled}
        onOpenTransaction={(id) => onOpenTransaction(id, "overview")}
        onViewAll={onViewTransactions}
      />
      {checklistsAllowed && (
        <TodoPanel
          state={todo}
          disabled={disabled}
          onOpenTransaction={(id) => onOpenTransaction(id, "checklist")}
          onRetry={reload}
        />
      )}
    </div>
  );
}

export default DashboardPanels;
