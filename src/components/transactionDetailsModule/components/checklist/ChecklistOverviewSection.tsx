/**
 * ChecklistOverviewSection — BACKLOG-3476, the one-line progress on Overview.
 *
 * Rendered by TransactionDetails only when the Checklist tab is shown AND at
 * least one checklist exists, so the Overview never points at a tab that is
 * not there. The progress is main's sum across every checklist.
 */
import React from "react";
import type { ChecklistsForTransaction } from "../../../../../electron/types/checklist";
import { ChecklistProgress } from "./ChecklistProgress";

interface ChecklistOverviewSectionProps {
  data: ChecklistsForTransaction;
  onOpen: () => void;
}

export function ChecklistOverviewSection({
  data,
  onOpen,
}: ChecklistOverviewSectionProps): React.ReactElement {
  const count = data.checklists.length;
  const caption =
    count === 1
      ? `${data.checklists[0].checklist.templateName} · ${data.checklists[0].items.length} item${
          data.checklists[0].items.length === 1 ? "" : "s"
        }`
      : `${count} checklists`;
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
          {count === 1 ? "Checklist" : "Checklists"}
        </h4>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        <div className="flex-1 basis-56">
          <ChecklistProgress requiredDone={data.requiredDone} requiredTotal={data.requiredTotal} />
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
      <p className="text-xs text-gray-400 mt-1" data-testid="overview-checklist-caption">
        {caption}
      </p>
    </div>
  );
}

export default ChecklistOverviewSection;
