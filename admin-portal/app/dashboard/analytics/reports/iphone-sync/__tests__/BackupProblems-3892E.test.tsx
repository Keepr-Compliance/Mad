/**
 * BACKLOG-3892 E: the iPhone sync report names saved-backup problems.
 *
 * Inputs are transcribed from the desktop producers, not invented:
 *  - reason_code / ended_by: deviceSyncOrchestrator refuseForAtRest (BackupAtRestRefusal
 *    reasons, or BACKUP_DAMAGED), the parse-copy refusal, stopForAppleEncryptedBackup.
 *  - source_metrics: electron/services/syncOutcomeSupabase.ts backupEncryptionMetrics,
 *    which carries keptBackup "quarantined" + keptBackupReason "damaged" | "key-missing"
 *    (pinned by electron/services/atRest/__tests__/backupProblem-3892E.test.ts).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildIphoneSyncReport,
  endedByLabel,
  keptBackupLabel,
  reasonCodeLabel,
  type SyncRun,
} from '@/lib/reports/iphone-sync';
import { getIphoneSyncRuns } from '@/lib/reports/iphone-sync-queries';
import { FIXTURE_USERS_24, FOUNDER_QA_ROW } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { RunCard } from '../RunCard';

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

function runOf(overrides: Record<string, unknown>): SyncRun {
  return buildIphoneSyncReport([{ ...FOUNDER_QA_ROW, ...overrides }], FIXTURE_USERS_24).runs[0];
}

describe('every at-rest reason the desktop app can record has a label', () => {
  it('reasons (BackupAtRestRefusal union minus cancelled, plus BACKUP_DAMAGED and APPLE_ENCRYPTED_BACKUP)', () => {
    for (const code of ['busy', 'key-unavailable', 'disk-space', 'unreadable', 'BACKUP_DAMAGED', 'APPLE_ENCRYPTED_BACKUP']) {
      expect(reasonCodeLabel(code), code).not.toBe(code);
    }
    expect(reasonCodeLabel('BACKUP_DAMAGED')).toBe('The saved backup is damaged');
  });

  it('ended_by values', () => {
    for (const value of ['backup-at-rest', 'backup-encryption']) {
      expect(endedByLabel(value), value).not.toBe(value);
    }
  });
});

describe('the kept backup, from source_metrics', () => {
  it('names the reason, and nothing when the backup was not moved aside', () => {
    expect(keptBackupLabel({ keptBackup: 'quarantined', keptBackupReason: 'damaged' })).toBe(
      'Damaged: moved aside, full backup made'
    );
    expect(keptBackupLabel({ keptBackup: 'quarantined', keptBackupReason: 'key-missing' })).toBe(
      'Key not on this computer: moved aside, full backup made'
    );
    expect(keptBackupLabel({ keptBackup: 'quarantined' })).toBe('Unreadable: moved aside, full backup made');
    expect(keptBackupLabel({ phoneBackupEncryption: 'off' })).toBeNull();
    expect(keptBackupLabel(null)).toBeNull();
    expect(keptBackupLabel('quarantined')).toBeNull();
  });

  it('shows on the run card', () => {
    const run = runOf({ source_metrics: { keptBackup: 'quarantined', keptBackupReason: 'damaged' } });
    expect(run.keptBackupLabel).toBe('Damaged: moved aside, full backup made');
    const body = text(renderToStaticMarkup(<RunCard run={run} />));
    expect(body).toContain('Kept backup');
    expect(body).toContain('Damaged: moved aside, full backup made');
    const plain = text(renderToStaticMarkup(<RunCard run={runOf({ source_metrics: null })} />));
    expect(plain).not.toContain('Kept backup');
  });

  it('a damaged-backup stop reads in words on the card', () => {
    const run = runOf({ ended_by: 'backup-at-rest', reason_code: 'BACKUP_DAMAGED' });
    const body = text(renderToStaticMarkup(<RunCard run={run} />));
    expect(body).toContain('Stopped by a problem with the saved backup');
    expect(body).toContain('The saved backup is damaged');
  });

  it('the iPhone query reads source_metrics', async () => {
    const selects: string[] = [];
    const builder: Record<string, unknown> = {
      then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    for (const m of ['eq', 'neq', 'gte', 'lt', 'order', 'limit', 'in', 'not']) builder[m] = () => builder;
    builder.select = (cols: string) => {
      selects.push(cols);
      return builder;
    };
    const client = { from: () => builder } as unknown as SupabaseClient;
    await getIphoneSyncRuns(client, { fromIso: '2026-10-01T00:00:00Z', toIso: '2026-10-08T00:00:00Z' } as never);
    expect(selects[0]).toContain('source_metrics');
  });
});
