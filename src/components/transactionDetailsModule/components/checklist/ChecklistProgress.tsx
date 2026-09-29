/**
 * ChecklistProgress — BACKLOG-3476.
 *
 * "N of M required done" and a bar. Shared by the Checklist tab and the
 * Overview line so the two can never disagree. It renders main's counts
 * (`ChecklistDetail.requiredDone` / `requiredTotal`) and computes nothing:
 * optional items are not part of progress, and only main decides which are
 * which.
 */
import React from "react";

interface ChecklistProgressProps {
  requiredDone: number;
  requiredTotal: number;
}

export function ChecklistProgress({
  requiredDone,
  requiredTotal,
}: ChecklistProgressProps): React.ReactElement {
  const pct = requiredTotal > 0 ? Math.round((requiredDone / requiredTotal) * 100) : 0;
  return (
    <div className="flex items-center gap-3 flex-wrap" data-testid="checklist-progress">
      <span
        className="text-sm font-medium text-gray-700 tabular-nums whitespace-nowrap"
        data-testid="checklist-progress-text"
      >
        {requiredTotal > 0
          ? `${requiredDone} of ${requiredTotal} required done`
          : "No required items"}
      </span>
      <span
        className="flex-1 basis-36 min-w-[120px] h-1.5 rounded-full bg-gray-200 overflow-hidden"
        role="progressbar"
        aria-label="Required items done"
        aria-valuemin={0}
        aria-valuemax={requiredTotal}
        aria-valuenow={requiredDone}
      >
        <span className="block h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export default ChecklistProgress;
