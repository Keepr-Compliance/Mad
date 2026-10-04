/**
 * Google Messages Sync Performance — model, query and table tests (BACKLOG-3671 P2).
 *
 * Mutation controls (each turns a test red):
 *   R1 a missing / garbage source_metrics read as 0 (not "not recorded")   → "null-tolerant"
 *   R2 hidden % / chats / messages from the wrong field                    → "derived columns"
 *   R3 the failure breakdown not using the user's short line               → "breakdown"
 *   R4 the failure lines drifting from the desktop app / the extension    → "same lines"
 *   R5 the source not sent, or the iPhone report reading other sources    → "source"
 *   R6 dev builds not left out by default, or NULL is_packaged dropped    → "dev builds"
 *   R7 the GM columns not requested                                        → "columns"
 *   R8 the registry not listing the report                                 → "registry"
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyGmFilters,
  buildGoogleMessagesSyncReport,
  failureBreakdown,
  GM_EMPTY_FILTERS,
  GM_EXTRA_COLUMNS,
  GM_SOURCE,
  sortGmRuns,
  type GmSyncOutcomeRow,
} from '../google-messages-sync';
import { GM_FAILURE_LINES, gmReasonLine } from '../gm-failure-lines';
import { getIphoneSyncRuns, getSyncRuns } from '../iphone-sync-queries';
import { resolvePeriod } from '../period';
import { REPORTS } from '../registry';
import { REPORT_KEY } from '../report-views';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const WEEK = resolvePeriod({}, NOW);

function row(over: Partial<GmSyncOutcomeRow> = {}): GmSyncOutcomeRow {
  return {
    id: 'run-1',
    user_id: 'u-1',
    created_at: '2026-10-03T10:00:00.000Z',
    source: 'google-messages',
    outcome: 'complete',
    elapsed_ms: 100_000,
    phases: [],
    app_version: '2.38.1',
    platform: 'win32',
    is_packaged: true,
    ...over,
  };
}

const METRICS = {
  v: 1,
  run_kind: 'sync',
  finding: { ms: 4000, chats_found: 180, chats_in_range: 40, chats_skipped_hidden: 3, chats_skipped_disabled: 2 },
  reading: { ms: 80_000, chats_read: 38, chats_skipped: 1, chats_failed: 1, messages_read: 900, photos_read: 12, bytes_read: 3_145_728, per_chat_p50_ms: 1200, per_chat_p90_ms: 4800, per_chat_slowest_ms: 9000, per_chat_count: 40 },
  saving: { ms: 2000, messages_saved: 880, messages_new: 300, photos_saved: 12, bytes_saved: 2_097_152 },
  end: { outcome: 'complete', total_ms: 100_000, hidden_ms: 25_000, hidden_spells: 2 },
};

describe('the run model', () => {
  it('derived columns: chats read, messages saved, hidden %, p90; versions and run kind (R2)', () => {
    const { runs } = buildGoogleMessagesSyncReport(
      [row({ source_metrics: METRICS, run_kind: 'retry', extension_version: '0.3.53', chrome_version: '141.0.7390.55' })],
      [{ id: 'u-1', email: null, display_name: 'Test Agent' }]
    );
    const r = runs[0];
    expect(r).toMatchObject({
      chats: 38,
      messages: 880,
      hiddenPct: 25,
      perChatP90Ms: 4800,
      runKind: 'retry',
      runKindLabel: 'try again',
      extensionVersion: '0.3.53',
      chromeVersion: '141.0.7390.55',
      reasonCode: null,
    });
    expect(r.saving.bytesSaved).toBe(2_097_152);
    expect(r.finding.chatsFound).toBe(180);
  });

  it('null-tolerant: no / garbage source_metrics reads as not recorded, never 0 (R1)', () => {
    for (const metrics of [undefined, null, 'x', [1, 2], { reading: 'x', finding: [1] }, { reading: { chats_read: -1, messages_read: 'many' } }]) {
      const r = buildGoogleMessagesSyncReport([row({ source_metrics: metrics })], []).runs[0];
      expect([metrics, r.chats, r.messages, r.hiddenPct, r.perChatP90Ms, r.reading.ms, r.saving.messagesSaved]).toEqual([metrics, null, null, null, null, null, null]);
      expect(r.runKindLabel).toBe('not recorded');
      expect(r.extensionVersion).toBe('—');
    }
  });

  it('a running row is not a result', () => {
    expect(buildGoogleMessagesSyncReport([row({ outcome: 'running' }), row({ id: 'run-2' })], []).runs.map((r) => r.id)).toEqual(['run-2']);
  });

  it('the failure breakdown names what the user saw, most first (R3)', () => {
    const { runs } = buildGoogleMessagesSyncReport(
      [
        row({ id: 'a', outcome: 'error', reason_code: 'phone_unreachable' }),
        row({ id: 'b', outcome: 'error', reason_code: 'phone_unreachable' }),
        row({ id: 'c', outcome: 'cancelled', reason_code: 'user_stop' }),
        row({ id: 'd', outcome: 'error', reason_code: 'something_new' }),
        row({ id: 'e', outcome: 'error' }),
        row({ id: 'f' }),
      ],
      []
    );
    expect(failureBreakdown(runs)).toEqual([
      { code: 'phone_unreachable', line: 'Lost the connection to your phone.', runs: 2 },
      { code: 'not_recorded', line: 'Not recorded', runs: 1 },
      { code: 'something_new', line: 'The Sync stopped unexpectedly.', runs: 1 },
      { code: 'user_stop', line: 'Stopped on the page (Stop sync).', runs: 1 },
    ]);
    expect(runs.find((r) => r.id === 'a')!.reasonLine).toBe('Lost the connection to your phone.');
    expect(gmReasonLine(null)).toBeNull();
  });

  it('filters by run kind / outcome; sorts nulls last both ways', () => {
    const { runs } = buildGoogleMessagesSyncReport(
      [
        row({ id: 'a', run_kind: 'sync', source_metrics: { reading: { chats_read: 5 } } }),
        row({ id: 'b', run_kind: 'retry', outcome: 'error', source_metrics: { reading: { chats_read: 9 } } }),
        row({ id: 'c', run_kind: 'sync' }),
      ],
      []
    );
    expect(applyGmFilters(runs, { ...GM_EMPTY_FILTERS, types: ['sync'] }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(applyGmFilters(runs, { ...GM_EMPTY_FILTERS, outcomes: ['error'] }).map((r) => r.id)).toEqual(['b']);
    expect(sortGmRuns(runs, 'chats', 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortGmRuns(runs, 'chats', 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the same failure lines as the desktop app and the extension (R4)', () => {
  const repo = join(__dirname, '..', '..', '..', '..');
  const pairs = (src: string, table: string): Record<string, string> => {
    const body = src.slice(src.indexOf(table));
    const block = body.slice(body.indexOf('{') + 1, body.indexOf('};'));
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/^\s*([a-z_]+):\s*(["'])(.*)\2,?\s*$/gm)) out[m[1]] = m[3].replace(/\\'/g, "'");
    return out;
  };
  it('every code, every line', () => {
    const desktop = pairs(readFileSync(join(repo, 'src/components/settings/android/syncFailureLines.ts'), 'utf8'), 'SYNC_FAILURE_LINES');
    const extension = pairs(readFileSync(join(repo, 'chrome-extension/job.js'), 'utf8'), 'FAILURE_LINES = {');
    expect(Object.keys(desktop).length).toBeGreaterThan(10);
    expect(GM_FAILURE_LINES).toEqual(desktop);
    expect(GM_FAILURE_LINES).toEqual(extension);
  });
});

describe('the query (R5–R7)', () => {
  function stub() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const builder: Record<string, unknown> = {
      then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'order', 'limit', 'in', 'not']) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return builder;
      };
    }
    return { client: { from: () => builder } as unknown as SupabaseClient, calls };
  }
  const argsOf = (calls: Array<{ method: string; args: unknown[] }>, m: string) => calls.filter((c) => c.method === m).map((c) => c.args);

  it('reads its own source, dev builds left out by default (NULL kept), its own cap, the GM columns', async () => {
    const { client, calls } = stub();
    await getSyncRuns(client, WEEK, { source: GM_SOURCE, extraColumns: GM_EXTRA_COLUMNS });
    expect(argsOf(calls, 'eq')).toContainEqual(['source', 'google-messages']);
    expect(argsOf(calls, 'not')).toEqual([['is_packaged', 'is', false]]);
    expect(argsOf(calls, 'limit')).toEqual([[200]]);
    const select = String(argsOf(calls, 'select')[0][0]);
    for (const c of GM_EXTRA_COLUMNS) expect(select).toContain(c);
    expect(select).toContain('reason_code');
  });

  it('the iPhone report is unchanged: iphone-backup only, dev builds included, no GM columns', async () => {
    const { client, calls } = stub();
    await getIphoneSyncRuns(client, WEEK);
    expect(argsOf(calls, 'eq')).toEqual([['source', 'iphone-backup']]);
    expect(argsOf(calls, 'not')).toEqual([]);
    expect(String(argsOf(calls, 'select')[0][0])).not.toContain('source_metrics');
  });

  it('packagedOnly: false includes dev builds', async () => {
    const { client, calls } = stub();
    await getSyncRuns(client, WEEK, { source: GM_SOURCE, packagedOnly: false });
    expect(argsOf(calls, 'not')).toEqual([]);
  });
});

describe('registry and saved views (R8)', () => {
  it('both reports are listed, each with its own slug; the iPhone saved views keep their key', () => {
    expect(REPORTS.map((r) => r.slug)).toEqual(['iphone-sync', 'google-messages-sync']);
    expect(REPORT_KEY).toBe('iphone-sync');
  });
});
