/**
 * groupItemsByEpic -- Pure grouping helper for the project detail "Epics" view
 * (BACKLOG-2386).
 *
 * Groups a project's backlog items by epic (parent -> child) so the Epics view
 * can render one collapsible section per epic plus a side "no epic" backlog.
 *
 * Grouping rules (v1):
 * - Epic sections = items with `type === 'epic'`, ordered by EXECUTION order:
 *   `sort_order ASC, item_number ASC` (BACKLOG-2785). `sort_order` is the
 *   column the PM board writes when epics are sequenced; it is `NOT NULL
 *   DEFAULT 0`, so a project that never sequenced its epics has every epic at
 *   0 and falls through to item_number — i.e. the pre-BACKLOG-2785 order.
 *   All epics are top-level; we do not require parent_id to be null here.
 * - A task belongs under epic E iff `task.parent_id === E.id`.
 * - Side backlog = items where `type !== 'epic'` AND (parent_id is null OR its
 *   parent is NOT one of this project's epics). This catches orphan tasks and
 *   tasks whose parent is a non-epic item.
 * - Epic rows are NEVER emitted as draggable cards (they are section headers).
 *
 * This helper is deliberately pure and side-effect free so it can be unit
 * tested against exact ID sets. Status filtering (if any) is applied by the
 * caller for display; the returned groups are unfiltered so epic progress
 * counts reflect true totals.
 */

import type { PmBacklogItem } from '@/lib/pm-types';

export interface GroupedByEpic {
  /**
   * Epic rows for this project, in execution order: `sort_order` ascending,
   * ties broken by `item_number` ascending (BACKLOG-2785).
   */
  epics: PmBacklogItem[];
  /** Map of epic id -> its child task items (parent_id === epic.id). */
  childrenByEpicId: Record<string, PmBacklogItem[]>;
  /**
   * Items with no epic: non-epic items whose parent is null OR whose parent is
   * not one of this project's epics.
   */
  backlog: PmBacklogItem[];
}

export function groupItemsByEpic(items: PmBacklogItem[]): GroupedByEpic {
  const epics = items
    .filter((item) => item.type === 'epic')
    // BACKLOG-2785: execution order first, backlog number only as the tiebreak.
    // A 0 difference (equal or both-default sort_order) is falsy, so unsequenced
    // projects keep their item_number order untouched.
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.item_number - b.item_number));

  const epicIds = new Set(epics.map((epic) => epic.id));

  // Pre-seed a bucket for every epic so callers can index safely even when an
  // epic has no children yet.
  const childrenByEpicId: Record<string, PmBacklogItem[]> = {};
  for (const epic of epics) {
    childrenByEpicId[epic.id] = [];
  }

  const backlog: PmBacklogItem[] = [];

  for (const item of items) {
    // Epics are section headers, never draggable cards.
    if (item.type === 'epic') continue;

    if (item.parent_id && epicIds.has(item.parent_id)) {
      childrenByEpicId[item.parent_id].push(item);
    } else {
      // No parent, or the parent is not one of this project's epics.
      backlog.push(item);
    }
  }

  return { epics, childrenByEpicId, backlog };
}
