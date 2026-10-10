/**
 * BACKLOG-3837 — the three message scans behind "Continue" in step 1 of a new
 * transaction, defined once so the contact query worker and the main-thread
 * fallback run ONE implementation (BACKLOG-2514 rule; text stays in `db/`).
 *
 * Each of these reads every text message of the user. On a ~668k-message
 * corpus they blocked the main process for seconds:
 *   - MESSAGE_DERIVED_CONTACTS_SQL   — the activity-sorted contact list and
 *                                      contacts:get-all (getMessageDerivedContacts)
 *   - planCommunicationDatesOn       — the one-time last-message-date backfill
 *                                      (was a LIKE '%digits%' join, O(messages x phones))
 *   - runSourceFloorsOn              — the audit-window coverage check
 *                                      (MESSAGES_FLOOR_BY_SOURCE_SQL)
 * They now run on the contact query worker; the main thread runs them only when
 * the worker is not up.
 */
import { sql } from "./core/sqlText";
import { LOCAL_REACTION_EXCLUSION, reactionExclusion } from "./reactionExclusion";
import { MESSAGES_FLOOR_BY_SOURCE_SQL } from "./auditCoverageSql";

/** A connection the runners can read through (better-sqlite3 on either thread). */
export interface MessageScanRunner {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** One row of the message-derived contact read (before the saved-name filter). */
export interface MessageDerivedContactRow {
  id: string;
  display_name: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  is_imported: number;
  is_message_derived: number;
  last_communication_at: string | null;
  communication_count: number;
}

/**
 * Unique senders found in message participants, newest first, capped at 200.
 * Moved verbatim from `getMessageDerivedContacts` (contactDbService.ts); the
 * BACKLOG-313 / BACKLOG-2280 notes that stood beside it are carried here.
 * One bound parameter: user id.
 */
export const MESSAGE_DERIVED_CONTACTS_SQL = sql`
    SELECT
      'msg_' || LOWER(json_extract(participants, '$.from')) as id,
      json_extract(participants, '$.from') as display_name,
      json_extract(participants, '$.from') as name,
      CASE
        WHEN json_extract(participants, '$.from') LIKE '%@%'
        THEN LOWER(json_extract(participants, '$.from'))
        ELSE NULL
      END as email,
      CASE
        WHEN json_extract(participants, '$.from') NOT LIKE '%@%'
        THEN json_extract(participants, '$.from')
        ELSE NULL
      END as phone,
      NULL as company,
      'messages' as source,
      0 as is_imported,
      1 as is_message_derived,
      MAX(sent_at) as last_communication_at,
      COUNT(*) as communication_count
    FROM messages
    WHERE user_id = ?
      AND participants IS NOT NULL
      AND json_extract(participants, '$.from') IS NOT NULL
      AND json_extract(participants, '$.from') != ''
      AND json_extract(participants, '$.from') != 'me'
      -- BACKLOG-313: Filter out entries where "name" is raw phone/email (no display name)
      AND json_extract(participants, '$.from') NOT LIKE '%@%'
      AND json_extract(participants, '$.from') NOT LIKE '+%'
      AND json_extract(participants, '$.from') NOT GLOB '[0-9]*'
      AND json_extract(participants, '$.from') NOT LIKE 'urn:%'
      -- BACKLOG-2280: reactions carry a sender but are not real communications.
      AND ${LOCAL_REACTION_EXCLUSION}
    GROUP BY LOWER(json_extract(participants, '$.from'))
    ORDER BY last_communication_at DESC
    LIMIT 200
  `;

export function runMessageDerivedQueryOn(db: MessageScanRunner, userId: string): MessageDerivedContactRow[] {
  return db.prepare(MESSAGE_DERIVED_CONTACTS_SQL).all(userId) as MessageDerivedContactRow[];
}

/**
 * The 10-digit key each imported contact's phone is matched on — the SAME
 * expression the old backfill join used:
 * SUBSTR(<phone_e164 without + - space ( )>, -10), keys shorter than 7 dropped.
 * One bound parameter: user id.
 */
export const BACKFILL_CONTACT_PHONE_KEYS_SQL = sql`
    SELECT
      cp.contact_id AS contact_id,
      SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) AS phone_key
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id AND c.user_id = ? AND c.is_imported = 1
    WHERE LENGTH(SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)) >= 7
  `;

/**
 * Every distinct `participants_flat` of the user's texts with its newest
 * `sent_at`, under the SAME filters the old backfill join applied to `messages`
 * (sms/imessage, reactions excluded). One bound parameter: user id.
 */
export const BACKFILL_TEXT_FLATS_SQL = sql`
    SELECT m.participants_flat AS flat, MAX(m.sent_at) AS last_msg_date
    FROM messages m
    WHERE m.user_id = ?
      AND (m.channel = 'sms' OR m.channel = 'imessage')
      AND ${reactionExclusion("m")}
      AND m.participants_flat IS NOT NULL
    GROUP BY m.participants_flat
  `;

export interface CommunicationDatePlanRow {
  contact_id: string;
  last_msg_date: string;
}

/** SQLite's LIKE folds the 26 ASCII letters and nothing else; `toLowerCase` folds all of Unicode. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * The newest text date per imported contact, matched exactly as the old
 * `participants_flat LIKE '%' || key || '%'` join matched it.
 *
 * The rule, stated rather than assumed:
 *   - A key matches a flat that contains it anywhere, folding ASCII A-Z only
 *     (SQLite LIKE's rule; a non-ASCII capital never matches its lowercase).
 *   - A key holding `%` or `_` is a LIKE pattern, not a literal. `phone_e164`
 *     CAN hold them: contact edit stores the typed phone as entered
 *     (contactHandlers.ts update -> syncContactPhones), and the import paths
 *     that normalize do not cover that route. Those keys are evaluated by
 *     SQLite's own LIKE against the distinct flats, so the semantics are the
 *     engine's, not a re-implementation of them.
 *
 * Reads the messages ONCE (grouped by flat): O(distinct flats x phone keys)
 * instead of O(messages x phone keys). Writes nothing; the main thread applies
 * the plan.
 */
export function planCommunicationDatesOn(db: MessageScanRunner, userId: string): CommunicationDatePlanRow[] {
  const keys = db.prepare(BACKFILL_CONTACT_PHONE_KEYS_SQL).all(userId) as Array<{ contact_id: string; phone_key: string }>;
  if (keys.length === 0) return [];
  const flats = db.prepare(BACKFILL_TEXT_FLATS_SQL).all(userId) as Array<{ flat: string; last_msg_date: string | null }>;
  const literalKeys: Array<{ contactId: string; key: string }> = [];
  const patternKeys: Array<{ contactId: string; key: string }> = [];
  for (const k of keys) {
    const bucket = /[%_]/.test(k.phone_key) ? patternKeys : literalKeys;
    bucket.push({ contactId: k.contact_id, key: bucket === literalKeys ? foldAscii(k.phone_key) : k.phone_key });
  }
  const likeStmt = patternKeys.length > 0 ? db.prepare("SELECT ? LIKE '%' || ? || '%' AS hit") : null;
  const newest = new Map<string, string>();
  const note = (contactId: string, date: string): void => {
    const seen = newest.get(contactId);
    if (seen === undefined || date > seen) newest.set(contactId, date);
  };
  for (const row of flats) {
    if (row.last_msg_date === null || row.last_msg_date === undefined) continue;
    const flat = String(row.flat);
    const folded = foldAscii(flat);
    for (const k of literalKeys) {
      if (folded.includes(k.key)) note(k.contactId, row.last_msg_date);
    }
    if (likeStmt) {
      for (const k of patternKeys) {
        const hit = (likeStmt.all(flat, k.key)[0] as { hit: number }).hit;
        if (hit === 1) note(k.contactId, row.last_msg_date);
      }
    }
  }
  return Array.from(newest, ([contact_id, last_msg_date]) => ({ contact_id, last_msg_date }));
}

/** Per-source floor rows of the audit coverage check (MESSAGES_FLOOR_BY_SOURCE_SQL). */
export interface SourceFloorRow {
  source: string;
  floor: string | null;
  n: number;
}

export function runSourceFloorsOn(db: MessageScanRunner, userId: string): SourceFloorRow[] {
  return db.prepare(MESSAGES_FLOOR_BY_SOURCE_SQL).all(userId) as SourceFloorRow[];
}
