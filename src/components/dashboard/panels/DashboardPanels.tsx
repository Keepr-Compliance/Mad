/**
 * Recent | Todo — BACKLOG-3965 PR-4b (mock v6, option D).
 *
 * Side by side from 768 px (Tailwind md), one column below with Recent first.
 *
 * BACKLOG-3966 PR-3: both panels and the rings show on every plan. Main answers
 * Todo on every plan (My items always; template items only when the plan has
 * checklists), so the renderer no longer asks the plan gate before reading.
 * The gate decides one thing here: on a plan main said has no checklists
 * ("blocked"), Todo says template checklists aren't on the plan.
 */
import React from "react";
import { useSessionStrictFeatureState } from "../../../contexts/StrictFeatureContext";
import type { TransactionTab } from "../../transactionDetailsModule/types";
import { useDashboardPanels } from "./useDashboardPanels";
import { RecentPanel } from "./RecentPanel";
import { TodoPanel } from "./TodoPanel";

/** The grid with both panels: one column under 768 px, two from 768 px. */
export const PANELS_GRID_TWO = "grid grid-cols-1 md:grid-cols-2 gap-4";

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
  const { recent, todo, reload, tickItem, tickingItemId, tickError } = useDashboardPanels(userId);

  return (
    <div className={`mt-6 ${PANELS_GRID_TWO}`} data-testid="dashboard-panels">
      <RecentPanel
        state={recent}
        showProgress
        disabled={disabled}
        onOpenTransaction={(id) => onOpenTransaction(id, "overview")}
        onViewAll={onViewTransactions}
      />
      <TodoPanel
        state={todo}
        disabled={disabled}
        templateHint={gate === "blocked"}
        onOpenTransaction={(id) => onOpenTransaction(id, "checklist")}
        onRetry={reload}
        onTick={(itemId) => void tickItem(itemId)}
        tickingItemId={tickingItemId}
        tickError={tickError}
      />
    </div>
  );
}

export default DashboardPanels;
