/**
 * iPhone Sync Performance — derivation tests (BACKLOG-3441)
 *
 * Runs against the 19 real `sync_outcomes` rows (identifiers replaced — see the
 * fixture header). Set membership is asserted by identity, never by count
 * alone, so a rule that flags the wrong three runs cannot pass.
 */

import { describe, expect, it } from 'vitest';
import {
  buildIphoneSyncReport,
  buildRun,
  formatDuration,
  formatMinPerGb,
  formatMinutes,
  formatMinutesLabel,
  formatUtc,
  isStalled,
  longestPhase,
  minutesPerGb,
  parsePhases,
  phaseLabel,
  ratioToBaseline,
  STALL_THRESHOLD_MINUTES,
  type SyncOutcomeRow,
} from '../iphone-sync';
import {
  FIXTURE_ROWS,
  FIXTURE_USERS,
  INCIDENT_ROW_ID,
  IN_PROGRESS_ROWS,
  ROWS_WITH_IN_PROGRESS,
} from './iphone-sync.fixture';

const report = buildIphoneSyncReport(FIXTURE_ROWS, FIXTURE_USERS);

/** The two 30.6-minute runs that both sat in `backup:waiting-for-device`. */
const WAITING_STALL_IDS = [
  'a0000013-0000-4000-8000-000000000013', // pii-allow-uuid: synthetic fixture id
  'a0000015-0000-4000-8000-000000000015', // pii-allow-uuid: synthetic fixture id
];

describe('buildIphoneSyncReport against the real 19 rows', () => {
  it('counts every run by outcome without inventing a fourth bucket', () => {
    expect(report.totalRuns).toBe(19);
    expect(report.counts).toEqual({ complete: 3, cancelled: 5, error: 11, other: 0 });
  });

  it('flags exactly the three runs that burned time and extracted nothing', () => {
    expect(report.stalled.map((r) => r.id).sort()).toEqual(
      [INCIDENT_ROW_ID, ...WAITING_STALL_IDS].sort()
    );
  });

  it('puts the 2026-09-16 incident first in the flagged list', () => {
    expect(report.stalled[0].id).toBe(INCIDENT_ROW_ID);
    expect(report.stalled[0].durationLabel).toBe('3h 1m');
    expect(formatMinutes(report.stalled[0].elapsedMs)).toBe('181.7');
    expect(report.stalled[0].messagesExtracted).toBeNull();
  });

  it('does not flag the three completed runs, however long they took', () => {
    const completed = report.runs.filter((r) => r.outcome === 'complete');
    expect(completed).toHaveLength(3);
    expect(completed.every((r) => !r.stalled)).toBe(true);
    // The longest completed run is 79 minutes — well past the threshold.
    expect(Math.max(...completed.map((r) => r.elapsedMs ?? 0))).toBeGreaterThan(
      STALL_THRESHOLD_MINUTES * 60_000
    );
  });

  it('keeps the full list newest-first', () => {
    expect(report.runs[0].whenUtc).toBe('2026-09-17 18:58 UTC');
    expect(report.runs[report.runs.length - 1].whenUtc).toBe('2026-09-14 18:41 UTC');
  });

  it('resolves user labels and falls back rather than throwing', () => {
    expect(report.stalled[0].userLabel).toBe('Sync user E');
    const orphan = buildRun({ ...FIXTURE_ROWS[2], user_id: null }, new Map());
    expect(orphan.userLabel).toBe('Unknown user');
  });
});

describe('minutes per GB and the baseline', () => {
  it('derives the baseline from completed runs only', () => {
    expect(report.baseline.sampleSize).toBe(3);
    expect(report.baseline.medianMinPerGb).toBeCloseTo(1.572, 2);
  });

  it('reports the spread across completed runs, which is wide', () => {
    expect(report.baseline.spread).not.toBeNull();
    expect(report.baseline.spread!.min).toBeCloseTo(0.723, 2);
    expect(report.baseline.spread!.max).toBeCloseTo(1.925, 2);
  });

  it('puts the incident at twice the baseline', () => {
    const incident = report.stalled[0];
    expect(incident.minPerGb).toBeCloseTo(3.138, 2);
    expect(ratioToBaseline(incident, report.baseline)).toBeCloseTo(2.0, 1);
  });

  it('returns null rather than Infinity when the device size is missing', () => {
    expect(minutesPerGb({ elapsed_ms: 60000, device_used_bytes: null })).toBeNull();
    expect(minutesPerGb({ elapsed_ms: 60000, device_used_bytes: 0 })).toBeNull();
    expect(minutesPerGb({ elapsed_ms: null, device_used_bytes: 1024 ** 3 })).toBeNull();
  });

  it('returns null from ratioToBaseline when there is no baseline', () => {
    const empty = buildIphoneSyncReport([], []);
    expect(empty.baseline.medianMinPerGb).toBeNull();
    expect(empty.baseline.spread).toBeNull();
    expect(ratioToBaseline(report.stalled[0], empty.baseline)).toBeNull();
  });
});

