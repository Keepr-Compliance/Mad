/**
 * Email Sync Timing model (BACKLOG-4130).
 *
 * FIXTURE PROVENANCE: `row()` is the sync_outcomes row the desktop builder
 * (electron/services/emailPrecacheOutcome.ts) produces through
 * buildSyncOutcomeRow: run_kind from fields.runKind, source_metrics with the
 * named keys providers/checked/written/dbMs/build/windowMonths/backfill
 * (+ inserted on a force swap). Counts are synthetic; no customer data.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketFor,
  buildEmailPrecacheReport,
  EP_BUCKETS,
  EP_RUN_LIMIT,
  type EpSyncOutcomeRow,
} from '../email-precache';
import { RUN_LIMIT } from '../iphone-sync-queries';

let seq = 0;
function row(over: Partial<EpSyncOutcomeRow> & { checked?: number | null; backfill?: boolean } = {}): EpSyncOutcomeRow {
  const { checked = 120, backfill = false, ...rest } = over;
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    user_id: 'user-a',
    created_at: '2026-11-04T10:00:00.000Z',
    outcome: 'complete',
    elapsed_ms: 60_000,
    run_kind: 'cache',
    source_metrics: {
      providers: ['outlook'],
      ...(checked === null ? {} : { checked }),
      written: 100,
      dbMs: 900,
      build: '2.46.0',
      windowMonths: 12,
      backfill,
    },
    ...rest,
  };
}

describe('bucketFor — every boundary', () => {
  it.each([
    [0, '0'],
    [1, '1-99'],
    [99, '1-99'],
    [100, '100-999'],
    [999, '100-999'],
    [1000, '1k-9999'],
    [9999, '1k-9999'],
    [10000, '10k+'],
    [33637, '10k+'],
    [null, 'unknown'],
  ] as const)('%s -> %s', (checked, key) => {
    expect(bucketFor(checked)).toBe(key);
  });
});

describe('buildEmailPrecacheReport', () => {
  it('has three columns: first sync, incremental, forced re-sync', () => {
    const model = buildEmailPrecacheReport([]);
    expect(model.kinds.map((k) => k.kind)).toEqual(['cache', 're-cache', 'force']);
  });

  it('percentiles are over completed runs only, and each cell states its N', () => {
    const model = buildEmailPrecacheReport([
      row({ elapsed_ms: 10_000 }),
      row({ elapsed_ms: 20_000 }),
      row({ elapsed_ms: 30_000 }),
      row({ elapsed_ms: 999_000, outcome: 'error' }),
      row({ elapsed_ms: 1_000, outcome: 'cancelled' }),
    ]);
    const cache = model.kinds[0];
    const cell = cache.cells['100-999'];
    expect(cell).toEqual({ n: 3, minMs: 10_000, medianMs: 20_000, p90Ms: 30_000, maxMs: 30_000 });
    expect(cache).toMatchObject({ total: 5, complete: 3, error: 1, cancelled: 1 });
  });

  it('groups by kind and bucket; force is its own column', () => {
    const model = buildEmailPrecacheReport([
      row({ run_kind: 'force', checked: 33637, elapsed_ms: 900_000 }),
      row({ run_kind: 're-cache', checked: 0, elapsed_ms: 2_000 }),
      row({ run_kind: 're-cache', checked: 12, elapsed_ms: 4_000, backfill: true }),
    ]);
    const [cache, recache, force] = model.kinds;
    expect(cache.total).toBe(0);
    expect(force.cells['10k+'].n).toBe(1);
    expect(recache.cells['0'].n).toBe(1);
    expect(recache.cells['1-99'].n).toBe(1);
    expect(recache.backfilled).toBe(1);
  });

  it('a row without a count lands in "Not recorded", never in 0', () => {
    const model = buildEmailPrecacheReport([row({ checked: null }), row({ source_metrics: null })]);
    expect(model.kinds[0].cells.unknown.n).toBe(2);
    expect(model.kinds[0].cells['0'].n).toBe(0);
  });

  it('counts rows with no known run kind separately', () => {
    const model = buildEmailPrecacheReport([row({ run_kind: null }), row({ run_kind: 'sync' }), row()]);
    expect(model.unknownKind).toBe(2);
    expect(model.totalRuns).toBe(3);
  });

  it('every bucket has a cell in every column', () => {
    const model = buildEmailPrecacheReport([row()]);
    for (const k of model.kinds) expect(Object.keys(k.cells)).toEqual(EP_BUCKETS.map((b) => b.key));
  });
});

describe('cap', () => {
  it('uses its own per-query cap and leaves the shared RUN_LIMIT alone', () => {
    expect(RUN_LIMIT).toBe(200);
    expect(EP_RUN_LIMIT).toBeGreaterThan(RUN_LIMIT);
  });
});
