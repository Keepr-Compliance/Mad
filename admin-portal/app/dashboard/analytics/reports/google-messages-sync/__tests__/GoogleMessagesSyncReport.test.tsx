/**
 * Google Messages Sync Performance — render tests (BACKLOG-3671 P2).
 *
 * Static renders (no router): the shared filter bar, charts and table carry
 * the GM columns; the failure breakdown says what the user saw; the open
 * row's card shows each stage's time, counts and size; an empty period says
 * it is a real zero. Mutations: an iPhone column on the GM table, the
 * breakdown's line or a stage's numbers missing → red.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildGoogleMessagesSyncReport, type GmSyncOutcomeRow } from '@/lib/reports/google-messages-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { GmRunDetail, GoogleMessagesSyncReport } from '../GoogleMessagesSyncReport';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const WEEK = resolvePeriod({}, NOW);

function row(over: Partial<GmSyncOutcomeRow>): GmSyncOutcomeRow {
  return {
    id: 'run-1',
    user_id: 'u-1',
    created_at: '2026-10-01T10:00:00.000Z',
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

const ROWS = [
  row({
    id: 'run-1',
    run_kind: 'sync',
    extension_version: '0.3.53',
    chrome_version: '141.0.7390.55',
    source_metrics: {
      finding: { ms: 4000, chats_found: 180, chats_in_range: 40 },
      reading: { ms: 80_000, chats_read: 38, messages_read: 900, photos_read: 12, bytes_read: 3_145_728, per_chat_p50_ms: 1200, per_chat_p90_ms: 4800 },
      saving: { ms: 2000, messages_saved: 880, messages_new: 300, photos_saved: 12, bytes_saved: 2_097_152 },
      end: { hidden_ms: 25_000 },
    },
  }),
  row({ id: 'run-2', outcome: 'error', reason_code: 'phone_unreachable', created_at: '2026-10-02T10:00:00.000Z' }),
];

describe('GoogleMessagesSyncReport', () => {
  it('the GM columns, the breakdown in the user’s words, the shared charts', () => {
    const html = renderToStaticMarkup(
      <GoogleMessagesSyncReport report={buildGoogleMessagesSyncReport(ROWS, [])} period={WEEK} rowCap={200} />
    );
    for (const header of ['Chats', 'Messages', 'Hidden %', 'p90 per chat', 'Failure code']) expect(html).toContain(header);
    for (const iphoneOnly of ['Backup', 'Rate', 'MB/s', 'not measured']) expect(html).not.toContain(iphoneOnly);
    expect(html).toContain('38');
    expect(html).toContain('880');
    expect(html).toContain('25%');
    expect(html).toContain('4.8 s');
    expect(html).toContain('phone_unreachable');
    expect(html).toMatch(/data-code="phone_unreachable"[\s\S]*Lost the connection to your phone\./);
    expect(html).toContain('Average duration per finished run');
  });

  it('an empty period: a real zero, and nothing to break down', () => {
    const html = renderToStaticMarkup(<GoogleMessagesSyncReport report={buildGoogleMessagesSyncReport([], [])} period={WEEK} rowCap={200} />);
    expect(html).toContain('No finished runs in this period');
    expect(html).toContain('Every run in this view completed.');
  });

  it('the open row: each stage’s time, counts and size', () => {
    const run = buildGoogleMessagesSyncReport(ROWS, []).runs[0];
    const html = renderToStaticMarkup(<GmRunDetail run={run} />);
    expect(html).toMatch(/data-stage="finding"[\s\S]*Finding · 4\.0 s[\s\S]*180/);
    expect(html).toMatch(/data-stage="reading"[\s\S]*Reading · 1m 20s[\s\S]*Messages read[\s\S]*900[\s\S]*3\.0 MB/);
    expect(html).toMatch(/data-stage="saving"[\s\S]*Saving · 2\.0 s[\s\S]*880[\s\S]*300[\s\S]*2\.0 MB/);
    expect(html).toContain('extension 0.3.53');
    expect(html).toContain('Chrome 141.0.7390.55');
  });
});