describe('the stall rule', () => {
  it('ignores the reported outcome — a "complete" run that extracts nothing is flagged', () => {
    expect(
      isStalled({ elapsed_ms: STALL_THRESHOLD_MINUTES * 60_000, messages_extracted: 0 })
    ).toBe(true);
    expect(
      isStalled({ elapsed_ms: STALL_THRESHOLD_MINUTES * 60_000, messages_extracted: null })
    ).toBe(true);
  });

  it('does not flag a long run that produced messages', () => {
    expect(
      isStalled({ elapsed_ms: 10 * 60 * 60_000, messages_extracted: 1 })
    ).toBe(false);
  });

  it('does not flag a short run that produced nothing', () => {
    expect(
      isStalled({ elapsed_ms: STALL_THRESHOLD_MINUTES * 60_000 - 1, messages_extracted: null })
    ).toBe(false);
  });

  it('does not flag a run with no elapsed time at all', () => {
    expect(isStalled({ elapsed_ms: null, messages_extracted: null })).toBe(false);
  });
});

describe('phases', () => {
  it('reads the incident phase breakdown in order, longest last', () => {
    const incident = report.stalled[0];
    expect(incident.phases.map((p) => p.key)).toEqual([
      'backup',
      'backup:waiting-for-device',
      'backup:transferring',
    ]);
    expect(incident.lastPhaseLabel).toBe('Transferring backup from device');
    expect(longestPhase(incident)!.key).toBe('backup:transferring');
    expect(longestPhase(incident)!.durationLabel).toBe('2h 49m');
    expect(incident.phases[1].durationLabel).toBe('11m 59s');
  });

  it('marks only the final phase as last', () => {
    const incident = report.stalled[0];
    expect(incident.phases.filter((p) => p.isLast).map((p) => p.key)).toEqual([
      'backup:transferring',
    ]);
  });

  it('renders an unknown phase under its own name instead of dropping it', () => {
    // BACKLOG-3440 will add phases; they must appear the day they ship.
    expect(phaseLabel('backup:verifying-manifest')).toBe('backup:verifying-manifest');
    const row: SyncOutcomeRow = {
      ...FIXTURE_ROWS[2],
      phases: [{ phase: 'backup:verifying-manifest', elapsed_ms: 1000 }],
    };
    const run = buildRun(row, new Map());
    expect(run.phases.map((p) => p.label)).toEqual(['backup:verifying-manifest']);
  });

  it('survives every malformed shape the jsonb column could hold', () => {
    expect(parsePhases(null)).toEqual([]);
    expect(parsePhases(undefined)).toEqual([]);
    expect(parsePhases([])).toEqual([]);
    expect(parsePhases({ backup: 5 })).toEqual([]);
    expect(parsePhases([null, 'backup', 7])).toEqual([]);
    expect(parsePhases([{ phase: 'backup' }])).toEqual([]);
    expect(parsePhases([{ phase: 'backup', elapsed_ms: 'slow' }])).toEqual([]);
    expect(parsePhases([{ phase: 'backup', elapsed_ms: 12 }])).toEqual([
      { phase: 'backup', elapsed_ms: 12 },
    ]);
  });

  it('shares add up to 100 for a run with phases', () => {
    const completed = report.runs.find((r) => r.outcome === 'complete')!;
    const total = completed.phases.reduce((sum, p) => sum + p.sharePct, 0);
    expect(total).toBeCloseTo(100, 6);
  });
});

