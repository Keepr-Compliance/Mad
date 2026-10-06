/**
 * Submissions report — derivation tests (BACKLOG-3715)
 *
 * Fixture rows are transcribed from their producers; see submissions.fixture.ts.
 */

import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../period';
import { stackSegments, COLOR_CANCELLED, COLOR_ERROR } from '../iphone-sync-charts';
import {
  bucketSubmissionsByDay,
  buildOpenAttempts,
  buildSubmissionsReport,
  computeCounts,
  failureTooltipLines,
  formatCountCell,
  isPastSweepWindow,
  isStalled,
  reasonLabel,
  stageLabel,
  STALL_MINUTES,
  statusOf,
  SWEEP_WINDOW_MINUTES,
} from '../submissions';
import {
  CANCELLED,
  COMMITTED_POST,
  COMMITTED_PRE,
  FAILED,
  FIXTURE_ORGS,
  FIXTURE_USERS,
  minutesAgo,
  NOW,
  OLD_OPEN,
  OPEN_ROWS,
  PERIOD_ROWS,
  REFUSED,
  row,
  RUNNING,
  STALLED,
  SWEPT,
  UNCONFIRMED,
  UNKNOWN_CODES,
} from './submissions.fixture';

const THIS_WEEK = resolvePeriod({}, NOW);
const build = (rows = PERIOD_ROWS) => buildSubmissionsReport(rows, FIXTURE_USERS, FIXTURE_ORGS, NOW);
const byId = (rows = PERIOD_ROWS) => new Map(build(rows).submissions.map((s) => [s.submissionId, s]));

describe('in-progress rows are attempts (SR condition 5)', () => {
  it('counts a single in_progress row in Attempts and puts it in the table', () => {
    const report = build([RUNNING]);
    expect(report.submissions.map((s) => s.submissionId)).toEqual([RUNNING.submission_id]);
    const counts = computeCounts(report.submissions);
    expect(counts.attempts).toBe(1);
    expect(counts.running).toBe(1);
  });

  it('counts every period row, open ones included', () => {
    expect(computeCounts(build().submissions).attempts).toBe(PERIOD_ROWS.length);
  });
});

describe('stalled at 30 minutes (C2) — boundary swept', () => {
  it.each([
    [0, false],
    [29.99, false],
    [30, true],
    [31, true],
  ])('open %s min → stalled %s', (minutes, expected) => {
    const r = row(50, { started_at: minutesAgo(minutes) });
    expect(isStalled(r, NOW)).toBe(expected);
    expect(statusOf(r, NOW)).toBe(expected ? 'stalled' : 'running');
  });

  it('never marks a finished row stalled, however old', () => {
    expect(isStalled(FAILED, NOW)).toBe(false);
    expect(STALL_MINUTES).toBe(30);
  });
});

describe('past the sweep window at 3 h (C7, SR condition 2) — boundary swept', () => {
  it.each([
    [179.99, false],
    [180, true],
    [181, true],
  ])('open %s min → flagged %s', (minutes, expected) => {
    expect(isPastSweepWindow(row(51, { started_at: minutesAgo(minutes) }), NOW)).toBe(expected);
  });

  it('is 180 minutes, and never applies to a finished row', () => {
    expect(SWEEP_WINDOW_MINUTES).toBe(180);
    expect(isPastSweepWindow(SWEPT, NOW)).toBe(false);
  });
});

describe('sweep vocabulary from the 3726 migration (SR condition 1)', () => {
  it('humanises outcome abandoned, stage server_sweep, reason swept', () => {
    const s = byId().get(SWEPT.submission_id)!;
    expect(s.status).toBe('abandoned');
    expect(s.statusLabel).toBe('Did not finish');
    expect(s.stageLabel).toBe('Server sweep');
    expect(s.reasonLabel).toBe('Removed by the server sweep');
  });
});

describe('unknown codes render raw (C4)', () => {
  it('shows an unknown stage, reason and count key under the raw name', () => {
    const s = byId().get(UNKNOWN_CODES.submission_id)!;
    expect(s.stageLabel).toBe('brand_new_stage');
    expect(s.reasonLabel).toBe('brand_new_reason');
    expect(s.counts).toEqual({ brand_new_counter: 4 });
    expect(reasonLabel('another_one')).toBe('another_one');
    expect(stageLabel(null)).toBe('—');
  });

  it('shows an unknown outcome raw rather than dropping the row', () => {
    const s = byId([row(52, { outcome: 'new_outcome' })]).get(row(52, {}).submission_id)!;
    expect(s.statusLabel).toBe('new_outcome');
  });
});

