/**
 * `getSprintMetrics` wiring tests (BACKLOG-3778 fix round).
 *
 * The attribution RULE (resolveEffectiveSprintId / attributeRowsToSprint) is
 * covered in `sprint-token-attribution.test.ts` against pure fixtures. What
 * is NOT covered there is the WIRING around it: that `getSprintMetrics`
 * actually runs both candidate queries, pages each one past PostgREST's
 * 1000-row cap, excludes soft-deleted items from the item-current-sprint
 * query, and feeds the union through the real attribution function. The SR
 * review on this PR noted dropping query (a) entirely would leave the pure
 * fixture suite all green -- this file is the control that closes that gap.
 *
 * The stub client below mimics the minimal supabase-js chain
 * `getSprintMetrics` calls: `.from().select().eq().is().order().range()`.
 * Dataset selection is keyed off which `.eq()` filter was applied to THAT
 * chain instance (not call order), so it stays correct across however many
 * `.range()` pages each query makes.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSprintMetrics } from '../pm-queries';
import { SERVER_MAX_PAGE_SIZE } from '../pm-paging';

// pii-allow-uuid: invented, not from any live row
const SPRINT_A = 'aaaaaaaa-1111-1111-1111-111111111111';
// pii-allow-uuid: invented, not from any live row
const SPRINT_B = 'bbbbbbbb-2222-2222-2222-222222222222';

interface StubRow {
  id: string;
  recorded_at: string;
  backlog_item_id: string | null;
  sprint_id: string | null;
  pm_backlog_items: { sprint_id: string | null } | null;
  deleted_at?: string | null; // only read by the stub's own filter, not by the code under test
}

function row(partial: Partial<StubRow> & { id: string; recorded_at: string }): StubRow {
  return {
    backlog_item_id: null,
    sprint_id: null,
    pm_backlog_items: null,
    deleted_at: null,
    ...partial,
  };
}

interface EqCall {
  col: string;
  val: unknown;
}

/**
 * A stub supabase client holding two independent datasets, one per query
 * `getSprintMetrics` issues. Each `.from()` call returns a FRESH chain that
 * records its own filters; `.range()` reads those filters to decide which
 * dataset it belongs to and applies the `deleted_at` filter and the 1000-row
 * provider cap itself, exactly as real PostgREST would.
 */
function makeStubClient(datasets: { viaItem: StubRow[]; viaStored: StubRow[] }) {
  const rangeCalls: Array<{ query: 'viaItem' | 'viaStored'; from: number; to: number }> = [];
  const eqCallsByQuery: { viaItem: EqCall[][]; viaStored: EqCall[][] } = { viaItem: [], viaStored: [] };

  const fromImpl = () => {
    const eq: EqCall[] = [];
    const isFilters: EqCall[] = [];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        eq.push({ col, val });
        return chain;
      },
      is: (col: string, val: unknown) => {
        isFilters.push({ col, val });
        return chain;
      },
      order: () => chain,
      range: (from: number, to: number) => {
        const isViaItem = eq.some((f) => f.col === 'pm_backlog_items.sprint_id');
        const queryName: 'viaItem' | 'viaStored' = isViaItem ? 'viaItem' : 'viaStored';
        rangeCalls.push({ query: queryName, from, to });
        eqCallsByQuery[queryName].push([...eq]);

        let rows = datasets[queryName];
        // Only filter out soft-deleted items if the code under test actually
        // issued `.is('pm_backlog_items.deleted_at', null)` -- NOT
        // unconditionally. If that call were ever removed from
        // getSprintMetrics, this stub must stop filtering too, so the
        // soft-delete test above goes red instead of passing by construction.
        const appliedDeletedAtFilter = isFilters.some(
          (f) => f.col === 'pm_backlog_items.deleted_at' && f.val === null
        );
        if (isViaItem && appliedDeletedAtFilter) {
          rows = rows.filter((r) => r.pm_backlog_items !== null && r.deleted_at == null);
        }
        // Reproduce PostgREST's own 1000-row response cap.
        const providerCap = 1000;
        const clampedTo = Math.min(to, from + providerCap - 1);
        return Promise.resolve({ data: rows.slice(from, clampedTo + 1), error: null });
      },
    };
    return chain;
  };

  return {
    client: { from: fromImpl } as unknown as SupabaseClient,
    rangeCalls,
    eqCallsByQuery,
  };
}

