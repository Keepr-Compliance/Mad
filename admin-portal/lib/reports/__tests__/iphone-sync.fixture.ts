/**
 * Fixture for the iPhone Sync Performance report (BACKLOG-3441).
 *
 * SHAPE AND NUMBERS TRANSCRIBED from `public.sync_outcomes` on 2026-09-18 —
 * all 19 rows that existed in the table, including the 181.7-minute run that
 * motivated the report and the 79.1-minute success it is compared against.
 *
 * That sentence stays true because this set is FROZEN at those 19 rows. The
 * five rows written afterwards live in `FIXTURE_ROWS_24` at the foot of this
 * file, so the derivation suite's expected values do not move underneath it.
 *
 * IDENTIFIERS ARE NOT REAL. Every `id` and `user_id` is a synthetic UUID and
 * every display name and email is invented. This repository is public and a
 * real identifier in a fixture is exactly what BACKLOG-3087 was. The timings,
 * byte counts, outcomes, phase names, device models and extraction counts are
 * verbatim, because those are what the report has to render correctly.
 */

import type { ReportUser, SyncOutcomeRow } from '../iphone-sync';

const U1 = '11111111-1111-4111-8111-111111111111'; // pii-allow-uuid: synthetic fixture id, not a real user
const U2 = '22222222-2222-4222-8222-222222222222'; // pii-allow-uuid: synthetic fixture id, not a real user
const U3 = '33333333-3333-4333-8333-333333333333'; // pii-allow-uuid: synthetic fixture id, not a real user
const U4 = '44444444-4444-4444-8444-444444444444'; // pii-allow-uuid: synthetic fixture id, not a real user
const U5 = '55555555-5555-4555-8555-555555555555'; // pii-allow-uuid: synthetic fixture id, not a real user
const U6 = '66666666-6666-4666-8666-666666666666'; // pii-allow-uuid: synthetic fixture id, not a real user
const U7 = '77777777-7777-4777-8777-777777777777'; // pii-allow-uuid: synthetic fixture id, not a real user

/**
 * Deliberately not shaped like people's names. The fixture-PII guard reports a
 * `Firstname Lastname` string on a line with an email, and rightly so — the
 * cheapest way past that is to not invent a person in the first place.
 */
export const FIXTURE_USERS: ReportUser[] = [
  { id: U1, email: 'sync-user-a@example.test', display_name: 'Sync user A' },
  { id: U2, email: 'sync-user-b@example.test', display_name: 'Sync user B' },
  { id: U3, email: 'sync-user-c@example.test', display_name: 'Sync user C' },
  { id: U4, email: 'sync-user-d@example.test', display_name: 'Sync user D' },
  { id: U5, email: 'sync-user-e@example.test', display_name: 'Sync user E' },
  { id: U6, email: 'sync-user-f@example.test', display_name: 'Sync user F' },
  { id: U7, email: 'sync-user-g@example.test', display_name: 'Sync user G' },
];

function phase(name: string, ms: number) {
  return { phase: name, elapsed_ms: ms };
}

