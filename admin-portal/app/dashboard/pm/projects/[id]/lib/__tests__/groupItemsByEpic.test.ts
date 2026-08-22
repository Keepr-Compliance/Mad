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
 * - epics are ordered by execution order: sort_order asc, item_number as the
 *   tiebreak (BACKLOG-2785)
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

  it('falls back to item_number when sort_order ties (both default 0)', () => {
    // Input order is scrambled (epic-b appears before epic-a), so a stable sort
    // with no tiebreak would return ['epic-b', 'epic-a']. BACKLOG-2785.
    expect(epicA.sort_order).toBe(epicB.sort_order);
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


// ---------------------------------------------------------------------------
// BACKLOG-2785 -- epic lists follow EXECUTION order (sort_order), not the
// backlog number. Founder, 2026-08-21: "the epics are still sorted by their
// original backlog number and not the order of execution on the project
// module."
// ---------------------------------------------------------------------------

describe('groupItemsByEpic - execution order (BACKLOG-2785)', () => {
  it('orders epics by sort_order when sort_order INVERTS item_number order', () => {
    // Three epics whose execution order is the exact reverse of their backlog
    // numbers, fed in yet a third order so neither input order nor item_number
    // can produce a passing result by accident.
    const first = makeItem({ id: 'runs-first', item_number: 300, type: 'epic', sort_order: 0 });
    const second = makeItem({ id: 'runs-second', item_number: 200, type: 'epic', sort_order: 1 });
    const third = makeItem({ id: 'runs-third', item_number: 100, type: 'epic', sort_order: 2 });

    const result = groupItemsByEpic([second, third, first]);

    expect(ids(result.epics)).toEqual(['runs-first', 'runs-second', 'runs-third']);
  });

  it('breaks a sort_order tie by item_number, not by input order', () => {
    // Both epics sequenced into the same slot; the lower backlog number wins.
    const later = makeItem({ id: 'num-40', item_number: 40, type: 'epic', sort_order: 5 });
    const earlier = makeItem({ id: 'num-30', item_number: 30, type: 'epic', sort_order: 5 });

    const result = groupItemsByEpic([later, earlier]);

    expect(ids(result.epics)).toEqual(['num-30', 'num-40']);
  });

  it('leaves an unsequenced project (every sort_order at the 0 default) in item_number order', () => {
    // pm_backlog_items.sort_order is NOT NULL DEFAULT 0, so a project that never
    // sequenced its epics has every epic at 0 — it must keep today's order.
    const e1 = makeItem({ id: 'e-1', item_number: 1, type: 'epic' });
    const e2 = makeItem({ id: 'e-2', item_number: 2, type: 'epic' });
    const e3 = makeItem({ id: 'e-3', item_number: 3, type: 'epic' });

    const result = groupItemsByEpic([e3, e1, e2]);

    expect(result.epics.every((e) => e.sort_order === 0)).toBe(true);
    expect(ids(result.epics)).toEqual(['e-1', 'e-2', 'e-3']);
  });

  it('renders the Stable Ground epic set in execution order', () => {
    // Transcribed from pm_backlog_items on 2026-08-21 (the project the founder
    // was looking at): item_number + sort_order exactly as stored. Titles are
    // omitted -- ordering is decided by the two numeric columns alone.
    //
    // Item numbers ordered by sort_order, then item_number:
    //   2710 umbrella (0) · 2723 "0 gates" (0) · 2716 "1" (1) · 2738 "2" (2)
    //   2713 "3" (3) · 2714 "4" (4) · 2715 "5" (5) · 2717 "6" (6)
    //   2724 triage (99)
    // The umbrella (2710) stays first exactly as it is today, via the tiebreak.
    // Before this fix the list read 2710, 2713, 2714, 2715, 2716, 2717, 2723,
    // 2724, 2738 -- the founder-visible sequence "3, 4, 5, 1, 6, 0, 2".
    const stableGround = [
      { n: 2713, s: 3 },
      { n: 2717, s: 6 },
      { n: 2710, s: 0 },
      { n: 2738, s: 2 },
      { n: 2715, s: 5 },
      { n: 2723, s: 0 },
      { n: 2714, s: 4 },
      { n: 2724, s: 99 },
      { n: 2716, s: 1 },
    ].map(({ n, s: sortOrder }) =>
      makeItem({ id: `epic-${n}`, item_number: n, type: 'epic', sort_order: sortOrder })
    );

    const result = groupItemsByEpic(stableGround);

    expect(result.epics.map((e) => e.item_number)).toEqual([
      2710, 2723, 2716, 2738, 2713, 2714, 2715, 2717, 2724,
    ]);
  });

  it('orders epic sections only -- child/backlog order is left to the caller', () => {
    // Children keep the order the server sent them in (pm_list_items already
    // returns sort_order ASC); this helper must not re-sort them.
    const epic = makeItem({ id: 'epic', item_number: 10, type: 'epic', sort_order: 1 });
    const childHighNumber = makeItem({
      id: 'child-hi', item_number: 99, parent_id: 'epic', sort_order: 0,
    });
    const childLowNumber = makeItem({
      id: 'child-lo', item_number: 11, parent_id: 'epic', sort_order: 5,
    });

    const result = groupItemsByEpic([epic, childHighNumber, childLowNumber]);

    expect(ids(result.childrenByEpicId['epic'])).toEqual(['child-hi', 'child-lo']);
  });
});
