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
    expect(html).toMatch(/data-code="phone_unreachable"[\s\S]*Your phone isn(?:'|&#x27;|&#39;)t connected\./);
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

  // SR: the empty-chat count and "phone gone partway"; older rows say "not
  // recorded". Mutation: the keys not parsed → red.
  it('the open row: empty chats and phone gone partway', () => {
    const run = buildGoogleMessagesSyncReport([row({ source_metrics: { reading: { ms: 1000, empty_chats: 2, phone_disconnected: true } } })], []).runs[0];
    expect(run.reading).toMatchObject({ emptyChats: 2, phoneDisconnected: true });
    const html = renderToStaticMarkup(<GmRunDetail run={run} />);
    expect(html).toMatch(/Empty chats[\s\S]*>2<[\s\S]*Phone gone partway[\s\S]*>yes</);
    const old = buildGoogleMessagesSyncReport([row({ source_metrics: { reading: { ms: 1000 } } })], []).runs[0];
    expect(old.reading).toMatchObject({ emptyChats: null, phoneDisconnected: null });
  });

  // Live A/B (visible vs hidden tab): the step totals and the hidden time.
  // Mutations: a key not parsed; "not recorded" missing for an older row → red.
  it('the open row: the steps and the hidden time; older rows say "not recorded"', () => {
    const timed = buildGoogleMessagesSyncReport([
      row({
        source_metrics: {
          reading: {
            ms: 60_000, details_ms: 2_100, history_ms: 30_000, settle_ms: 4_987, commit_ms: 600,
            photo_read_ms: 800, photo_upload_ms: 120, photo_read_max_ms: 500, photo_upload_max_ms: 40,
          },
          end: { hidden_ms: 22_154, hidden_spells: 3 },
        },
      }),
    ], []).runs[0];
    expect(timed.reading).toMatchObject({ detailsMs: 2_100, historyMs: 30_000, settleMs: 4_987, commitMs: 600, photoReadMs: 800, photoUploadMs: 120, photoReadMaxMs: 500, photoUploadMaxMs: 40 });
    const html = renderToStaticMarkup(<GmRunDetail run={timed} />);
    expect(html).toMatch(/data-stage="steps"[\s\S]*Details open \/ close[\s\S]*2\.1 s[\s\S]*History load[\s\S]*30\.0 s[\s\S]*Settle[\s\S]*5\.0 s[\s\S]*Commit \(send\)[\s\S]*600 ms/);
    expect(html).toMatch(/Photo read · slowest[\s\S]*800 ms · 500 ms[\s\S]*Photo upload · slowest[\s\S]*120 ms · 40 ms/);
    expect(html).toMatch(/Tab hidden[\s\S]*22\.2 s · 3 times · 22%/);
    const old = buildGoogleMessagesSyncReport([row({ source_metrics: { reading: { ms: 1000 } } })], []).runs[0];
    const oldHtml = renderToStaticMarkup(<GmRunDetail run={old} />);
    const steps = oldHtml.slice(oldHtml.indexOf('data-stage="steps"'), oldHtml.indexOf('data-stage="saving"'));
    expect(steps.match(/not recorded/g)?.length).toBe(7);
  });
});
