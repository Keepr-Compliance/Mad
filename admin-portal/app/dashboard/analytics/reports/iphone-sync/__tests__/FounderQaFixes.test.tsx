/**
 * The three fixes from the founder's QA of the round-2 preview (BACKLOG-3450,
 * pm_comments 475fc90f).
 *
 * He checked his own failed run field by field against `sync_outcomes` and
 * found the report accurate — with three exceptions, all in what the detail
 * card SAYS rather than in what it reads. {@link FOUNDER_QA_ROW} is that run,
 * transcribed, and each control below separates the fix from what he saw.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildIphoneSyncReport,
  BYTES_PER_GB,
  endedByLabel,
  formatGb,
  minutesPerGb,
  phaseLabel,
  reasonCodeLabel,
  type SyncRun,
} from '@/lib/reports/iphone-sync';
import {
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
  FOUNDER_QA_ROW,
} from '@/lib/reports/__tests__/iphone-sync.fixture';
import { RunCard } from '../RunCard';

const RUN: SyncRun = buildIphoneSyncReport([FOUNDER_QA_ROW], FIXTURE_USERS_24).runs[0];

function card(run: SyncRun = RUN): string {
  return renderToStaticMarkup(<RunCard run={run} />);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

describe('1. a run that moved nothing has no minutes per GB', () => {
  it('says "—", not the 0.1 min/GB the founder saw', () => {
    // 317 454 ms over a 58 GB phone was 0.0978, which rounds to "0.1 min/GB" —
    // a throughput figure for a run that wrote no backup at all.
    expect(FOUNDER_QA_ROW.backup_bytes).toBeNull();
    expect(FOUNDER_QA_ROW.backup_bytes_unmeasured).toBe(true);
    expect(RUN.minPerGb).toBeNull();
    expect(RUN.minPerGbLabel).toBe('—');
    expect(text(card())).not.toContain('0.1 min/GB');
  });

  it('is null for an UNMEASURED backup and for a measured ZERO alike', () => {
    const base = { elapsed_ms: 317454, device_used_bytes: 58063511552 };
    expect(minutesPerGb({ ...base, backup_bytes: null, backup_bytes_unmeasured: true })).toBeNull();
    expect(minutesPerGb({ ...base, backup_bytes: 0, backup_bytes_unmeasured: false })).toBeNull();
    expect(minutesPerGb({ ...base, backup_bytes: null, backup_bytes_unmeasured: null })).toBeNull();
    // A run that DID write a backup still gets one.
    expect(
      minutesPerGb({ ...base, backup_bytes: 40_000_000_000, backup_bytes_unmeasured: false })
    ).toBeCloseTo(0.0911, 3);
  });

  it('leaves the runs that DID move something with a figure', () => {
    const report = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24);
    // Exactly the runs that wrote a backup, and no others. FOUR of the 24, all
    // of them `complete` — counted, not guessed:
    //
    //   select count(*), count(*) filter (where outcome='complete')
    //   from sync_outcomes
    //   where source='iphone-backup' and outcome <> 'running'
    //     and created_at < '2026-09-19T00:00:00Z'
    //     and coalesce(backup_bytes,0) > 0
    //     and coalesce(backup_bytes_unmeasured,false) = false
    //     and device_used_bytes > 0 and elapsed_ms is not null;   -- 4, 4
    //
    // (The 19-row baseline suite sees 3 of them; the fourth is one of the five
    // rows written after that fixture was frozen.)
    const measured = report.runs.filter((r) => r.minPerGb != null);
    expect(measured).toHaveLength(4);
    expect(measured.every((r) => (r.backupGb ?? 0) > 0)).toBe(true);
    expect(measured.every((r) => r.outcome === 'complete')).toBe(true);
  });
});

describe('2. sizes are the ones the phone shows', () => {
  it('reads 58.1 GB, the figure in iOS Settings — not the 54.1 GB the card said', () => {
    expect(BYTES_PER_GB).toBe(1_000_000_000);
    expect(formatGb(58063511552)).toBe('58.1 GB');
    // What the binary divisor produced, for the record.
    expect((58063511552 / 1024 ** 3).toFixed(1)).toBe('54.1');
    expect(RUN.deviceUsedGb).toBeCloseTo(58.0635, 3);
    expect(text(card())).toContain('58.1 GB');
    expect(text(card())).not.toContain('54.1 GB');
  });
});

describe('3. the detail card is written for people, not for logs', () => {
  it('names the phase, the reason and what stopped it', () => {
    const body = text(card());
    expect(body).toContain('Waiting for device');
    expect(body).toContain('Not enough free space on the computer');
    expect(body).toContain('Stopped by an error from the phone');
  });

  it('does not print the raw code as the value', () => {
    // The phase chart beside it already said "Waiting for device"; the evidence
    // list said `backup:waiting-for-device` for the same thing.
    const body = text(card());
    expect(body).not.toContain('backup:waiting-for-device');
    expect(body).not.toContain('INSUFFICIENT_SPACE');
    expect(body).not.toContain('device-error');
  });

  it('keeps the raw code in a title, so a row can still be matched to a log', () => {
    const html = card();
    expect(html).toContain('title="backup:waiting-for-device"');
    expect(html).toContain('title="INSUFFICIENT_SPACE"');
    expect(html).toContain('title="device-error"');
  });

  it('falls back to the raw value for a code it does not know', () => {
    // A fourteenth error code must show up rather than disappear.
    expect(reasonCodeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(endedByLabel('something-new')).toBe('something-new');
    expect(phaseLabel('backup:something-new')).toBe('backup:something-new');
  });

  it('covers every code the desktop app can emit', () => {
    // TRANSCRIBED from electron/types/backupErrorCodes.ts, whose tuple a
    // compile-time assert keeps equal to the BackupErrorCode union.
    const codes = [
      'PASSWORD_REQUIRED',
      'INCORRECT_PASSWORD',
      'DEVICE_NOT_FOUND',
      'DEVICE_LOCKED',
      'BACKUP_CANCELLED',
      'BACKUP_TIMEOUT',
      'INSUFFICIENT_SPACE',
      'DECRYPTION_FAILED',
      'CONNECTION_LOST',
      'SERVICE_UNAVAILABLE',
      'BACKUP_FILE_MISSING',
      'INVALID_UDID',
      'UNKNOWN_ERROR',
    ];
    for (const code of codes) {
      expect(reasonCodeLabel(code), code).not.toBe(code);
    }

    // Every `endedBy` writer, traced: deviceSyncOrchestrator.ts:1423 / :1485 /
    // :1755, syncHandlers.ts:191 / :229, and the forceReset() default.
    for (const value of [
      'host-guard',
      'watchdog',
      'device-error',
      'user-cancel',
      'restart-while-running',
      'user-reset',
      'reset',
    ]) {
      expect(endedByLabel(value), value).not.toBe(value);
    }
  });
});

describe('the 2.38.1 evidence fields, on a real row at last', () => {
  it('renders all four, which no row in the 24-row corpus could', () => {
    const body = text(card());
    expect(body).toContain('Last phase');
    expect(body).toContain('Ended by');
    expect(body).toContain('Reason');
    // `bytes_transferred` is 0 here: the run really did move nothing.
    expect(RUN.bytesTransferred).toBe(0);
    expect(FIXTURE_ROWS_24.every((r) => r.reason_code == null)).toBe(true);
  });
});
