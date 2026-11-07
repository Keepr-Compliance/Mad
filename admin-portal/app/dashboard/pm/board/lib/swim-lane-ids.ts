/**
 * swim-lane-ids -- Pure helpers for encoding / decoding swim-lane droppable IDs.
 *
 * Kept free of JSX / React imports so they can be unit tested under the
 * vitest `*.test.ts` include pattern.
 *
 * Droppable id format (structured):
 *
 *   cell:dim=<project|area|assignee|epic|label>:key=<groupKey>:status=<status>
 *
 * In Project mode the board shows one row per epic (BACKLOG-4176); those
 * cells use `dim=epic` with the epic's id as key, or NO_EPIC_KEY.
 *
 * In Label mode (BACKLOG-4196) an item with several labels is shown in every
 * label's row, so one item can have several cards on screen. Each copy gets
 * its own sortable id, `card:<itemId>:lane=<groupKey>`; itemIdFromSortableId
 * turns it back into the item id.
 */

import type { ItemStatus } from '@/lib/pm-types';

/** Legacy drop target id, still re-exported by KanbanBoard; no longer rendered. */
export const SWIM_LANE_NEW_PROJECT_ID = 'swimlane-new-project';

/** Row key for items in Project mode that have no epic parent in the project. */
export const NO_EPIC_KEY = 'No Epic';

/** Row key for items in Label mode that have no label. */
export const NO_LABEL_KEY = 'No label';

export type SwimLaneDimension = 'project' | 'area' | 'assignee' | 'epic' | 'label';

/** Every swim-lane mode the board can show (the selector's values). */
export const SWIM_LANE_MODES = ['off', 'project', 'area', 'assignee', 'label'] as const;

/** True for a value that is one of SWIM_LANE_MODES (e.g. a persisted one). */
export function isSwimLaneMode(value: unknown): value is (typeof SWIM_LANE_MODES)[number] {
  return typeof value === 'string' && (SWIM_LANE_MODES as readonly string[]).includes(value);
}

/** Sortable id for one copy of an item's card in a lane. */
export function buildCardSortableId(itemId: string, groupKey: string): string {
  return `card:${itemId}:lane=${groupKey}`;
}

/**
 * The item id behind a sortable / droppable id. A lane copy id
 * (`card:<itemId>:lane=<key>`) gives its item id; any other id (a plain item
 * id, a cell id, a column id, 'backlog-panel') is returned unchanged.
 */
export function itemIdFromSortableId(id: string): string {
  const match = id.match(/^card:([^:]+):lane=[^:]+$/);
  return match ? match[1] : id;
}

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
    /^cell:dim=(project|area|assignee|epic|label):key=([^:]+):status=([a-z_]+)$/
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
