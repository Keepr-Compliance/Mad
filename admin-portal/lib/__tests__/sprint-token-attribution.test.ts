/**
 * Sprint token attribution tests (BACKLOG-3778).
 *
 * The live defect: the sprint "Token Breakdown" summed `pm_token_metrics`
 * rows by the `sprint_id` STORED on the row. A run recorded before its
 * backlog item was added to the sprint carries `backlog_item_id` but no
 * `sprint_id` (confirmed live via Supabase MCP on real rows -- e.g. the
 * BACKLOG-3672/3611/2237 shapes below), so it never counted toward that
 * sprint's total.
 *
 * Fixtures are shaped after real `pm_token_metrics` rows (field names and
 * magnitudes transcribed from live SELECTs), with ids/descriptions replaced
 * by synthetic placeholders.
 */

import { describe, it, expect } from 'vitest';
import {
  attributeRowsToSprint,
  resolveEffectiveSprintId,
  type AttributableMetricRow,
} from '../sprint-token-attribution';

// pii-allow-uuid: invented, not from any live row
const SPRINT_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
// pii-allow-uuid: invented, not from any live row
const SPRINT_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

interface FixtureRow extends AttributableMetricRow {
  agent_type: string;
  total_tokens: number;
  billable_tokens: number;
}

// ---------------------------------------------------------------------------
// Fixtures -- shaped after real rows (ids/descriptions stripped)
// ---------------------------------------------------------------------------

/** Shaped after a real engineer row (BACKLOG-3764): item X, currently in A, row's stored sprint_id already A -- the already-working case. */
const ROW_ALREADY_WORKING: FixtureRow = {
  id: 'm1', agent_type: 'engineer', total_tokens: 11_564_675, billable_tokens: 341_982,
  backlog_item_id: 'item-x', sprint_id: SPRINT_A, item_sprint_id: SPRINT_A,
};

/** Shaped after a real general-purpose row (BACKLOG-3672): backlog_item_id set, sprint_id NULL -- the undercount bug. Item is currently in A. */
const ROW_BUG_ITEM_ONLY: FixtureRow = {
  id: 'm2', agent_type: 'general-purpose', total_tokens: 3_770_730, billable_tokens: 351_256,
  backlog_item_id: 'item-x2', sprint_id: null, item_sprint_id: SPRINT_A,
};

/** Shaped after a real main-session row: no backlog item, no stored sprint_id -- unattributable either way. */
const ROW_MAIN_UNLABELLED: FixtureRow = {
  id: 'm3', agent_type: 'main', total_tokens: 5_081_333, billable_tokens: 14_231,
  backlog_item_id: null, sprint_id: null, item_sprint_id: null,
};

/** No backlog item, but a stored sprint_id -- the main-session hook's fallback path (BACKLOG-3778 part 2). */
const ROW_MAIN_SPRINT_ONLY: FixtureRow = {
  id: 'm4', agent_type: 'main', total_tokens: 2_000_000, billable_tokens: 90_000,
  backlog_item_id: null, sprint_id: SPRINT_A, item_sprint_id: null,
};

/** Shaped after a real engineer row (BACKLOG-3611): item Y recorded while in A, then MOVED to B. Must follow the item, not the stale stamp. */
const ROW_ITEM_MOVED: FixtureRow = {
  id: 'm5', agent_type: 'engineer', total_tokens: 4_862_240, billable_tokens: 208_496,
  backlog_item_id: 'item-y', sprint_id: SPRINT_A, item_sprint_id: SPRINT_B,
};

/** Item Z: recorded while in A, later taken off every sprint (item_sprint_id null). COALESCE falls back to the row's own stamp. */
const ROW_ITEM_UNASSIGNED: FixtureRow = {
  id: 'm6', agent_type: 'sr-engineer', total_tokens: 1_000_000, billable_tokens: 50_000,
  backlog_item_id: 'item-z', sprint_id: SPRINT_A, item_sprint_id: null,
};

