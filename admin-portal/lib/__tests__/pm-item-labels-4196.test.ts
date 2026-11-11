/**
 * BACKLOG-4196: fetchItemLabels reads item labels for the board in chunks.
 *
 * Row shape transcribed from a live pm_item_labels -> pm_labels embed
 * (item_id, created_at, label{id,name,color,project_id}); values replaced
 * with placeholders.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { table: string; select: string; ids: string[] }[] = [];
let rowsFor: (ids: string[]) => unknown[] = () => [];
let errorOnCall: number | null = null;

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (select: string) => ({
        in: (_col: string, ids: string[]) => {
          calls.push({ table, select, ids });
          const n = calls.length;
          if (errorOnCall === n) return Promise.resolve({ data: null, error: new Error('denied') });
          return Promise.resolve({ data: rowsFor(ids), error: null });
        },
      }),
    }),
  }),
}));

import { fetchItemLabels, ITEM_LABELS_CHUNK } from '../pm-queries';

const LABEL_A = { id: 'label-a', name: 'Alpha', color: '#111111', project_id: null };
const LABEL_B = { id: 'label-b', name: 'Beta', color: '#222222', project_id: 'project-p' };

beforeEach(() => {
  calls.length = 0;
  rowsFor = () => [];
  errorOnCall = null;
});

describe('fetchItemLabels', () => {
  it('C6: more than one chunk of ids is read in several queries, each at most a chunk', async () => {
    const ids = Array.from({ length: ITEM_LABELS_CHUNK + 1 }, (_, i) => `item-${i}`);
    await fetchItemLabels(ids);
    expect(ITEM_LABELS_CHUNK).toBe(100);
    expect(calls).toHaveLength(2);
    expect(calls[0].ids).toHaveLength(100);
    expect(calls[1].ids).toEqual(['item-100']);
    expect(calls.every((c) => c.table === 'pm_item_labels')).toBe(true);
    expect(calls[0].select).toContain('label:pm_labels(');
  });

  it('no ids: no query', async () => {
    expect((await fetchItemLabels([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('groups labels per item in the order they were attached', async () => {
    rowsFor = () => [
      { item_id: 'item-1', created_at: '2026-11-02T00:00:00+00:00', label: LABEL_B },
      { item_id: 'item-1', created_at: '2026-11-01T00:00:00+00:00', label: LABEL_A },
      { item_id: 'item-2', created_at: '2026-11-01T00:00:00+00:00', label: LABEL_A },
    ];
    const map = await fetchItemLabels(['item-1', 'item-2', 'item-3']);
    expect(map.get('item-1')).toEqual([LABEL_A, LABEL_B]);
    expect(map.get('item-2')).toEqual([LABEL_A]);
    expect(map.has('item-3')).toBe(false);
  });

  it('an error in any chunk rejects', async () => {
    errorOnCall = 2;
    const ids = Array.from({ length: 150 }, (_, i) => `item-${i}`);
    await expect(fetchItemLabels(ids)).rejects.toThrow('denied');
  });
});