/** Newest first, exactly as `getIphoneSyncRuns` orders them. */
export const FIXTURE_ROWS: SyncOutcomeRow[] = [
  {
    id: 'a0000001-0000-4000-8000-000000000001', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-17T18:58:04.908279Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 60069,
    phases: [],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'darwin',
    is_packaged: false,
  },
  {
    id: 'a0000002-0000-4000-8000-000000000002', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-17T18:54:28.045856Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 60063,
    phases: [],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'darwin',
    is_packaged: false,
  },
  {
    // THE INCIDENT — 2026-09-16, 181.7 minutes, cancelled, nothing extracted.
    id: 'a0000003-0000-4000-8000-000000000003', // pii-allow-uuid: synthetic fixture id
    user_id: U5,
    created_at: '2026-09-16T20:42:49.550685Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 10901598,
    phases: [
      phase('backup', 26059),
      phase('backup:waiting-for-device', 719537),
      phase('backup:transferring', 10145797),
    ],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone18,2',
    device_ios_version: '26.6.1',
    device_used_bytes: 62169464832,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000004-0000-4000-8000-000000000004', // pii-allow-uuid: synthetic fixture id
    user_id: U2,
    created_at: '2026-09-15T21:58:54.652712Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 59297,
    phases: [phase('backup', 5465), phase('backup:waiting-for-device', 27520)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone16,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 28939374592,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000005-0000-4000-8000-000000000005', // pii-allow-uuid: synthetic fixture id
    user_id: U2,
    created_at: '2026-09-15T20:40:08.484463Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 703776,
    phases: [
      phase('backup', 5569),
      phase('backup:waiting-for-device', 65821),
      phase('backup:transferring', 628406),
    ],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone16,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 28894154752,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000006-0000-4000-8000-000000000006', // pii-allow-uuid: synthetic fixture id
    user_id: U4,
    created_at: '2026-09-15T19:43:48.191269Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 3187395,
    phases: [
      phase('backup', 5300),
      phase('backup:waiting-for-device', 58358),
      phase('backup:transferring', 2641081),
      phase('parsing-contacts', 92),
      phase('parsing-messages', 13742),
      phase('resolving', 62),
      phase('cleanup', 17),
      phase('storing:messages', 1355),
      phase('storing:contacts', 12003),
      phase('storing:attachments', 383183),
    ],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.3.1',
    device_used_bytes: 29634072576,
    backup_bytes: 58549778868,
    backup_bytes_unmeasured: null,
    messages_extracted: 127310,
    conversations_extracted: 1587,
    contacts_extracted: 3714,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000007-0000-4000-8000-000000000007', // pii-allow-uuid: synthetic fixture id
    user_id: U4,
    created_at: '2026-09-15T18:50:02.641938Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 40239,
    phases: [phase('backup', 5325), phase('backup:waiting-for-device', 31793)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.3.1',
    device_used_bytes: 29638713344,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000008-0000-4000-8000-000000000008', // pii-allow-uuid: synthetic fixture id
    user_id: U4,
    created_at: '2026-09-15T18:49:13.050645Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 34662,
    phases: [phase('backup', 5439), phase('backup:waiting-for-device', 25749)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.3.1',
    device_used_bytes: 29567074304,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000009-0000-4000-8000-000000000009', // pii-allow-uuid: synthetic fixture id
    user_id: U7,
    created_at: '2026-09-15T18:44:08.829797Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 2861341,
    phases: [
      phase('backup', 5326),
      phase('backup:waiting-for-device', 68727),
      phase('backup:transferring', 2641726),
      phase('parsing-contacts', 436),
      phase('parsing-messages', 11177),
      phase('resolving', 18),
      phase('cleanup', 25),
      phase('storing:messages', 682),
      phase('storing:contacts', 2534),
      phase('storing:attachments', 112500),
    ],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,2',
    device_ios_version: '26.6.2',
    device_used_bytes: 70804455424,
    backup_bytes: 75814063183,
    backup_bytes_unmeasured: null,
    messages_extracted: 77549,
    conversations_extracted: 2522,
    contacts_extracted: 10168,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000010-0000-4000-8000-000000000010', // pii-allow-uuid: synthetic fixture id
    user_id: U7,
    created_at: '2026-09-15T17:56:15.922085Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 311499,
    phases: [phase('backup', 5340), phase('backup:waiting-for-device', 304479)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone17,2',
    device_ios_version: '26.6.2',
    device_used_bytes: 70785171456,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    // The successful reference run — 79.1 minutes, 50.3 GB, 232,940 messages.
    id: 'a0000011-0000-4000-8000-000000000011', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T21:50:02.296434Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 4748916,
    phases: [
      phase('backup', 5412),
      phase('backup:waiting-for-device', 51989),
      phase('backup:transferring', 4268478),
      phase('parsing-contacts', 92),
      phase('parsing-messages', 29946),
      phase('resolving', 111),
      phase('cleanup', 11),
      phase('storing:messages', 680),
      phase('storing:contacts', 8015),
      phase('storing:attachments', 271768),
    ],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 54062673920,
    backup_bytes: 122131936681,
    backup_bytes_unmeasured: null,
    messages_extracted: 232940,
    conversations_extracted: 2053,
    contacts_extracted: 3787,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000012-0000-4000-8000-000000000012', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-14T20:23:14.574839Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 55342,
    phases: [phase('backup', 5344), phase('backup:waiting-for-device', 46465)],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone16,2',
    device_ios_version: '26.6.2',
    device_used_bytes: 51599925248,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000013-0000-4000-8000-000000000013', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T20:21:43.803Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 1834001,
    phases: [phase('backup', 5398), phase('backup:waiting-for-device', 1825471)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 54060560384,
    backup_bytes: 0,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000014-0000-4000-8000-000000000014', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-14T20:19:36.404862Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 61243,
    phases: [phase('backup', 32125), phase('backup:waiting-for-device', 25902)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone16,2',
    device_ios_version: '26.6.2',
    device_used_bytes: 51588210688,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000015-0000-4000-8000-000000000015', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T19:38:35.803672Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 1833866,
    phases: [phase('backup', 5352), phase('backup:waiting-for-device', 1825467)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 54054817792,
    backup_bytes: 0,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000016-0000-4000-8000-000000000016', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T18:50:01.767115Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 154212,
    phases: [phase('backup', 5407), phase('backup:waiting-for-device', 145187)],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 53857484800,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000017-0000-4000-8000-000000000017', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T18:43:43.746486Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 29695,
    phases: [phase('backup', 5393), phase('backup:waiting-for-device', 20347)],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 53820116992,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000018-0000-4000-8000-000000000018', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T18:43:03.897384Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 2227,
    phases: [],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
  {
    id: 'a0000019-0000-4000-8000-000000000019', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T18:41:38.432865Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 5325,
    phases: [phase('backup', 1839)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 53827846144,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
  },
];

/** The one run the report exists to make obvious. */
export const INCIDENT_ROW_ID = FIXTURE_ROWS[2].id;

/**
 * Two runs still in flight.
 *
 * NOT TRANSCRIBED — `sync_outcomes` held no `running` row when this was written
 * (`select outcome, count(*) ... group by 1` on 2026-09-19 returned only
 * complete 4 / cancelled 7 / error 13), because BACKLOG-3440's writer had not
 * yet shipped to a build anyone runs. The shape below is therefore DERIVED from
 * the producer, not invented:
 *
 *   `electron/services/syncTimeline.ts` `beginSync` writes `buildRow("running",
 *   0, {})` at the start, and `flushHeartbeat` writes `buildRow("running",
 *   this.now() - this.syncStartedAt, {})` every two minutes after it.
 *   `buildRow` puts only CLOSED phases in `phases`, and the counts argument is
 *   `{}` on both paths, so `messages/conversations/contacts_extracted` are
 *   absent. `syncOutcomeSupabase.buildSyncOutcomeRow` drops undefined keys, so
 *   absent reads back as null.
 *
 * Consequences the report has to survive, both present below: `elapsed_ms` is
 * time SO FAR rather than a duration, and nothing has been extracted yet
 * whatever the run's eventual fate.
 */
export const IN_PROGRESS_ROWS: SyncOutcomeRow[] = [
  {
    // A HEALTHY FIRST SYNC, 47 minutes in and still transferring. Past the
    // 30-minute threshold with nothing stored, which is the normal shape of a
    // first sync of a full phone — and precisely what would be flagged as
    // "burned 30 minutes and extracted nothing" if live runs were counted.
    id: 'b0000001-0000-4000-8000-000000000001', // pii-allow-uuid: synthetic fixture id
    user_id: U2,
    created_at: '2026-09-19T17:05:11.000000Z',
    source: 'iphone-backup',
    outcome: 'running',
    elapsed_ms: 2_820_000,
    phases: [phase('backup', 24118), phase('backup:waiting-for-device', 61204)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: true,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 53827846144,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'darwin',
    is_packaged: false,
  },
  {
    // Two minutes in: one heartbeat after the start write, first phase closed.
    id: 'b0000002-0000-4000-8000-000000000002', // pii-allow-uuid: synthetic fixture id
    user_id: U4,
    created_at: '2026-09-19T17:29:02.000000Z',
    source: 'iphone-backup',
    outcome: 'running',
    elapsed_ms: 121_400,
    phases: [phase('backup', 22940)],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone18,2',
    device_ios_version: '26.6.1',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: false,
  },
];

/** The 19 finished runs with two live ones interleaved, newest first. */
export const ROWS_WITH_IN_PROGRESS: SyncOutcomeRow[] = [
  IN_PROGRESS_ROWS[1],
  IN_PROGRESS_ROWS[0],
  ...FIXTURE_ROWS,
];

// ─── The 24-row corpus (BACKLOG-3450) ────────────────────────────

/**
 * A NINTH synthetic user, for the one row above whose real author does not
 * appear in the 19-row set.
 */
const U8 = '88888888-8888-4888-8888-888888888888'; // pii-allow-uuid: synthetic fixture id, not a real user

export const FIXTURE_USERS_24: ReportUser[] = [
  ...FIXTURE_USERS,
  { id: U8, email: 'sync-user-h@example.test', display_name: 'Sync user H' },
];

/**
 * The FIVE rows written after `FIXTURE_ROWS` was transcribed.
 *
 * TRANSCRIBED from `public.sync_outcomes` on 2026-09-19, by:
 *
 *   select id, user_id, created_at, source, outcome, elapsed_ms, phases,
 *          prior_backup, incremental, was_encrypted, device_model,
 *          device_ios_version, device_used_bytes, backup_bytes,
 *          backup_bytes_unmeasured, messages_extracted,
 *          conversations_extracted, contacts_extracted, app_version, platform,
 *          is_packaged, started_at, bytes_transferred, bytes_last_increased_at,
 *          last_phase, reason_code, ended_by
 *   from sync_outcomes where source='iphone-backup' order by created_at desc;
 *
 * IDENTIFIERS ARE NOT REAL, on the same rule as `FIXTURE_ROWS`: ids and users
 * are synthetic, everything the report renders is verbatim.
 *
 * `bytes_transferred`, `bytes_last_increased_at`, `last_phase`, `reason_code`
 * and `ended_by` are NULL on all 24 rows — their writer ships in 2.38.1 and no
 * shipped build emits them yet. Anything asserting on them uses
 * {@link DERIVED_ROWS}, not these.
 */
const NEWER_ROWS: SyncOutcomeRow[] = [
  {
    id: 'a0000020-0000-4000-8000-000000000020', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-18T21:59:02.241196Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 380143,
    phases: [phase('backup', 5385), phase('backup:waiting-for-device', 302022)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 58430787584,
    backup_bytes: null,
    backup_bytes_unmeasured: true,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: true,
    started_at: null,
  },
  {
    // 33.3 minutes, nothing extracted — stalled.
    id: 'a0000021-0000-4000-8000-000000000021', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-18T20:45:29.188444Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 1998600,
    phases: [
      phase('backup', 5363),
      phase('backup:waiting-for-device', 362432),
      phase('backup:transferring', 1587536),
    ],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 58560253952,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: true,
    started_at: null,
  },
  {
    // The fourth row that can produce a Rate: 4 743 199 621 B over a
    // 198 742 ms transferring phase → 22.76 MB/s (19.68 over whole elapsed).
    id: 'a0000022-0000-4000-8000-000000000022', // pii-allow-uuid: synthetic fixture id
    user_id: U8,
    created_at: '2026-09-18T19:04:23.449284Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 229836,
    phases: [
      phase('backup', 7286),
      phase('backup:waiting-for-device', 17147),
      phase('backup:transferring', 198742),
      phase('parsing-contacts', 18),
      phase('parsing-messages', 340),
      phase('resolving', 3),
      phase('cleanup', 8),
      phase('storing:messages', 589),
      phase('storing:contacts', 2098),
    ],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone17,2',
    device_ios_version: '26.6.2',
    device_used_bytes: 20660166656,
    backup_bytes: 4743199621,
    backup_bytes_unmeasured: null,
    messages_extracted: 2592,
    conversations_extracted: 88,
    contacts_extracted: 275,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: true,
    started_at: null,
  },
  {
    id: 'a0000023-0000-4000-8000-000000000023', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-18T18:05:52.498833Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 70608,
    phases: [],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: true,
    started_at: '2026-09-18T18:04:41.890833Z',
  },
  {
    // 50.2 minutes, nothing extracted — stalled.
    id: 'a0000024-0000-4000-8000-000000000024', // pii-allow-uuid: synthetic fixture id
    user_id: U3,
    created_at: '2026-09-18T18:04:31.104227Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 3013672,
    phases: [
      phase('backup', 5380),
      phase('backup:waiting-for-device', 334406),
      phase('backup:transferring', 2670135),
    ],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 58503254016,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: 'win32',
    is_packaged: true,
    started_at: '2026-09-18T17:14:17.432227Z',
  },
];

/**
 * All 24 finished runs on record, newest first.
 *
 * Used by the period / chart / table / Rate suites added in BACKLOG-3450.
 * `FIXTURE_ROWS` deliberately stays at its transcribed 19 so the derivation
 * suite's expected values — and the sentence in this file's header — stay true.
 */
export const FIXTURE_ROWS_24: SyncOutcomeRow[] = [...NEWER_ROWS, ...FIXTURE_ROWS];

// ─── Derived rows (BACKLOG-3450) ─────────────────────────────────

/**
 * NOT TRANSCRIBED — DERIVED. Each row here stands for a state the code can
 * produce but the corpus does not contain, and each says which query proved it
 * absent. Derived from the column meanings in
 * `electron/services/syncOutcomeSupabase.ts:125-144`.
 *
 * Kept in a separate export, never mixed into the transcribed sets, so no
 * assertion can accidentally treat an invented number as a measured one.
 */
export const DERIVED_ROWS: Record<string, SyncOutcomeRow> = {
  /**
   * A backup was written but the run recorded NO transferring phase, so the
   * rate falls back to whole-run elapsed.
   *
   *   select count(*) from sync_outcomes
   *   where source='iphone-backup' and backup_bytes > 0
   *     and not phases @> '[{"phase":"backup:transferring"}]';   -- 0
   *
   * 1 048 576 B over 2 000 ms = 0.5 MB/s.
   */
  backupWithoutTransferPhase: {
    id: 'd0000001-0000-4000-8000-000000000001', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-18T12:00:00.000000Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 2000,
    phases: [phase('backup', 900)],
    prior_backup: 'none',
    incremental: false,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 10737418240,
    backup_bytes: 1048576,
    backup_bytes_unmeasured: null,
    messages_extracted: 10,
    conversations_extracted: 1,
    contacts_extracted: 1,
    app_version: '2.38.1',
    platform: 'darwin',
    is_packaged: true,
    started_at: '2026-09-18T11:59:58.000000Z',
  },

  /**
   * A cancelled run with NO `backup_bytes` but a live byte counter — the shape
   * 2.38.1 introduces, and the reason Rate has a second numerator at all.
   *
   *   select count(*) from sync_outcomes
   *   where source='iphone-backup' and bytes_transferred is not null;   -- 0
   *
   * 2 097 152 B over a 4 000 ms transferring phase = 0.5 MB/s. Carries all six
   * run-evidence columns so the detail card's "from 2.38.1" fields have a row
   * that can exercise them.
   */
  bytesTransferredOnly: {
    id: 'd0000002-0000-4000-8000-000000000002', // pii-allow-uuid: synthetic fixture id
    user_id: U2,
    created_at: '2026-09-18T13:00:00.000000Z',
    source: 'iphone-backup',
    outcome: 'cancelled',
    elapsed_ms: 8000,
    phases: [phase('backup', 1000), phase('backup:transferring', 4000)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone18,2',
    device_ios_version: '26.6.1',
    device_used_bytes: 21474836480,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.1',
    platform: 'darwin',
    is_packaged: true,
    started_at: '2026-09-18T12:59:52.000000Z',
    bytes_transferred: 2097152,
    bytes_last_increased_at: '2026-09-18T12:59:56.000000Z',
    last_phase: 'backup:transferring',
    reason_code: 'user_cancelled',
    ended_by: 'user',
  },

  /**
   * `backup_bytes` is exactly 0 — a measured nothing, not a missing number.
   * Two real rows carry it (2026-09-14 19:38 and 20:21), so this one only
   * makes the case explicit next to its neighbours.
   */
  zeroBackupBytes: {
    id: 'd0000003-0000-4000-8000-000000000003', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-18T14:00:00.000000Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 120000,
    phases: [phase('backup', 5000), phase('backup:transferring', 100000)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 10737418240,
    backup_bytes: 0,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.1',
    platform: 'darwin',
    is_packaged: true,
    started_at: null,
  },

  /**
   * A WHOLE-SECOND `created_at`.
   *
   * Postgres trims a whole-second timestamp's fractional part, so this string
   * and `2026-09-14T20:21:43.803Z` (a real row) compare the WRONG way round
   * under `<`: '.' (0x2E) sorts before 'Z' (0x5A), making the .803 row look
   * older. `Date.parse` gets it right. Every one of the 24 transcribed rows
   * carries a fraction, so without this row the bug is invisible.
   *
   *   select count(*) from sync_outcomes
   *   where source='iphone-backup' and date_part('microseconds', created_at) = 0;  -- 0
   */
  wholeSecondTimestamp: {
    id: 'd0000004-0000-4000-8000-000000000004', // pii-allow-uuid: synthetic fixture id
    user_id: U6,
    created_at: '2026-09-14T20:21:43Z',
    source: 'iphone-backup',
    outcome: 'error',
    elapsed_ms: 30000,
    phases: [],
    prior_backup: 'none',
    incremental: null,
    was_encrypted: null,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: null,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.37.0',
    platform: 'win32',
    is_packaged: true,
    started_at: null,
  },

  /**
   * 23:30 UTC on 2026-09-17 — which is 19:30 on 2026-09-17 in New York but
   * 08:30 on 2026-09-18 in Tokyo. Bucketing on a local-time `Date` puts it in
   * the wrong day under one of those; slicing the UTC string does not.
   */
  lateUtcEvening: {
    id: 'd0000005-0000-4000-8000-000000000005', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-17T23:30:00.000000Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 60000,
    phases: [phase('backup', 1000)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 10737418240,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: 5,
    conversations_extracted: 1,
    contacts_extracted: 1,
    app_version: '2.38.0',
    platform: 'darwin',
    is_packaged: true,
    started_at: null,
  },

  /**
   * 00:30 UTC on 2026-09-18 — the mirror of the row above. In New York this is
   * still 2026-09-17.
   */
  earlyUtcMorning: {
    id: 'd0000006-0000-4000-8000-000000000006', // pii-allow-uuid: synthetic fixture id
    user_id: U1,
    created_at: '2026-09-18T00:30:00.000000Z',
    source: 'iphone-backup',
    outcome: 'complete',
    elapsed_ms: 120000,
    phases: [phase('backup', 1000)],
    prior_backup: 'none',
    incremental: true,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 10737418240,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: 7,
    conversations_extracted: 1,
    contacts_extracted: 1,
    app_version: '2.38.0',
    platform: 'darwin',
    is_packaged: true,
    started_at: null,
  },
};

/**
 * DERIVED: `count` runs on one day, for the row-count paths no real corpus
 * reaches — "Show all" past 50 rows, and the 200-row query cap.
 *
 * Every run is distinct in duration and outcome so a sort can be asserted on
 * identity rather than on length.
 */
export function derivedRunRows(count: number, dayIso = '2026-09-16'): SyncOutcomeRow[] {
  const outcomes = ['complete', 'error', 'cancelled'];
  return Array.from({ length: count }, (_, i) => ({
    id: `d1${String(i).padStart(6, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`, // pii-allow-uuid: generated fixture id
    user_id: i % 2 === 0 ? U1 : U2,
    created_at: `${dayIso}T${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000100Z`,
    source: 'iphone-backup',
    outcome: outcomes[i % outcomes.length],
    elapsed_ms: 1000 + i * 137,
    phases: [phase('backup', 900 + i)],
    prior_backup: 'none',
    incremental: i % 2 === 0,
    was_encrypted: false,
    device_model: 'iPhone17,1',
    device_ios_version: '26.6.2',
    device_used_bytes: 10737418240,
    backup_bytes: null,
    backup_bytes_unmeasured: null,
    messages_extracted: i % 3 === 0 ? 100 + i : null,
    conversations_extracted: null,
    contacts_extracted: null,
    app_version: '2.38.0',
    platform: i % 2 === 0 ? 'darwin' : 'win32',
    is_packaged: true,
    started_at: null,
  }));
}

// ─── Named handles for identity assertions ───────────────────────

/**
 * The rows the BACKLOG-3450 suites assert on BY IDENTITY, looked up by their
 * (unique) `created_at` rather than by a pasted id.
 *
 * Two reasons, and the second is the important one. It keeps every UUID literal
 * in this file, next to the waiver that says it is invented — a bare UUID in a
 * test file is a finding in a PUBLIC repo, because nothing about a UUID's shape
 * separates an invented one from a live customer id (BACKLOG-2871). And it
 * fails loudly if a row is ever re-transcribed, instead of silently asserting
 * on an id that no longer exists.
 */
function idAt(createdAt: string): string {
  const row = FIXTURE_ROWS_24.find((r) => r.created_at === createdAt);
  if (!row) throw new Error(`iphone-sync fixture: no row at ${createdAt}`);
  return row.id;
}

export const ROW_IDS = {
  /** complete, 4.7 GB over a 198 742 ms transfer → 22.76 MB/s */
  rate0918: idAt('2026-09-18T19:04:23.449284Z'),
  /** complete, 58.5 GB → 21.14 MB/s */
  rate0915evening: idAt('2026-09-15T19:43:48.191269Z'),
  /** complete, 75.8 GB → 27.37 MB/s */
  rate0915afternoon: idAt('2026-09-15T18:44:08.829797Z'),
  /** complete, 122.1 GB → 27.29 MB/s */
  rate0914: idAt('2026-09-14T21:50:02.296434Z'),
  /** the 181.7-minute cancel that motivated the report */
  incident0916: idAt('2026-09-16T20:42:49.550685Z'),
  /** the one real row whose timestamp carries only milliseconds, not micros */
  fractionalTimestamp: idAt('2026-09-14T20:21:43.803Z'),
} as const;

/** The four rows that can produce a Rate, fastest last. */
export const RATE_ROW_IDS = [
  ROW_IDS.rate0915evening,
  ROW_IDS.rate0918,
  ROW_IDS.rate0914,
  ROW_IDS.rate0915afternoon,
] as const;