const ALL_ROWS = [
  ROW_ALREADY_WORKING,
  ROW_BUG_ITEM_ONLY,
  ROW_MAIN_UNLABELLED,
  ROW_MAIN_SPRINT_ONLY,
  ROW_ITEM_MOVED,
  ROW_ITEM_UNASSIGNED,
];

const ids = (rows: AttributableMetricRow[]) => rows.map((r) => r.id).sort();

describe('resolveEffectiveSprintId', () => {
  it('prefers the item current sprint over a stale or missing stored sprint_id', () => {
    expect(resolveEffectiveSprintId(ROW_BUG_ITEM_ONLY)).toBe(SPRINT_A);
    expect(resolveEffectiveSprintId(ROW_ITEM_MOVED)).toBe(SPRINT_B);
  });

  it('falls back to the stored sprint_id when there is no item, or the item carries none', () => {
    expect(resolveEffectiveSprintId(ROW_MAIN_SPRINT_ONLY)).toBe(SPRINT_A);
    expect(resolveEffectiveSprintId(ROW_ITEM_UNASSIGNED)).toBe(SPRINT_A);
  });

  it('resolves to null when neither the item nor the row carries a sprint', () => {
    expect(resolveEffectiveSprintId(ROW_MAIN_UNLABELLED)).toBeNull();
  });
});

describe('attributeRowsToSprint', () => {
  it('a row with only backlog_item_id (stored sprint_id null) counts in its item current sprint', () => {
    const result = attributeRowsToSprint(ALL_ROWS, SPRINT_A);
    expect(ids(result)).toContain(ROW_BUG_ITEM_ONLY.id);
  });

  it('a row whose item later moved to another sprint counts in the item current sprint, not the stale stamp', () => {
    const inA = attributeRowsToSprint(ALL_ROWS, SPRINT_A);
    const inB = attributeRowsToSprint(ALL_ROWS, SPRINT_B);
    expect(ids(inA)).not.toContain(ROW_ITEM_MOVED.id);
    expect(ids(inB)).toContain(ROW_ITEM_MOVED.id);
  });

  it('a main-session row with no backlog item falls back to its own stored sprint_id', () => {
    const inA = attributeRowsToSprint(ALL_ROWS, SPRINT_A);
    expect(ids(inA)).toContain(ROW_MAIN_SPRINT_ONLY.id);
    expect(ids(inA)).not.toContain(ROW_MAIN_UNLABELLED.id);
  });

  it('an item taken off every sprint falls back to the row own stored sprint_id', () => {
    const inA = attributeRowsToSprint(ALL_ROWS, SPRINT_A);
    expect(ids(inA)).toContain(ROW_ITEM_UNASSIGNED.id);
  });

  it('attributes the exact expected id set per sprint -- no row double-counted across sprints', () => {
    const inA = attributeRowsToSprint(ALL_ROWS, SPRINT_A);
    const inB = attributeRowsToSprint(ALL_ROWS, SPRINT_B);
    expect(ids(inA)).toEqual([
      ROW_ALREADY_WORKING.id,
      ROW_BUG_ITEM_ONLY.id,
      ROW_ITEM_UNASSIGNED.id,
      ROW_MAIN_SPRINT_ONLY.id,
    ].sort());
    expect(ids(inB)).toEqual([ROW_ITEM_MOVED.id]);
    // No id appears in both sprints' results.
    expect(ids(inA).filter((id) => ids(inB).includes(id))).toEqual([]);
  });

  it('does not double-count a row that appears in both candidate queries', () => {
    const duplicated = [ROW_ALREADY_WORKING, { ...ROW_ALREADY_WORKING }];
    const result = attributeRowsToSprint(duplicated, SPRINT_A);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ROW_ALREADY_WORKING.id);
  });

  it('returns nothing for an unrelated sprint', () => {
    // pii-allow-uuid: invented, not from any live row
    const result = attributeRowsToSprint(ALL_ROWS, 'cccccccc-0000-0000-0000-00000000000c');
    expect(result).toEqual([]);
  });
});