describe('formatting', () => {
  it('formats durations without lying about missing values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    // A 92 ms phase must not read as "0s" — that looks like it did not run.
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(92)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5325)).toBe('5s');
    expect(formatDuration(59297)).toBe('59s');
    expect(formatDuration(154212)).toBe('2m 34s');
    expect(formatDuration(10901598)).toBe('3h 1m');
  });

  it('never rounds a nonzero minutes-per-GB down to 0.0', () => {
    // A 59-second run against a 27 GB phone is 0.037 min/GB. "0.0 min/GB"
    // would read as "instant", which is the opposite of the truth.
    expect(formatMinPerGb(0.037)).toBe('<0.1 min/GB');
    expect(formatMinPerGb(null)).toBe('—');
    expect(formatMinPerGb(0.4)).toBe('0.4 min/GB');
    expect(formatMinPerGb(3.138)).toBe('3.1 min/GB');
  });

  it('never rounds a nonzero run down to "0.0 min"', () => {
    expect(formatMinutesLabel(2227)).toBe('<0.1 min');
    expect(formatMinutesLabel(null)).toBe('\u2014');
    expect(formatMinutesLabel(10901598)).toBe('181.7 min');
    expect(formatMinutesLabel(0)).toBe('0.0 min');
  });

  it('formats timestamps as fixed UTC, not a server locale', () => {
    expect(formatUtc('2026-09-16T20:42:49.550685Z')).toBe('2026-09-16 20:42 UTC');
    expect(formatUtc('not-a-date')).toBe('—');
  });
});

describe('degenerate inputs', () => {
  it('builds an empty report without throwing', () => {
    const empty = buildIphoneSyncReport([], []);
    expect(empty.totalRuns).toBe(0);
    expect(empty.runs).toEqual([]);
    expect(empty.stalled).toEqual([]);
    expect(empty.counts).toEqual({ complete: 0, cancelled: 0, error: 0, other: 0 });
  });

  it('builds a single-row report with no phases and no device size', () => {
    const single = buildIphoneSyncReport([FIXTURE_ROWS[17]], FIXTURE_USERS);
    expect(single.totalRuns).toBe(1);
    expect(single.runs[0].phases).toEqual([]);
    expect(single.runs[0].lastPhaseLabel).toBeNull();
    expect(single.runs[0].minPerGb).toBeNull();
    expect(single.runs[0].minPerGbLabel).toBe('—');
    expect(single.stalled).toEqual([]);
  });

  it('counts an unrecognised outcome as "other" rather than dropping the run', () => {
    const odd = buildIphoneSyncReport(
      [{ ...FIXTURE_ROWS[0], outcome: 'interrupted' }],
      FIXTURE_USERS
    );
    expect(odd.counts).toEqual({ complete: 0, cancelled: 0, error: 0, other: 1 });
    expect(odd.runs).toHaveLength(1);
  });
});

/**
 * BACKLOG-3440 added a fourth `outcome`, `running`, written when a sync starts
 * and refreshed while it is alive. Every aggregate in this report reads a row
 * as a finished run, so those rows have to be gone before any of it happens.
 *
 * The case that matters is the first one: a healthy first sync 47 minutes in
 * has burned the time and stored nothing, which is character for character the
 * shape of the stall rule. Counted, the headline flag would fire on a run that
 * is fine — every day, on the page whose entire job is to say when something is
 * wrong.
 */
describe('runs still in flight are not runs', () => {
  const withLive = buildIphoneSyncReport(ROWS_WITH_IN_PROGRESS, FIXTURE_USERS);

  it('does not flag a live sync that is past the threshold with nothing extracted', () => {
    const live = IN_PROGRESS_ROWS[0];
    // The row really does match the stall rule on its own terms — this is not
    // a test that passes because the fixture is harmless.
    expect(live.elapsed_ms).toBeGreaterThan(STALL_THRESHOLD_MINUTES * 60_000);
    expect(isStalled(live)).toBe(true);

    expect(withLive.stalled.map((r) => r.id)).not.toContain(live.id);
  });

  it('flags the same three finished runs it would without any live rows', () => {
    expect(withLive.stalled.map((r) => r.id)).toEqual(report.stalled.map((r) => r.id));
  });

  it('excludes live runs from the run list, the total and the outcome counts', () => {
    const liveIds = IN_PROGRESS_ROWS.map((r) => r.id);
    const listed = withLive.runs.map((r) => r.id);
    for (const id of liveIds) expect(listed).not.toContain(id);

    expect(withLive.totalRuns).toBe(19);
    expect(withLive.runs).toHaveLength(19);
    expect(withLive.counts).toEqual({ complete: 3, cancelled: 5, error: 11, other: 0 });
    // Not swept into the catch-all bucket either — dropped, not recategorised.
    expect(withLive.counts.other).toBe(0);
  });

  it('leaves the min/GB baseline exactly where it was', () => {
    expect(withLive.baseline).toEqual(report.baseline);
  });

  it('keeps counting an unknown outcome, because only `running` is excluded', () => {
    const odd = buildIphoneSyncReport(
      [{ ...FIXTURE_ROWS[0], outcome: 'interrupted' }, ...IN_PROGRESS_ROWS],
      FIXTURE_USERS
    );
    expect(odd.totalRuns).toBe(1);
    expect(odd.counts.other).toBe(1);
  });
});
