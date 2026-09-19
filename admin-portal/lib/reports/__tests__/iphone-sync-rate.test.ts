/**
 * Transfer rate — derivation tests (BACKLOG-3450)
 *
 * Rate is the one number on this report computed from two columns and a phase,
 * and the wrong build of it looks right: dividing by whole-run elapsed instead
 * of the transferring phase gives a plausible figure on every row. All four
 * rows on record that can produce a rate SEPARATE the two formulas, so the
 * transcribed corpus alone catches it.
 *
 * Both fallback branches have ZERO real rows, so each is exercised by a row
 * from `DERIVED_ROWS`, which says which query proved it absent.
 */

import { describe, expect, it } from 'vitest';
import {
  buildIphoneSyncReport,
  formatRate,
  transferRateMbPerSec,
  type SyncRun,
} from '../iphone-sync';
import {
  DERIVED_ROWS,
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
  ROW_IDS,
} from './iphone-sync.fixture';

function runsOf(rows = FIXTURE_ROWS_24): SyncRun[] {
  return buildIphoneSyncReport(rows, FIXTURE_USERS_24).runs;
}

function byId(runs: SyncRun[], id: string): SyncRun {
  const run = runs.find((r) => r.id === id);
  if (!run) throw new Error(`no run ${id}`);
  return run;
}

/**
 * Transcribed alongside the rows, from:
 *
 *   select created_at, backup_bytes,
 *          round((backup_bytes/1048576.0) / ((phases->..->>'elapsed_ms')::numeric/1000.0), 2) as by_transfer,
 *          round((backup_bytes/1048576.0) / (elapsed_ms/1000.0), 2)               as by_elapsed
 *   from sync_outcomes where source='iphone-backup' and backup_bytes > 0;
 *
 * The right-hand column is what the WRONG implementation produces.
 */
const RATE_ROWS = [
  { id: ROW_IDS.rate0918, byTransfer: 22.76, byElapsed: 19.68 },
  { id: ROW_IDS.rate0915evening, byTransfer: 21.14, byElapsed: 17.52 },
  { id: ROW_IDS.rate0915afternoon, byTransfer: 27.37, byElapsed: 25.27 },
  { id: ROW_IDS.rate0914, byTransfer: 27.29, byElapsed: 24.53 },
];

describe('rate is measured over the transferring phase, not the whole run', () => {
  const runs = runsOf();

  it('reproduces all four transcribed rates to the cent', () => {
    for (const expected of RATE_ROWS) {
      const run = byId(runs, expected.id);
      expect(run.rateMbPerSec).not.toBeNull();
      expect(Number(run.rateMbPerSec!.toFixed(2))).toBe(expected.byTransfer);
    }
  });

  it('is NOT the whole-run figure on any of them', () => {
    for (const expected of RATE_ROWS) {
      const run = byId(runs, expected.id);
      expect(Number(run.rateMbPerSec!.toFixed(2))).not.toBe(expected.byElapsed);
    }
  });

  it('reads the transferring phase s own duration, not a cumulative elapsed', () => {
    const run = byId(runs, ROW_IDS.rate0918);
    expect(run.transferMs).toBe(198742);
    expect(run.elapsedMs).toBe(229836);
  });
});

describe('a run that measured no bytes has NO rate', () => {
  const runs = runsOf();

  it('leaves rate null on every run without a numerator — 20 of the 24', () => {
    const withRate = runs.filter((r) => r.rateMbPerSec != null).map((r) => r.id).sort();
    expect(withRate).toEqual(RATE_ROWS.map((r) => r.id).sort());
    expect(runs).toHaveLength(24);
  });

  it('treats a MEASURED zero as no rate, not as a rate of zero', () => {
    const [zero] = runsOf([DERIVED_ROWS.zeroBackupBytes]);
    expect(zero.rateMbPerSec).toBeNull();
    expect(zero.rateLabel).toBe('—');
    expect(zero.rateLabel).not.toContain('0.0');
  });
});

describe('the two fallback branches — DERIVED, zero real rows exercise them', () => {
  it('falls back to whole-run elapsed when there is no transferring phase', () => {
    const [run] = runsOf([DERIVED_ROWS.backupWithoutTransferPhase]);
    expect(run.transferMs).toBeNull();
    // 1 048 576 B = 1 MB over 2 000 ms = 0.5 MB/s
    expect(run.rateMbPerSec).toBeCloseTo(0.5, 6);
  });

  it('falls back to bytes_transferred when backup_bytes never arrived', () => {
    const [run] = runsOf([DERIVED_ROWS.bytesTransferredOnly]);
    expect(run.bytesTransferred).toBe(2097152);
    // 2 MB over the 4 000 ms transferring phase = 0.5 MB/s
    expect(run.rateMbPerSec).toBeCloseTo(0.5, 6);
    expect(run.rateLabel).toBe('0.5 MB/s');
  });
});

describe('transferRateMbPerSec, unit', () => {
  it('uses 1 MiB, not 1 000 000 bytes', () => {
    expect(transferRateMbPerSec({
      backupBytes: 1048576, bytesTransferred: null, transferMs: 1000, elapsedMs: 1000,
    })).toBe(1);
  });

  it('is null when nothing measured a numerator', () => {
    for (const input of [
      { backupBytes: null, bytesTransferred: null, transferMs: 1000, elapsedMs: 1000 },
      { backupBytes: 0, bytesTransferred: 0, transferMs: 1000, elapsedMs: 1000 },
    ]) {
      expect(transferRateMbPerSec(input)).toBeNull();
    }
  });

  it('is null when nothing measured a denominator either', () => {
    expect(transferRateMbPerSec({
      backupBytes: 1048576, bytesTransferred: null, transferMs: null, elapsedMs: null,
    })).toBeNull();
    expect(transferRateMbPerSec({
      backupBytes: 1048576, bytesTransferred: null, transferMs: 0, elapsedMs: 0,
    })).toBeNull();
  });

  it('prefers backup_bytes over bytes_transferred when both are present', () => {
    const rate = transferRateMbPerSec({
      backupBytes: 2097152, bytesTransferred: 1048576, transferMs: 1000, elapsedMs: 1000,
    });
    expect(rate).toBe(2);
  });
});

describe('formatRate', () => {
  it('never renders a real rate as zero', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.01)).toBe('<0.1 MB/s');
    expect(formatRate(21.14)).toBe('21.1 MB/s');
  });
});

describe('sync type', () => {
  it('reads the three states, and calls a NULL "not recorded"', () => {
    const runs = runsOf();
    const counts = { first: 0, incremental: 0, unknown: 0 };
    for (const run of runs) counts[run.syncType] += 1;
    // Measured: select incremental, count(*) from sync_outcomes
    //   where source='iphone-backup' group by 1;  →  f 5 | t 8 | null 11
    expect(counts).toEqual({ first: 5, incremental: 8, unknown: 11 });
    expect(runs.find((r) => r.syncType === 'unknown')!.syncTypeLabel).toBe('not recorded');
  });
});
