/**
 * Exports report — fixture (BACKLOG-4004)
 *
 * TRANSCRIBED SHAPE. An `analytics_events` row as the desktop app writes it
 * for a completed export (exportGate.ts emits `export-completed` through
 * supabaseService.trackEvent): `event_data` holds exactly
 * `{ transaction_id, mode, format }`, `transaction_id` is a UUID string,
 * `created_at` is PostgREST's timestamptz text with microseconds and `+00:00`.
 * Shape checked against a production row at plan review; every id, name and
 * email below is a placeholder.
 *
 * Cases the counters must tell apart (expected values in exports.test.ts):
 * - user-1 exports deal D1 as PDF three times, 8 s apart (a chain), and as a
 *   folder once: 4 exports, 1 unique — format is not part of the pair.
 * - user-2 exports the SAME deal D1: a second unique export, not a repeat.
 * - user-2 double-clicks deal D3 (two folder exports 1 s apart).
 * - user-3 has no organization; one export at 03:30Z (the previous calendar
 *   day in Pacific time) and one at 23:30Z, one of them an `excel` export.
 * - user-4 is in two organizations; one export at exactly the period start.
 * - one row with another event name, which the builder must ignore.
 */

import type { ExportEventRow, ExportLookups } from '../exports';
import { resolvePeriod } from '../period';

export const NOW = new Date('2026-10-20T12:00:00.000Z');
export const PERIOD = resolvePeriod({ period: 'custom', from: '2026-10-12', to: '2026-10-18' }, NOW);

/** Deal ids in the UUID shape the desktop app sends, built here so no id literal sits in the file. */
const dealId = (n: number) => ['7a000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');

export const D1 = dealId(1);
export const D2 = dealId(2);
export const D3 = dealId(3);
export const D4 = dealId(4);
export const D5 = dealId(5);
export const D6 = dealId(6);

function row(
  id: string,
  userId: string | null,
  createdAt: string,
  transactionId: string,
  format: string,
  eventName = 'export-completed'
): ExportEventRow {
  return {
    id,
    user_id: userId,
    event_name: eventName,
    event_data: { transaction_id: transactionId, mode: 'full', format },
    created_at: createdAt,
  };
}

export const EXPORT_ROWS: ExportEventRow[] = [
  // user-1: a three-export chain, 8 s apart, then a folder export of the same deal.
  row('evt-01', 'user-1', '2026-10-13T10:00:00.000000+00:00', D1, 'pdf'),
  row('evt-02', 'user-1', '2026-10-13T10:00:08.000000+00:00', D1, 'pdf'),
  row('evt-03', 'user-1', '2026-10-13T10:00:16.000000+00:00', D1, 'pdf'),
  row('evt-04', 'user-1', '2026-10-13T11:00:00.000000+00:00', D1, 'folder'),
  row('evt-05', 'user-1', '2026-10-15T09:00:00.000000+00:00', D2, 'pdf'),
  // user-2: the same deal as user-1, then a double-click pair.
  row('evt-06', 'user-2', '2026-10-14T12:00:00.000000+00:00', D1, 'pdf'),
  row('evt-07', 'user-2', '2026-10-16T15:00:00.120000+00:00', D3, 'folder'),
  row('evt-08', 'user-2', '2026-10-16T15:00:01.050000+00:00', D3, 'folder'),
  // user-3: no organization; 03:30Z is 20:30 the previous day in Pacific time.
  row('evt-09', 'user-3', '2026-10-17T03:30:00.000000+00:00', D4, 'excel'),
  row('evt-10', 'user-3', '2026-10-17T23:30:00.000000+00:00', D6, 'pdf'),
  // user-4: two organizations; exactly at the period start.
  row('evt-11', 'user-4', '2026-10-12T00:00:00+00:00', D5, 'pdf'),
  // Another event name. Never counted.
  row('evt-12', 'user-1', '2026-10-14T08:00:00.000000+00:00', D2, 'pdf', 'app-opened'),
];

export const LOOKUPS: ExportLookups = {
  users: [
    {
      id: 'user-1',
      email: 'agent.one@example.test',
      display_name: 'Agent One',
    },
    {
      id: 'user-2',
      email: 'agent.two@example.test',
      display_name: 'Agent Two',
    },
    {
      id: 'user-3',
      email: 'agent.three@example.test',
      display_name: null,
    },
    {
      id: 'user-4',
      email: 'agent.four@example.test',
      display_name: 'Agent Four',
    },
  ],
  memberships: [
    { user_id: 'user-1', organization_id: 'org-a' },
    { user_id: 'user-2', organization_id: 'org-a' },
    { user_id: 'user-4', organization_id: 'org-a' },
    { user_id: 'user-4', organization_id: 'org-b' },
    // An invite row: no user yet. Must never match anyone.
    { user_id: null, organization_id: 'org-b' },
  ],
  orgs: [
    { id: 'org-a', name: 'Brokerage A' },
    { id: 'org-b', name: 'Brokerage B' },
  ],
  failed: false,
};

/** Expected over the whole fixture, no filters. */
export const EXPECTED_ALL = { exports: 11, unique: 7, users: 4 };
