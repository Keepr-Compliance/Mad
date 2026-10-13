/**
 * Desktop status board for broker Submissions — BACKLOG-3914.
 *
 * Read-only: lanes side by side, each a status with its deal count, holding
 * the shared SubmissionCard (a link to the submission). No drag, no status
 * action. A lane shows at most LANE_CARD_CAP cards; a longer lane ends with
 * "View all N", the list filtered to that lane. Approved and Rejected appear
 * only after "Show approved and rejected" (?closed=1).
 *
 * Shown from md up only; the caller's root is max-md:hidden.
 */

import Link from 'next/link';
import { getStatusColor } from '@/lib/utils';
import { SubmissionCard, type SubmissionCardData } from '@/components/submission/SubmissionCard';
import type { BoardLane } from '@/lib/submissions/boardLanes';

export interface BoardLaneData {
  lane: BoardLane;
  total: number;
  cards: Array<SubmissionCardData & { submitted_by?: string | null }>;
  /** The list filtered to this lane (search, agent, sort kept). */
  viewAllHref: string;
}

export function SubmissionBoard({
  lanes,
  closedShown,
  closedCount,
  toggleClosedHref,
  agentLabels,
}: {
  lanes: BoardLaneData[];
  closedShown: boolean;
  /** Approved + Rejected deals under the current search and agent. */
  closedCount: number;
  toggleClosedHref: string;
  agentLabels: ReadonlyMap<string, string>;
}) {
  return (
    <div className="space-y-3" data-slot="submission-board">
      <div className="flex justify-end">
        <Link
          href={toggleClosedHref}
          data-slot="board-toggle-closed"
          className="rounded-sm text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          {closedShown ? 'Hide approved and rejected' : `Show approved and rejected (${closedCount})`}
        </Link>
      </div>
      <div className="grid auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2" data-slot="board-lanes">
        {lanes.map(({ lane, total, cards, viewAllHref }) => {
          const headingId = `board-lane-${lane.value}`;
          return (
            <section
              key={lane.value}
              aria-labelledby={headingId}
              data-lane={lane.value}
              data-count={total}
              className="flex min-w-0 flex-col rounded-lg border border-gray-200 bg-gray-50 p-3"
            >
              <h2 id={headingId} className="mb-3 flex items-center justify-between gap-2 text-sm font-semibold text-gray-900">
                <span>{lane.label}</span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(lane.colorStatus)}`}
                  aria-label={`${total} submission${total === 1 ? '' : 's'}`}
                >
                  {total}
                </span>
              </h2>
              {cards.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-500" data-slot="board-lane-empty">
                  No submissions
                </p>
              ) : (
                <div className="flex flex-col gap-2" data-slot="board-lane-cards">
                  {cards.map((s) => (
                    <SubmissionCard
                      key={s.id}
                      submission={s}
                      agent={s.submitted_by ? agentLabels.get(s.submitted_by) : undefined}
                    />
                  ))}
                </div>
              )}
              {total > cards.length ? (
                <Link
                  href={viewAllHref}
                  data-slot="board-lane-view-all"
                  className="mt-3 rounded-sm text-center text-sm font-medium text-primary-700 hover:text-primary-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  View all {total}
                </Link>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