describe('getSprintMetrics wiring', () => {
  it('runs both candidate queries and unions them through the real attribution function', async () => {
    const onlyViaItem = row({
      id: 'm1',
      recorded_at: '2026-10-01T00:00:00.000Z',
      backlog_item_id: 'item-1',
      sprint_id: null, // the undercount bug: no stored sprint_id
      pm_backlog_items: { sprint_id: SPRINT_A },
    });
    const onlyViaStored = row({
      id: 'm2',
      recorded_at: '2026-10-02T00:00:00.000Z',
      backlog_item_id: null, // main-session row, no backlog item at all
      sprint_id: SPRINT_A,
      pm_backlog_items: null,
    });
    const unrelated = row({
      id: 'm3',
      recorded_at: '2026-10-03T00:00:00.000Z',
      backlog_item_id: 'item-2',
      sprint_id: null,
      pm_backlog_items: { sprint_id: SPRINT_B },
    });

    const { client } = makeStubClient({
      viaItem: [onlyViaItem, unrelated],
      viaStored: [onlyViaStored],
    });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('dropping query (a) would leave the undercounted row invisible -- proves this suite is not vacuous', async () => {
    // Reproduces the SR's own observation: a stub that returns nothing for
    // the viaItem query still "passes" if nothing exercises it.
    const onlyViaItem = row({
      id: 'm1',
      recorded_at: '2026-10-01T00:00:00.000Z',
      backlog_item_id: 'item-1',
      sprint_id: null,
      pm_backlog_items: { sprint_id: SPRINT_A },
    });
    const { client } = makeStubClient({ viaItem: [], viaStored: [] }); // query (a) returns nothing, as if dropped
    void onlyViaItem;

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result).toEqual([]);
  });

  it('excludes a row whose backlog item is soft-deleted from the item-current-sprint query', async () => {
    const liveItemRow = row({
      id: 'm1',
      recorded_at: '2026-10-01T00:00:00.000Z',
      backlog_item_id: 'item-1',
      sprint_id: null,
      pm_backlog_items: { sprint_id: SPRINT_A },
      deleted_at: null,
    });
    const deletedItemRow = row({
      id: 'm2',
      recorded_at: '2026-10-02T00:00:00.000Z',
      backlog_item_id: 'item-deleted',
      sprint_id: null,
      pm_backlog_items: { sprint_id: SPRINT_A },
      deleted_at: '2026-09-01T00:00:00.000Z',
    });

    const { client } = makeStubClient({
      viaItem: [liveItemRow, deletedItemRow],
      viaStored: [],
    });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result.map((r) => r.id)).toEqual(['m1']);
  });

  it('pages past PostgREST\'s 1000-row cap -- a 1,064-row sprint totals correctly', async () => {
    const rows = Array.from({ length: 1064 }, (_, i) =>
      row({
        id: `m-${String(i).padStart(5, '0')}`,
        recorded_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
        backlog_item_id: `item-${i}`,
        sprint_id: null,
        pm_backlog_items: { sprint_id: SPRINT_A },
      })
    );
    const { client, rangeCalls } = makeStubClient({ viaItem: rows, viaStored: [] });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result).toHaveLength(1064);
    expect(result.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    // More than one page was actually requested -- the fix is paging, not luck.
    const viaItemPages = rangeCalls.filter((c) => c.query === 'viaItem');
    expect(viaItemPages.length).toBeGreaterThan(1);
    expect(viaItemPages[0].to - viaItemPages[0].from + 1).toBe(SERVER_MAX_PAGE_SIZE);
  });

  it('pages past the 1000-row cap when the rows arrive through query (b), not (a) -- SR N1 (BACKLOG-3778)', async () => {
    // On SPRINT-174 the bulk of rows are main-session metrics with a stored
    // sprint_id and no backlog item join -- i.e. they come back from query
    // (b) (viaStored), not query (a). The sibling 1,064-row test above only
    // ever exercises (a)'s paging; this one reproduces the real shape.
    const rows = Array.from({ length: 1064 }, (_, i) =>
      row({
        id: `m-${String(i).padStart(5, '0')}`,
        recorded_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
        backlog_item_id: null,
        sprint_id: SPRINT_A,
        pm_backlog_items: null,
      })
    );
    const { client, rangeCalls } = makeStubClient({ viaItem: [], viaStored: rows });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result).toHaveLength(1064);
    expect(result.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    const viaStoredPages = rangeCalls.filter((c) => c.query === 'viaStored');
    expect(viaStoredPages.length).toBeGreaterThan(1);
  });

  it('sorts the unioned result by recorded_at ascending', async () => {
    const later = row({
      id: 'm-later',
      recorded_at: '2026-10-05T00:00:00.000Z',
      backlog_item_id: 'item-1',
      sprint_id: null,
      pm_backlog_items: { sprint_id: SPRINT_A },
    });
    const earlier = row({
      id: 'm-earlier',
      recorded_at: '2026-10-01T00:00:00.000Z',
      backlog_item_id: null,
      sprint_id: SPRINT_A,
      pm_backlog_items: null,
    });
    const { client } = makeStubClient({ viaItem: [later], viaStored: [earlier] });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result.map((r) => r.id)).toEqual(['m-earlier', 'm-later']);
  });

  it('does not double-count a row returned by both candidate queries', async () => {
    const shared = row({
      id: 'm-shared',
      recorded_at: '2026-10-01T00:00:00.000Z',
      backlog_item_id: 'item-1',
      sprint_id: SPRINT_A,
      pm_backlog_items: { sprint_id: SPRINT_A },
    });
    const { client } = makeStubClient({ viaItem: [shared], viaStored: [{ ...shared }] });

    const result = await getSprintMetrics(SPRINT_A, client);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m-shared');
  });
});
