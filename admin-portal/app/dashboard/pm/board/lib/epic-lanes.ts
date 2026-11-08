/**
 * epic-lanes -- Pure helpers for the board's Project mode (BACKLOG-4176).
 *
 * Project mode shows every item of one project, one row per epic plus a
 * final "No epic" row. Epics are rows, never cards.
 *
 * Kept free of JSX / React so it can be unit tested directly.
 */

import type { BoardColumns, ItemStatus, PmBacklogItem } from '@/lib/pm-types';
import { NO_EPIC_KEY } from './swim-lane-ids';

export interface EpicLane {
  /** Epic id, or NO_EPIC_KEY for the last row. */
  key: string;
  /** The epic this row represents; null for the "No epic" row. */
  epic: PmBacklogItem | null;
  /** Set when the epic is itself a child of another epic in the project. */
  parentEpic: PmBacklogItem | null;
  /** Non-epic items in this row, by status. */
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

function allItems(columns: BoardColumns): PmBacklogItem[] {
  return Object.values(columns).flat() as PmBacklogItem[];
}

function byOrder(a: PmBacklogItem, b: PmBacklogItem): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.item_number - b.item_number;
}

/** Ids of every epic present in the board columns. */
export function collectEpicIds(columns: BoardColumns): Set<string> {
  const ids = new Set<string>();
  for (const item of allItems(columns)) {
    if (item.type === 'epic') ids.add(item.id);
  }
  return ids;
}

/**
 * Row an item belongs to: its parent when the parent is an epic on this
 * board, otherwise "No epic" (no parent, a non-epic parent, or an epic in
 * another project).
 */
export function laneKeyForItem(item: PmBacklogItem, epicIds: Set<string>): string {
  return item.parent_id && epicIds.has(item.parent_id) ? item.parent_id : NO_EPIC_KEY;
}

/**
 * Group board columns into epic rows. Every epic gets a row even when empty.
 * Rows are ordered by sort_order then item_number; a sub-epic's row follows
 * its parent epic's row. "No epic" is always last.
 */
export function groupColumnsByEpic(columns: BoardColumns): EpicLane[] {
  const items = allItems(columns);
  const epics = items.filter((i) => i.type === 'epic').sort(byOrder);
  const epicById = new Map(epics.map((e) => [e.id, e]));
  const epicIds = new Set(epicById.keys());

  const lanesByKey = new Map<string, EpicLane>();
  for (const epic of epics) {
    const parent = epic.parent_id ? epicById.get(epic.parent_id) ?? null : null;
    lanesByKey.set(epic.id, { key: epic.id, epic, parentEpic: parent, columns: emptyColumns() });
  }
  const noEpic: EpicLane = { key: NO_EPIC_KEY, epic: null, parentEpic: null, columns: emptyColumns() };

  for (const [status, list] of Object.entries(columns)) {
    for (const item of list as PmBacklogItem[]) {
      if (item.type === 'epic') continue;
      const key = laneKeyForItem(item, epicIds);
      const lane = lanesByKey.get(key) ?? noEpic;
      // A status key this build does not know (a newer RPC) gets its own list instead of throwing.
      const laneCols = lane.columns as unknown as Record<string, PmBacklogItem[] | undefined>;
      (laneCols[status] ??= []).push(item);
    }
  }

  // Order: top-level epics, each followed depth-first by its sub-epics.
  const childrenOf = new Map<string, PmBacklogItem[]>();
  const roots: PmBacklogItem[] = [];
  for (const epic of epics) {
    if (epic.parent_id && epicById.has(epic.parent_id) && epic.parent_id !== epic.id) {
      const list = childrenOf.get(epic.parent_id) ?? [];
      list.push(epic);
      childrenOf.set(epic.parent_id, list);
    } else {
      roots.push(epic);
    }
  }
  const ordered: EpicLane[] = [];
  const seen = new Set<string>();
  const visit = (epic: PmBacklogItem) => {
    if (seen.has(epic.id)) return;
    seen.add(epic.id);
    ordered.push(lanesByKey.get(epic.id)!);
    for (const child of childrenOf.get(epic.id) ?? []) visit(child);
  };
  roots.forEach(visit);
  // Epics caught in a parent cycle have no root; still give them a row.
  epics.forEach(visit);
  ordered.push(noEpic);
  return ordered;
}

export interface EpicDropPlan {
  /** New status, set only when the column changed. */
  status: ItemStatus | null;
  /** New parent, set only when the row changed. null parentId clears it. */
  parent: { parentId: string | null; sortOrder: number } | null;
}

/**
 * Decide what a Project-mode drop writes. Returns null for a no-op: the
 * dragged item is an epic, the target row is unknown, or nothing changed.
 * Row change is decided by comparing ROW KEYS, never raw parent_id, so an
 * item under a non-epic parent dropped back into "No epic" writes nothing.
 */
export function resolveEpicDrop(params: {
  item: PmBacklogItem;
  currentStatus: ItemStatus;
  targetLaneKey: string;
  targetStatus: ItemStatus;
  epicIds: Set<string>;
}): EpicDropPlan | null {
  const { item, currentStatus, targetLaneKey, targetStatus, epicIds } = params;
  if (item.type === 'epic') return null;
  if (targetLaneKey === item.id) return null;
  if (targetLaneKey !== NO_EPIC_KEY && !epicIds.has(targetLaneKey)) return null;

  const laneChanged = laneKeyForItem(item, epicIds) !== targetLaneKey;
  const statusChanged = currentStatus !== targetStatus;
  if (!laneChanged && !statusChanged) return null;

  return {
    status: statusChanged ? targetStatus : null,
    parent: laneChanged
      ? {
          parentId: targetLaneKey === NO_EPIC_KEY ? null : targetLaneKey,
          sortOrder: item.sort_order,
        }
      : null,
  };
}
