/**
 * The desktop status board's lanes — BACKLOG-3914.
 *
 * The four open lanes ARE the dashboard's stat cards (lib/dashboard/statCards.ts):
 * same keys, labels and list `status` values, so a lane's count is the card's
 * number and its "View all" link opens the list with exactly that lane's deals.
 * Approved and Rejected are two more lanes, hidden until the viewer asks.
 *
 * Membership is the list's own rule (headMatchesFilter on the deal head,
 * lib/submissions/dealList.ts), applied to the heads the list already holds
 * (org gate and search applied), so nothing here reads data.
 */

import { STAT_CARDS } from '@/lib/dashboard/statCards';
import { headMatchesFilter } from './dealList';

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

/** Cards shown per lane; a longer lane ends with "View all N", the list filtered to it. */
export const LANE_CARD_CAP = 20;

export interface LaneSet {
  lane: BoardLane;
  /** Every deal in the lane, in the board's sort order. */
  total: number;
  /** The first `cap` of them: the cards shown. */
  ids: string[];
}

/** Each lane's deals among `heads` (already scoped and searched), filtered by `match`, sorted. */
export function laneSets<H extends { id: string; status: string | null }>(
  heads: readonly H[],
  lanes: readonly BoardLane[],
  match: (_head: H) => boolean,
  compare: (_a: H, _b: H) => number,
  cap: number = LANE_CARD_CAP,
): LaneSet[] {
  return lanes.map((lane) => {
    const inLane = heads.filter((h) => headMatchesFilter(h.status, lane.value) && match(h)).sort(compare);
    return { lane, total: inLane.length, ids: inLane.slice(0, cap).map((h) => h.id) };
  });
}
