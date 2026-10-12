/**
 * The phone status board's lanes — BACKLOG-3914.
 *
 * The four open lanes ARE the dashboard's stat cards (lib/dashboard/statCards.ts):
 * same keys, labels and list `status` values, so a lane's count is the card's
 * number and the list its link opens. Approved and Rejected are two more lanes,
 * hidden until the viewer asks for them.
 *
 * A lane is a status filter value: the board is the Submissions list with the
 * status set to the lane, so membership, counting, search, agent, sort and the
 * org gate are the list's own (lib/submissions/dealList.ts).
 */

import { STAT_CARDS } from '@/lib/dashboard/statCards';

export interface BoardLane {
  /** The list's `status` value for this lane. */
  value: string;
  label: string;
  /** A head status, for the count pill colour (getStatusColor). */
  colorStatus: string;
  /** Approved / Rejected: shown only after "Show approved and rejected". */
  closed: boolean;
}

export const OPEN_LANES: readonly BoardLane[] = STAT_CARDS.map((def) => ({
  value: def.filter as string,
  label: def.label,
  colorStatus: def.statuses?.[0] ?? def.key,
  closed: false,
}));

export const CLOSED_LANES: readonly BoardLane[] = [
  { value: 'approved', label: 'Approved', colorStatus: 'approved', closed: true },
  { value: 'rejected', label: 'Rejected', colorStatus: 'rejected', closed: true },
];

export const BOARD_LANES: readonly BoardLane[] = [...OPEN_LANES, ...CLOSED_LANES];

export const DEFAULT_LANE = OPEN_LANES[0].value;

/** The lane a status value names; any other value (incl. 'all') is the first lane, New. */
export function boardLaneFor(status: string | null | undefined): string {
  return BOARD_LANES.some((l) => l.value === status) ? (status as string) : DEFAULT_LANE;
}
