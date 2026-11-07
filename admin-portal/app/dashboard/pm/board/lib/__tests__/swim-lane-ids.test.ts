/**
 * Tests for swim-lane droppable id encode / decode helpers.
 *
 * These helpers drive the board drag-and-drop target resolution:
 * structured "cell:dim=...:key=...:status=..." ids let handleDragEnd derive
 * BOTH the target project row and the target status from one over-target.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSwimLaneCellId,
  parseSwimLaneCellId,
  SWIM_LANE_NEW_PROJECT_ID,
  NO_EPIC_KEY,
  NO_LABEL_KEY,
  buildCardSortableId,
  itemIdFromSortableId,
  isSwimLaneMode,
} from '../swim-lane-ids';

describe('SWIM_LANE_NEW_PROJECT_ID', () => {
  it('is a stable sentinel string', () => {
    expect(SWIM_LANE_NEW_PROJECT_ID).toBe('swimlane-new-project');
  });
});

describe('buildSwimLaneCellId', () => {
  it('encodes project dimension with uuid-like key', () => {
    const id = buildSwimLaneCellId(
      'project',
      'abc-123-def',
      'in_progress'
    );
    expect(id).toBe('cell:dim=project:key=abc-123-def:status=in_progress');
  });

  it('encodes area dimension', () => {
    const id = buildSwimLaneCellId('area', 'Frontend', 'pending');
    expect(id).toBe('cell:dim=area:key=Frontend:status=pending');
  });

  it('encodes assignee dimension', () => {
    const id = buildSwimLaneCellId('assignee', 'user-42', 'completed');
    expect(id).toBe('cell:dim=assignee:key=user-42:status=completed');
  });

  it('encodes the "No Project" sentinel groupKey', () => {
    const id = buildSwimLaneCellId('project', 'No Project', 'pending');
    expect(id).toBe('cell:dim=project:key=No Project:status=pending');
  });
});

describe('parseSwimLaneCellId', () => {
  it('round-trips a project cell id', () => {
    const id = buildSwimLaneCellId(
      'project',
      'abc-123-def',
      'in_progress'
    );
    expect(parseSwimLaneCellId(id)).toEqual({
      dimension: 'project',
      groupKey: 'abc-123-def',
      status: 'in_progress',
    });
  });

  it('round-trips an area cell id', () => {
    const id = buildSwimLaneCellId('area', 'Frontend', 'pending');
    expect(parseSwimLaneCellId(id)).toEqual({
      dimension: 'area',
      groupKey: 'Frontend',
      status: 'pending',
    });
  });

  it('round-trips an assignee cell id', () => {
    const id = buildSwimLaneCellId('assignee', 'user-42', 'completed');
    expect(parseSwimLaneCellId(id)).toEqual({
      dimension: 'assignee',
      groupKey: 'user-42',
      status: 'completed',
    });
  });

  it('round-trips "No Project" sentinel', () => {
    const id = buildSwimLaneCellId('project', 'No Project', 'pending');
    expect(parseSwimLaneCellId(id)).toEqual({
      dimension: 'project',
      groupKey: 'No Project',
      status: 'pending',
    });
  });

  it('returns null for plain status ids (non-swim-lane droppables)', () => {
    expect(parseSwimLaneCellId('pending')).toBeNull();
    expect(parseSwimLaneCellId('in_progress')).toBeNull();
  });

  it('returns null for legacy "groupKey::status" ids', () => {
    expect(parseSwimLaneCellId('some-project::pending')).toBeNull();
  });

  it('returns null for the ghost new-project sentinel', () => {
    expect(parseSwimLaneCellId(SWIM_LANE_NEW_PROJECT_ID)).toBeNull();
  });

  it('returns null for backlog-panel', () => {
    expect(parseSwimLaneCellId('backlog-panel')).toBeNull();
  });

  it('returns null when dimension is unknown', () => {
    expect(
      parseSwimLaneCellId('cell:dim=cohort:key=x:status=pending')
    ).toBeNull();
  });

  it('returns null when status is unknown', () => {
    expect(
      parseSwimLaneCellId('cell:dim=project:key=x:status=frobnicated')
    ).toBeNull();
  });

  it('returns null for malformed cell: ids', () => {
    expect(parseSwimLaneCellId('cell:')).toBeNull();
    expect(parseSwimLaneCellId('cell:garbage')).toBeNull();
    expect(parseSwimLaneCellId('cell:dim=project')).toBeNull();
    expect(parseSwimLaneCellId('cell:dim=project:status=pending')).toBeNull();
  });

  // Regression: previously the regex used greedy `(.*)` for the key, which
  // would silently accept ids whose groupKey contained `:status=` and yield
  // a wrong parse (groupKey="weird:status=fake", status="pending"). With the
  // tightened `([^:]+)` pattern such ids are rejected cleanly.
  it('returns null when groupKey contains a `:status=` injection (greedy-regex regression)', () => {
    const malformed = 'cell:dim=project:key=weird:status=fake:status=pending';
    expect(parseSwimLaneCellId(malformed)).toBeNull();
  });

  it('returns null when groupKey contains any colon (tight-regex guarantee)', () => {
    expect(
      parseSwimLaneCellId('cell:dim=area:key=a:b:status=pending')
    ).toBeNull();
    expect(
      parseSwimLaneCellId('cell:dim=assignee:key=user:42:status=completed')
    ).toBeNull();
  });
});

describe('epic dimension (BACKLOG-4176)', () => {
  it('round-trips an epic row cell', () => {
    const id = buildSwimLaneCellId('epic', 'epic-a', 'testing');
    expect(id).toBe('cell:dim=epic:key=epic-a:status=testing');
    expect(parseSwimLaneCellId(id)).toEqual({ dimension: 'epic', groupKey: 'epic-a', status: 'testing' });
  });

  it('round-trips the No epic row cell', () => {
    const id = buildSwimLaneCellId('epic', NO_EPIC_KEY, 'pending');
    expect(parseSwimLaneCellId(id)).toEqual({ dimension: 'epic', groupKey: NO_EPIC_KEY, status: 'pending' });
  });
});

describe('Label lanes (BACKLOG-4196)', () => {
  it('C2: a label cell id round-trips, for a label id and for No label', () => {
    for (const key of ['label-uuid-1', NO_LABEL_KEY]) {
      const id = buildSwimLaneCellId('label', key, 'testing');
      expect(parseSwimLaneCellId(id)).toEqual({ dimension: 'label', groupKey: key, status: 'testing' });
    }
    expect(NO_LABEL_KEY).toBe('No label');
  });

  it('C3: itemIdFromSortableId gives the item id of a lane copy', () => {
    expect(itemIdFromSortableId(buildCardSortableId('item-1', 'label-uuid-1'))).toBe('item-1');
    expect(itemIdFromSortableId(buildCardSortableId('item-1', NO_LABEL_KEY))).toBe('item-1');
  });

  it('C3: any other id passes through unchanged', () => {
    for (const id of [
      'item-1',
      'pending',
      'backlog-panel',
      buildSwimLaneCellId('label', 'label-uuid-1', 'pending'),
      'card:item-1',
    ]) {
      expect(itemIdFromSortableId(id)).toBe(id);
    }
  });

  it('C10: isSwimLaneMode accepts the selector modes and nothing else', () => {
    for (const m of ['off', 'project', 'area', 'assignee', 'label']) expect(isSwimLaneMode(m)).toBe(true);
    for (const m of ['sprint', 'epic', '', null, undefined, 3]) expect(isSwimLaneMode(m)).toBe(false);
  });
});
