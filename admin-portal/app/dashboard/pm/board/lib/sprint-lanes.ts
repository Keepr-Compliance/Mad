/**
 * sprint-lanes -- Pure helpers for the board's Sprint mode (BACKLOG-4196).
 *
 * Sprint mode shows every item of one project, one row per sprint that holds
 * at least one of those items, plus a final "No sprint" row. Dragging a card
 * to another row moves the item to that sprint; "No sprint" clears it. A
 * completed or cancelled sprint is never a drop target.
 *
 * Kept free of JSX / React so it can be unit tested directly.
 */

import type { BoardColumns, ItemStatus, PmBacklogItem, PmSprint, SprintStatus } from '@/lib/pm-types';
import { NO_SPRINT_KEY } from './swim-lane-ids';

export interface SprintLane {
  /** Sprint id, or NO_SPRINT_KEY for the last row. */
  key: string;
  /** The sprint from the loaded sprint list; null for "No sprint" or an unknown id. */
  sprint: PmSprint | null;
  /** Items in this row, by status. */
  columns: BoardColumns;
}

function emptyColumns(): BoardColumns {
  return {
    pending: [],
    in_progress: [],
    testing: [],
    pending_uat: [],
    waiting_for_user: [],
    completed: [],
    blocked: [],
    deferred: [],
    obsolete: [],
    reopened: [],
  };
}

/** Row order of sprint statuses; a sprint missing from the list sorts after these. */
const STATUS_RANK: Record<SprintStatus, number> = {
  active: 0,
  planned: 1,
  completed: 2,
  cancelled: 3,
};
const UNKNOWN_RANK = 4;

/** Sprint statuses that refuse drops and quick-adds. */
export function isClosedSprint(sprint: PmSprint): boolean {
  return sprint.status === 'completed' || sprint.status === 'cancelled';
}

/** Row an item belongs to: its sprint id, or "No sprint". */
export function sprintLaneKeyForItem(item: PmBacklogItem): string {
  return item.sprint_id || NO_SPRINT_KEY;
}

/** Row title: "legacy_id — name", the name alone, or the raw id when unknown. */
export function sprintLaneLabel(key: string, sprint: PmSprint | null): string {
  if (key === NO_SPRINT_KEY) return 'No sprint';
  if (!sprint) return key;
  return sprint.legacy_id ? `${sprint.legacy_id} — ${sprint.name}` : sprint.name;
}

function compareLanes(a: SprintLane, b: SprintLane): number {
  const rankA = a.sprint ? STATUS_RANK[a.sprint.status] ?? UNKNOWN_RANK : UNKNOWN_RANK;
  const rankB = b.sprint ? STATUS_RANK[b.sprint.status] ?? UNKNOWN_RANK : UNKNOWN_RANK;
  if (rankA !== rankB) return rankA - rankB;
  // start_date ascending, sprints without one after those with one.
  const dateA = a.sprint?.start_date ?? null;
  const dateB = b.sprint?.start_date ?? null;
  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA < dateB ? -1 : 1;
  }
  return sprintLaneLabel(a.key, a.sprint).localeCompare(sprintLaneLabel(b.key, b.sprint));
}

/**
 * Group board columns into sprint rows: one row per sprint on the loaded
 * items, ordered active, planned, completed, cancelled, unknown, then by
 * start_date. "No sprint" is always present and always last.
 */
export function groupColumnsBySprint(columns: BoardColumns, sprints: PmSprint[]): SprintLane[] {
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  const lanesByKey = new Map<string, SprintLane>();
  const noSprint: SprintLane = { key: NO_SPRINT_KEY, sprint: null, columns: emptyColumns() };

  for (const [status, list] of Object.entries(columns)) {
    for (const item of (list ?? []) as PmBacklogItem[]) {
      const key = sprintLaneKeyForItem(item);
      let lane = key === NO_SPRINT_KEY ? noSprint : lanesByKey.get(key);
      if (!lane) {
        lane = { key, sprint: sprintById.get(key) ?? null, columns: emptyColumns() };
        lanesByKey.set(key, lane);
      }
      // A status key this build does not know (a newer RPC) gets its own list instead of throwing.
      const laneCols = lane.columns as unknown as Record<string, PmBacklogItem[] | undefined>;
      (laneCols[status] ??= []).push(item);
    }
  }

  const ordered = Array.from(lanesByKey.values()).sort(compareLanes);
  ordered.push(noSprint);
  return ordered;
}

export interface SprintDropPlan {
  /** New status, set only when the column changed. */
  status: ItemStatus | null;
  /** New sprint, set only when the row changed. null sprintId clears it. */
  sprint: { sprintId: string | null } | null;
}

/** A drop the board refuses: nothing is written and `message` is shown. */
export interface SprintDropRefusal {
  refused: string;
}

export const CLOSED_SPRINT_MESSAGE = (label: string) =>
  `Cannot move items into ${label}: the sprint is closed.`;
export const UNKNOWN_SPRINT_MESSAGE =
  'Cannot move the item: that sprint is not in the sprint list. Try Refresh.';

/**
 * Decide what a Sprint-mode drop writes. Returns null for a no-op (nothing
 * changed), a refusal for a closed or unknown target sprint, or a plan.
 * Row change is decided by comparing ROW KEYS. Only the TARGET is checked:
 * moving an item out of a closed sprint is allowed.
 */
export function resolveSprintDrop(params: {
  item: PmBacklogItem;
  currentStatus: ItemStatus;
  targetLaneKey: string;
  targetStatus: ItemStatus;
  sprints: PmSprint[];
}): SprintDropPlan | SprintDropRefusal | null {
  const { item, currentStatus, targetLaneKey, targetStatus, sprints } = params;
  const laneChanged = sprintLaneKeyForItem(item) !== targetLaneKey;
  const statusChanged = currentStatus !== targetStatus;
  if (!laneChanged && !statusChanged) return null;

  if (laneChanged && targetLaneKey !== NO_SPRINT_KEY) {
    const target = sprints.find((s) => s.id === targetLaneKey);
    if (!target) return { refused: UNKNOWN_SPRINT_MESSAGE };
    if (isClosedSprint(target)) return { refused: CLOSED_SPRINT_MESSAGE(sprintLaneLabel(target.id, target)) };
  }

  return {
    status: statusChanged ? targetStatus : null,
    sprint: laneChanged ? { sprintId: targetLaneKey === NO_SPRINT_KEY ? null : targetLaneKey } : null,
  };
}

export function isSprintDropRefusal(
  value: SprintDropPlan | SprintDropRefusal | null
): value is SprintDropRefusal {
  return !!value && 'refused' in value;
}
