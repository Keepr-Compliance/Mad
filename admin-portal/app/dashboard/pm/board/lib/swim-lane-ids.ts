/**
 * swim-lane-ids -- Pure helpers for encoding / decoding swim-lane droppable IDs.
 *
 * Kept free of JSX / React imports so they can be unit tested under the
 * vitest `*.test.ts` include pattern.
 *
 * Droppable id format (structured):
 *
 *   cell:dim=<project|area|assignee|epic>:key=<groupKey>:status=<status>
 *
 * In Project mode the board shows one row per epic (BACKLOG-4176); those
 * cells use `dim=epic` with the epic's id as key, or NO_EPIC_KEY.
 */

import type { ItemStatus } from '@/lib/pm-types';

/** Legacy drop target id, still re-exported by KanbanBoard; no longer rendered. */
export const SWIM_LANE_NEW_PROJECT_ID = 'swimlane-new-project';

/** Row key for items in Project mode that have no epic parent in the project. */
export const NO_EPIC_KEY = 'No Epic';

export type SwimLaneDimension = 'project' | 'area' | 'assignee' | 'epic';

export interface ParsedSwimLaneCell {
  dimension: SwimLaneDimension;
  groupKey: string;
  status: ItemStatus;
}

/** Build a structured swim-lane cell droppable id. */
export function buildSwimLaneCellId(
  dimension: SwimLaneDimension,
  groupKey: string,
  status: ItemStatus
): string {
  return `cell:dim=${dimension}:key=${groupKey}:status=${status}`;
}

/** Valid column statuses that can appear in a swim-lane cell id. */
const VALID_STATUSES = new Set<string>([
  'pending',
  'in_progress',
  'testing',
  'pending_uat',
  'waiting_for_user',
  'completed',
  'blocked',
  'deferred',
  'obsolete',
  'reopened',
]);

/** Parse a structured swim-lane cell droppable id, or null if not a cell id. */
export function parseSwimLaneCellId(overId: string): ParsedSwimLaneCell | null {
  if (!overId.startsWith('cell:')) return null;
  // Key uses `[^:]+` (not `.*`) so that an embedded `:status=` inside a
  // groupKey cannot confuse the parse. All current groupKeys (UUIDs,
  // "No Project", "No Area", "Unassigned", area/assignee names) are colon-
  // free; any id carrying a `:` in the key is malformed and returns null.
  const match = overId.match(
    /^cell:dim=(project|area|assignee|epic):key=([^:]+):status=([a-z_]+)$/
  );
  if (!match) return null;
  const [, dimension, groupKey, status] = match;
  if (!VALID_STATUSES.has(status)) return null;
  return {
    dimension: dimension as SwimLaneDimension,
    groupKey,
    status: status as ItemStatus,
  };
}
