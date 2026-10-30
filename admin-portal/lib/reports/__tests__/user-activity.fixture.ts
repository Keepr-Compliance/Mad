/**
 * User Activity report — fixture (BACKLOG-3720)
 *
 * SHAPE transcribed from prod (read-only, 2026-10-29), values all fake:
 *   select table_name, column_name, data_type, is_nullable
 *     from information_schema.columns where table_schema = 'public' and …
 *   -> audit_logs(id uuid, user_id uuid NOT NULL, action text, resource_type text NOT NULL,
 *      resource_id text NULL, created_at timestamptz), devices(id, user_id, platform text,
 *      app_version text, is_active bool, last_seen_at timestamptz), users(id, email NOT NULL,
 *      display_name, first_name, last_name, last_login_at), organization_members(id,
 *      user_id NULL, organization_id), organizations(id, name), internal_roles(id, user_id).
 *   select platform, count(*) from devices group by 1 -> 'macos', 'windows'.
 *   select action, resource_type, length(resource_id) … -> TRANSACTION_CREATE/TRANSACTION,
 *      TRANSACTION_UPDATE/TRANSACTION, TRANSACTION_SUBMIT/SUBMISSION, DATA_EXPORT/EXPORT,
 *      resource_id a 36-char uuid string. DATA_EXPORT/USER has a writer (ccpaHandlers) but
 *      no prod row yet; it is included here on purpose.
 */

import { resolvePeriod } from '../period';
import type {
  ActivityDeviceRow,
  ActivityEventRow,
  ActivityMembershipRow,
  ActivityOrgRow,
  ActivityUserRow,
} from '../user-activity';

export const NOW = new Date('2026-10-29T12:00:00.000Z');
/** Last week = Mon 2026-10-19 .. Mon 2026-10-26 (exclusive). */
export const LAST_WEEK = resolvePeriod({ period: 'last-week' }, NOW);

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tx = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ALICE = uid(1);
export const BOB = uid(2);
export const CAROL = uid(3); // no events at all
export const STAFF = uid(9); // internal staff, IS in public.users
export const GONE = uid(99); // not in public.users

export const ORG_A = uid(101);
export const ORG_B = uid(102);

export const USERS: ActivityUserRow[] = [
  { id: ALICE, email: 'alice@example.test', display_name: 'Alice', first_name: null, last_name: null, last_login_at: '2026-10-28T09:00:00.000Z' },
  { id: BOB, email: 'bob@example.test', display_name: null, first_name: 'Bob', last_name: 'Broker', last_login_at: '2026-10-20T09:00:00.000Z' },
  { id: CAROL, email: 'carol@example.test', display_name: null, first_name: null, last_name: null, last_login_at: null },
  { id: STAFF, email: 'staff@example.test', display_name: 'Staffer', first_name: null, last_name: null, last_login_at: '2026-10-29T08:00:00.000Z' },
];

/**
 * Alice has three devices; her NEWEST is the middle one (not first, not last)
 * and it is AFTER the last-week period ends (C12, C13).
 */
export const DEVICES: ActivityDeviceRow[] = [
  { id: uid(201), user_id: ALICE, platform: 'windows', app_version: '2.44.0', is_active: true, last_seen_at: '2026-10-21T10:00:00.000Z' },
  { id: uid(202), user_id: ALICE, platform: 'macos', app_version: '2.44.0', is_active: true, last_seen_at: '2026-10-28T15:30:00.000Z' },
  { id: uid(203), user_id: ALICE, platform: 'windows', app_version: '2.43.0', is_active: false, last_seen_at: '2026-10-01T10:00:00.000Z' },
  { id: uid(204), user_id: BOB, platform: 'windows', app_version: '2.44.0', is_active: true, last_seen_at: '2026-10-22T10:00:00.000Z' },
  { id: uid(209), user_id: STAFF, platform: 'macos', app_version: '2.44.0', is_active: true, last_seen_at: '2026-10-29T09:00:00.000Z' },
];

let n = 300;
function ev(user_id: string, action: string, resource_type: string, resource_id: string | null, created_at: string): ActivityEventRow {
  n += 1;
  return { id: uid(n), user_id, action, resource_type, resource_id, created_at };
}

export const EVENTS: ActivityEventRow[] = [
  // Alice: 2 created, 3 edits on ONE transaction + 1 on another (C21), 1 submit, 2 exports + 1 personal export (C20)
  ev(ALICE, 'TRANSACTION_CREATE', 'TRANSACTION', tx(1), '2026-10-19T09:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_CREATE', 'TRANSACTION', tx(2), '2026-10-20T09:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_UPDATE', 'TRANSACTION', tx(1), '2026-10-20T10:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_UPDATE', 'TRANSACTION', tx(1), '2026-10-20T11:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_UPDATE', 'TRANSACTION', tx(1), '2026-10-20T12:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_UPDATE', 'TRANSACTION', tx(2), '2026-10-21T12:00:00.000Z'),
  ev(ALICE, 'TRANSACTION_SUBMIT', 'SUBMISSION', tx(901), '2026-10-22T12:00:00.000Z'),
  ev(ALICE, 'DATA_EXPORT', 'EXPORT', tx(801), '2026-10-23T12:00:00.000Z'),
  ev(ALICE, 'DATA_EXPORT', 'EXPORT', tx(802), '2026-10-23T13:00:00.000Z'),
  ev(ALICE, 'DATA_EXPORT', 'USER', ALICE, '2026-10-24T13:00:00.000Z'),
  // Bob: only a LOGOUT and an edit on Alice's transaction
  ev(BOB, 'LOGOUT', 'SESSION', null, '2026-10-22T08:00:00.000Z'),
  ev(BOB, 'TRANSACTION_UPDATE', 'TRANSACTION', tx(1), '2026-10-22T09:00:00.000Z'),
  // Staff: 3 events (C19)
  ev(STAFF, 'TRANSACTION_CREATE', 'TRANSACTION', tx(50), '2026-10-21T09:00:00.000Z'),
  ev(STAFF, 'TRANSACTION_SUBMIT', 'SUBMISSION', tx(950), '2026-10-21T10:00:00.000Z'),
  ev(STAFF, 'DATA_EXPORT', 'EXPORT', tx(850), '2026-10-21T11:00:00.000Z'),
  // Orphan: 1 event from a user no longer in Keepr (C11)
  ev(GONE, 'TRANSACTION_CREATE', 'TRANSACTION', tx(60), '2026-10-21T09:00:00.000Z'),
];

export const MEMBERSHIPS: ActivityMembershipRow[] = [
  { id: uid(401), user_id: ALICE, organization_id: ORG_A },
  { id: uid(402), user_id: BOB, organization_id: ORG_A },
  { id: uid(403), user_id: BOB, organization_id: ORG_B },
  { id: uid(404), user_id: null, organization_id: ORG_B },
];

export const ORGS: ActivityOrgRow[] = [
  { id: ORG_A, name: 'Acme Realty' },
  { id: ORG_B, name: 'Beta Homes' },
];

export const STAFF_IDS: ReadonlySet<string> = new Set([STAFF]);
