/**
 * BACKLOG-2950 PR-B: the run detail card shows the phone's own error code.
 *
 * Fixture codes are TRANSCRIBED, not invented. The producer is the desktop
 * backup path: `parseDeviceBackupError` reads the MBErrorDomain integer from
 * idevicebackup2's output (electron/services/backupService.ts:610, :635) and
 * the sync-outcome mapper writes it as `device_error_code`
 * (electron/services/syncOutcomeSupabase.ts:205). The two codes on
 * `public.sync_outcomes` on 2026-11-05 were 105 (INSUFFICIENT_SPACE,
 * device-error; MB_ERROR_HOST_DISK_FULL, backupService.ts:262) and 208
 * (DEVICE_LOCKED, device-error; MB_ERROR_DEVICE_LOCKED, backupService.ts:263).
 * FOUNDER_QA_ROW is one of the 105 rows. The 208 run below borrows that row's
 * other fields and takes the real 208 triple (code, reason, ended_by).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport, type SyncRun } from '@/lib/reports/iphone-sync';
import type { SyncOutcomeRow } from '@/lib/reports/iphone-sync';
import {
  FIXTURE_USERS_24,
  FOUNDER_QA_ROW,
} from '@/lib/reports/__tests__/iphone-sync.fixture';
import { RunCard } from '../RunCard';

function runFrom(row: SyncOutcomeRow): SyncRun {
  return buildIphoneSyncReport([row], FIXTURE_USERS_24).runs[0];
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

function card(row: SyncOutcomeRow): string {
  return text(renderToStaticMarkup(<RunCard run={runFrom(row)} />));
}

const LOCKED_ROW: SyncOutcomeRow = {
  ...FOUNDER_QA_ROW,
  device_error_code: 208,
  reason_code: 'DEVICE_LOCKED',
  ended_by: 'device-error',
};

describe('BACKLOG-2950: the phone error code on the run detail card', () => {
  it('carries the code from the row onto the run', () => {
    expect(runFrom(FOUNDER_QA_ROW).deviceErrorCode).toBe(105);
    expect(runFrom(LOCKED_ROW).deviceErrorCode).toBe(208);
  });

  it('renders the code beside the reason', () => {
    expect(card(FOUNDER_QA_ROW)).toContain("Phone's error code 105");
    expect(card(LOCKED_ROW)).toContain("Phone's error code 208");
  });

  it('renders nothing for a run with no code, as every other evidence field does', () => {
    const body = card({ ...FOUNDER_QA_ROW, device_error_code: null });
    expect(body).not.toContain("Phone's error code");
    expect(body).not.toContain('null');
    // The rest of the evidence list still renders.
    expect(body).toContain('Reason');
  });

  it('renders nothing when the column is absent from the row (older builds)', () => {
    const { device_error_code: _omit, ...older } = FOUNDER_QA_ROW;
    void _omit;
    expect(card(older)).not.toContain("Phone's error code");
  });
});
