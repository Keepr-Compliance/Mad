/**
 * epic-lanes (BACKLOG-4176): Project-mode rows and drop decisions.
 */

import { describe, it, expect } from 'vitest';
import {
  collectEpicIds,
  groupColumnsByEpic,
  laneKeyForItem,
  resolveEpicDrop,
} from '../epic-lanes';
import { NO_EPIC_KEY } from '../swim-lane-ids';
import {
  CHILD_A1,
  CHILD_A2,
  CHILD_C1,
  EPIC_A,
  EPIC_B,
  ORPHAN,
  PLAIN_PARENT,
  UNDER_FOREIGN_EPIC,
  UNDER_PLAIN,
  emptyColumns,
  idsIn,
  projectColumns,
} from '../../__tests__/board-fixtures';

const epicIds = collectEpicIds(projectColumns());

describe('groupColumnsByEpic', () => {
  const lanes = groupColumnsByEpic(projectColumns());

  it('gives every epic a row, including an empty one, then No epic last', () => {
    expect(lanes.map((l) => l.key)).toEqual(['epic-a', 'epic-c', 'epic-b', NO_EPIC_KEY]);
  });

  it('labels a sub-epic row with its parent epic', () => {
    const c = lanes.find((l) => l.key === 'epic-c')!;
    expect(c.parentEpic?.id).toBe('epic-a');
    expect(lanes.find((l) => l.key === 'epic-a')!.parentEpic).toBeNull();
  });

  it('never puts an epic in a cell', () => {
    for (const lane of lanes) {
      for (const items of Object.values(lane.columns)) {
        expect(items.every((i: { type: string }) => i.type !== 'epic')).toBe(true);
      }
    }
  });

  it('puts each item in its row and status column', () => {
    const a = lanes.find((l) => l.key === 'epic-a')!;
    expect(idsIn(a.columns, 'pending')).toEqual(['child-a1']);
    expect(idsIn(a.columns, 'completed')).toEqual(['child-a2']);
    const c = lanes.find((l) => l.key === 'epic-c')!;
    expect(idsIn(c.columns, 'obsolete')).toEqual(['child-c1']);
    const b = lanes.find((l) => l.key === 'epic-b')!;
    expect(Object.values(b.columns).flat()).toHaveLength(0);
  });

  it('No epic holds no-parent, non-epic-parent and foreign-epic items', () => {
    const none = lanes.find((l) => l.key === NO_EPIC_KEY)!;
    expect(idsIn(none.columns, 'pending').sort()).toEqual(['orphan', 'plain-parent', 'under-foreign'].sort());
    expect(idsIn(none.columns, 'testing')).toEqual(['under-plain']);
  });

  it('an empty project still has the No epic row', () => {
    expect(groupColumnsByEpic(emptyColumns()).map((l) => l.key)).toEqual([NO_EPIC_KEY]);
  });
});

describe('laneKeyForItem', () => {
  it('uses the parent only when it is an epic on the board', () => {
    expect(laneKeyForItem(CHILD_A1, epicIds)).toBe('epic-a');
    expect(laneKeyForItem(UNDER_PLAIN, epicIds)).toBe(NO_EPIC_KEY);
    expect(laneKeyForItem(UNDER_FOREIGN_EPIC, epicIds)).toBe(NO_EPIC_KEY);
    expect(laneKeyForItem(ORPHAN, epicIds)).toBe(NO_EPIC_KEY);
  });
});

describe('resolveEpicDrop', () => {
  it('cross-epic drop re-parents with the item\'s own sort_order and sets status', () => {
    expect(
      resolveEpicDrop({ item: CHILD_A1, currentStatus: 'pending', targetLaneKey: 'epic-b', targetStatus: 'testing', epicIds })
    ).toEqual({ status: 'testing', parent: { parentId: 'epic-b', sortOrder: 7 } });
  });

  it('cross-epic drop in the same column writes the parent only', () => {
    expect(
      resolveEpicDrop({ item: CHILD_A2, currentStatus: 'completed', targetLaneKey: 'epic-c', targetStatus: 'completed', epicIds })
    ).toEqual({ status: null, parent: { parentId: 'epic-c', sortOrder: 3 } });
  });

  it('drop into No epic clears the parent', () => {
    expect(
      resolveEpicDrop({ item: CHILD_C1, currentStatus: 'obsolete', targetLaneKey: NO_EPIC_KEY, targetStatus: 'obsolete', epicIds })
    ).toEqual({ status: null, parent: { parentId: null, sortOrder: 4 } });
  });

  it('same row, new column: status only, never the parent', () => {
    expect(
      resolveEpicDrop({ item: CHILD_A1, currentStatus: 'pending', targetLaneKey: 'epic-a', targetStatus: 'in_progress', epicIds })
    ).toEqual({ status: 'in_progress', parent: null });
  });

  it('non-epic-parent item moved within No epic does not touch its parent', () => {
    expect(
      resolveEpicDrop({ item: UNDER_PLAIN, currentStatus: 'testing', targetLaneKey: NO_EPIC_KEY, targetStatus: 'testing', epicIds })
    ).toBeNull();
    expect(
      resolveEpicDrop({ item: UNDER_PLAIN, currentStatus: 'testing', targetLaneKey: NO_EPIC_KEY, targetStatus: 'pending', epicIds })
    ).toEqual({ status: 'pending', parent: null });
  });

  it('dragging an epic is a no-op', () => {
    expect(
      resolveEpicDrop({ item: EPIC_A, currentStatus: 'pending', targetLaneKey: 'epic-b', targetStatus: 'pending', epicIds })
    ).toBeNull();
    expect(
      resolveEpicDrop({ item: EPIC_B, currentStatus: 'in_progress', targetLaneKey: NO_EPIC_KEY, targetStatus: 'pending', epicIds })
    ).toBeNull();
  });

  it('an unknown target row is a no-op', () => {
    expect(
      resolveEpicDrop({ item: PLAIN_PARENT, currentStatus: 'pending', targetLaneKey: 'not-an-epic', targetStatus: 'pending', epicIds })
    ).toBeNull();
  });
});
