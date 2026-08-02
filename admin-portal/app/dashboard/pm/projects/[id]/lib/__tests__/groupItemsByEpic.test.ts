/**
 * Tests for groupItemsByEpic -- the pure grouping helper behind the project
 * detail "Epics" view (BACKLOG-2386).
 *
 * Assertions use EXACT ID SETS (not just counts) so a regression that misfiles
 * a task cannot pass on a coincidental count match.
 *
 * Covers:
 * - a task under an epic (parent_id === epic.id)
 * - an orphan task (parent_id null) -> backlog
 * - a task whose parent is a non-epic item -> backlog
 * - a task whose parent is an epic from a DIFFERENT set (not present) -> backlog
 * - epic rows are excluded from cards (never appear in children or backlog)
 * - epics are sorted by item_number ascending
 * - every epic gets a (possibly empty) children bucket
 * - input is not mutated
 */

import { describe, it, expect } from 'vitest';
import { groupItemsByEpic } from '../groupItemsByEpic';
import type { PmBacklogItem, ItemType } from '@/lib/pm-types';

/** Build a PmBacklogItem with sensible defaults; override what a test cares about. */
function makeItem(
  overrides: Partial<PmBacklogItem> & { id: string; item_number: number }
): PmBacklogItem {
  const base: PmBacklogItem = {
    id: overrides.id,
    item_number: overrides.item_number,
    legacy_id: null,
    title: overrides.id,
    description: null,
    body: null,
    type: 'feature' as ItemType,
    area: null,
    status: 'pending',
    priority: 'medium',
    parent_id: null,
    project_id: 'proj-1',
    sprint_id: null,
    assignee_id: null,
    est_tokens: null,
    actual_tokens: null,
    variance: null,
    sort_order: 0,
    start_date: null,
    due_date: null,
    file: null,
    branch_name: null,
    pr_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    deleted_at: null,
  };
  return { ...base, ...overrides };
}

const ids = (items: PmBacklogItem[]) => items.map((i) => i.id);
const idSet = (items: PmBacklogItem[]) => new Set(items.map((i) => i.id));

describe('groupItemsByEpic - core filing rules', () => {
  const epicA = makeItem({ id: 'epic-a', item_number: 10, type: 'epic' });
  const epicB = makeItem({ id: 'epic-b', item_number: 20, type: 'epic' });
  const childA1 = makeItem({ id: 'child-a1', item_number: 11, parent_id: 'epic-a' });
  const childA2 = makeItem({ id: 'child-a2', item_number: 12, parent_id: 'epic-a' });
  const childB1 = makeItem({ id: 'child-b1', item_number: 21, parent_id: 'epic-b' });
  const orphan = makeItem({ id: 'orphan', item_number: 30, parent_id: null });
  const nonEpicParent = makeItem({ id: 'feat-parent', item_number: 40 });
  const childOfNonEpic = makeItem({
    id: 'child-of-feat',
    item_number: 41,
    parent_id: 'feat-parent',
  });
  const childOfMissingEpic = makeItem({
    id: 'child-of-missing',
    item_number: 50,
    parent_id: 'epic-not-in-set',
  });

  const items = [
    // Deliberately scrambled input order to prove sorting/grouping is real.
    childB1,
    epicB,
    orphan,
    childA2,
    epicA,
    childOfNonEpic,
    childA1,
    nonEpicParent,
    childOfMissingEpic,
  ];

  const result = groupItemsByEpic(items);

  it('files a task under its epic by parent_id (exact id sets)', () => {
    expect(idSet(result.childrenByEpicId['epic-a'])).toEqual(
      new Set(['child-a1', 'child-a2'])
    );
    expect(idSet(result.childrenByEpicId['epic-b'])).toEqual(new Set(['child-b1']));
  });

  it('sends an orphan task (parent_id null) to the backlog', () => {
    expect(idSet(result.backlog).has('orphan')).toBe(true);
  });

  it('sends a task whose parent is a non-epic to the backlog', () => {
    // The non-epic "parent" itself and its child both land in backlog.
    expect(idSet(result.backlog).has('child-of-feat')).toBe(true);
    expect(idSet(result.backlog).has('feat-parent')).toBe(true);
  });

  it('sends a task whose parent epic is not in this set to the backlog', () => {
    expect(idSet(result.backlog).has('child-of-missing')).toBe(true);
  });

  it('produces the EXACT backlog id set (no epics, no epic-children)', () => {
    expect(idSet(result.backlog)).toEqual(
      new Set(['orphan', 'feat-parent', 'child-of-feat', 'child-of-missing'])
    );
  });

  it('excludes epic rows from cards (not in any children bucket nor backlog)', () => {
    const inChildren = new Set(
      Object.values(result.childrenByEpicId).flat().map((i) => i.id)
    );
    expect(inChildren.has('epic-a')).toBe(false);
    expect(inChildren.has('epic-b')).toBe(false);
    expect(idSet(result.backlog).has('epic-a')).toBe(false);
    expect(idSet(result.backlog).has('epic-b')).toBe(false);
  });

  it('returns epics sorted by item_number ascending', () => {
    expect(ids(result.epics)).toEqual(['epic-a', 'epic-b']);
  });

  it('seeds a bucket for every epic (even when empty)', () => {
    const empty = groupItemsByEpic([
      makeItem({ id: 'lonely-epic', item_number: 5, type: 'epic' }),
    ]);
    expect(empty.childrenByEpicId['lonely-epic']).toEqual([]);
  });
});

describe('groupItemsByEpic - purity & edge cases', () => {
  it('does not mutate the input array', () => {
    const input = [
      makeItem({ id: 'b-epic', item_number: 2, type: 'epic' }),
      makeItem({ id: 'a-epic', item_number: 1, type: 'epic' }),
      makeItem({ id: 't', item_number: 3, parent_id: 'a-epic' }),
    ];
    const snapshot = ids(input);
    groupItemsByEpic(input);
    expect(ids(input)).toEqual(snapshot);
  });

  it('handles an empty input', () => {
    const result = groupItemsByEpic([]);
    expect(result.epics).toEqual([]);
    expect(result.backlog).toEqual([]);
    expect(result.childrenByEpicId).toEqual({});
  });

  it('handles a project with only backlog tasks and no epics', () => {
    const result = groupItemsByEpic([
      makeItem({ id: 't1', item_number: 1 }),
      makeItem({ id: 't2', item_number: 2 }),
    ]);
    expect(result.epics).toEqual([]);
    expect(idSet(result.backlog)).toEqual(new Set(['t1', 't2']));
  });
});
