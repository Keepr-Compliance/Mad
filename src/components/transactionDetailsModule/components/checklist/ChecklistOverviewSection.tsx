/**
 * ChecklistOverviewSection — BACKLOG-3476, the one-line progress on Overview.
 *
 * Rendered by TransactionDetails only when the Checklist tab is shown AND a
 * checklist exists, so the Overview never points at a tab that is not there.
 */
import React from "react";
import type { ChecklistDetail } from "../../../../../electron/types/checklist";
import { ChecklistProgress } from "./ChecklistProgress";

interface ChecklistOverviewSectionProps {
  detail: ChecklistDetail;
  onOpen: () => void;
}

export function ChecklistOverviewSection({
  detail,
  onOpen,
}: ChecklistOverviewSectionProps): React.ReactElement {
  return (
    <div className="mb-8" data-testid="overview-checklist">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
            />
          </svg>
          Checklist
        </h4>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <div className="flex-1 basis-56">
          <ChecklistProgress requiredDone={detail.requiredDone} requiredTotal={detail.requiredTotal} />
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-medium text-blue-600 hover:text-blue-800"
          data-testid="overview-open-checklist"
        >
          Open Checklist
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-1">
        {detail.checklist.templateName} &middot; {detail.items.length} item{detail.items.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export default ChecklistOverviewSection;