describe('counts: "—" only when the key is missing, any outcome (C6, SR condition 4)', () => {
  it('a committed row from BEFORE counts were recorded shows "—"', () => {
    const s = byId().get(COMMITTED_PRE.submission_id)!;
    expect(s.messages).toBeNull();
    expect(formatCountCell(s.messages)).toBe('—');
    expect(formatCountCell(s.files)).toBe('—');
  });

  it('a committed row from AFTER counts were recorded shows the numbers, zero included', () => {
    const s = byId().get(COMMITTED_POST.submission_id)!;
    expect(formatCountCell(s.messages)).toBe('12');
    expect(formatCountCell(s.files)).toBe('3');
    expect(formatCountCell(s.notIncluded)).toBe('0');
  });

  it('an open row with {} shows "—"; a failed row shows its numbers', () => {
    const m = byId();
    expect(formatCountCell(m.get(RUNNING.submission_id)!.messages)).toBe('—');
    expect(formatCountCell(m.get(FAILED.submission_id)!.messages)).toBe('40');
    expect(formatCountCell(m.get(SWEPT.submission_id)!.files)).toBe('—');
  });
});

describe('per-day buckets', () => {
  it('buckets an open row on the day it STARTED (C3)', () => {
    const late = row(53, { started_at: '2026-10-01T23:50:00.000Z' });
    const buckets = bucketSubmissionsByDay(build([late]).submissions, THIS_WEEK);
    expect(buckets.find((b) => b.dayIso === '2026-10-01')!.attempts).toBe(1);
    expect(buckets.find((b) => b.dayIso === '2026-10-02')!.attempts).toBe(0);
  });

  it('a finished row that ended the next day is still on its start day (C3)', () => {
    const crossing = row(54, {
      outcome: 'failed',
      started_at: '2026-10-01T23:50:00.000Z',
      ended_at: '2026-10-02T00:20:00.000Z',
    });
    const buckets = bucketSubmissionsByDay(build([crossing]).submissions, THIS_WEEK);
    expect(buckets.find((b) => b.dayIso === '2026-10-01')!.failed).toBe(1);
    expect(buckets.find((b) => b.dayIso === '2026-10-02')!.failed).toBe(0);
  });

  it('has every day of the range, empty ones included', () => {
    const buckets = bucketSubmissionsByDay([], THIS_WEEK);
    expect(buckets.map((b) => b.dayIso)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('failure stack: red = failed + unknown, amber = abandoned + stalled, never cancelled (C5)', () => {
    const sameDay = (n: number, over: Parameters<typeof row>[1]) =>
      row(n, { ...over, started_at: over.started_at ?? '2026-10-04T12:00:00.000Z' });
    const rows = [
      sameDay(60, { outcome: 'failed' }),
      sameDay(61, { outcome: 'unconfirmed' }),
      sameDay(62, { outcome: 'abandoned' }),
      sameDay(63, { outcome: 'in_progress', started_at: '2026-10-04T12:00:00.000Z' }), // 8 h → stalled
      sameDay(64, { outcome: 'cancelled' }),
      sameDay(65, { outcome: 'cancelled' }),
      sameDay(66, { outcome: 'committed' }),
    ];
    const day = bucketSubmissionsByDay(build(rows).submissions, THIS_WEEK).find(
      (b) => b.dayIso === '2026-10-04'
    )!;
    expect(day.failed).toBe(2);
    expect(day.didNotFinish).toBe(2);
    expect(day.cancelled).toBe(2);
    const segs = stackSegments(
      { dayIso: day.dayIso, dayLabel: day.dayLabel, errors: day.failed, cancelled: day.didNotFinish, total: 4 },
      4
    );
    expect(segs.map((s) => s.color)).toEqual([COLOR_ERROR, COLOR_CANCELLED]);
    expect(failureTooltipLines(day)[1]).toBe('2 failed or unknown · 2 did not finish or stalled');
  });
});

describe('tiles', () => {
  it('computes every tile from the fixture', () => {
    const c = computeCounts(build().submissions);
    expect(c).toEqual({
      attempts: 10,
      committed: 2,
      committedPct: 20,
      failed: 4, // FAILED, REFUSED, UNKNOWN_CODES, UNCONFIRMED
      didNotFinish: 1,
      cancelled: 1,
      running: 1,
      stalled: 1,
    });
    void CANCELLED;
    void UNCONFIRMED;
    void REFUSED;
  });
});

describe('open attempts', () => {
  it('lists in_progress rows only, oldest first, and flags the 3 h+ one', () => {
    const open = buildOpenAttempts([...OPEN_ROWS, FAILED], FIXTURE_USERS, FIXTURE_ORGS, NOW);
    expect(open.map((s) => s.submissionId)).toEqual([
      OLD_OPEN.submission_id,
      STALLED.submission_id,
      RUNNING.submission_id,
    ]);
    expect(open.map((s) => s.pastSweepWindow)).toEqual([true, false, false]);
    expect(open.map((s) => s.status)).toEqual(['stalled', 'stalled', 'running']);
  });
});

describe('labels, no PII beyond agent and org', () => {
  it('uses display name, then email, and an 8-character submission id', () => {
    const m = byId();
    expect(m.get(RUNNING.submission_id)!.agentLabel).toBe('fixture agent 1');
    expect(m.get(STALLED.submission_id)!.agentLabel).toBe('agent.two@example.test');
    expect(m.get(RUNNING.submission_id)!.shortId).toBe(RUNNING.submission_id.slice(0, 8));
  });
});
