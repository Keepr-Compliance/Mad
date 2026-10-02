/**
 * BACKLOG-3670 — people found in texts (Google Messages).
 *
 * The cache commit and the per-transaction Sync record, for every chat they
 * store, each member NUMBER with the name the phone's address book shows for
 * it (`rcs_chat_people`, local only). This module writes those rows and reads
 * them back as contact suggestions.
 *
 * Rules (SR plan review, 2026-10-02):
 *   - the key is the NUMBER, never a name; a group yields one row per member;
 *   - suppressed by number only: the last 10 digits against ANY contact's
 *     phone, a removed contact included (BACKLOG-2365) — the BACKLOG-2618 name
 *     rule does not apply here;
 *   - Don't-sync chats (rcs_chat_exclusions), the user's own number and
 *     anything not phone-shaped are left out;
 *   - no name → the formatted number;
 *   - its own cap (200): it never takes the macOS message-derived rows' slots;
 *   - names are never logged.
 *
 * KNOWN LIMIT (v1): a macOS name-only message-derived row and a Google
 * Messages number row for the same person both appear — there is no merging
 * on names.
 */

import { dbAll, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { formatPhoneNumber } from "../../utils/phoneNormalization";

/** The id prefix of a person found in texts by number (`msg_tel_<e164>`). */
export const TEXT_PERSON_ID_PREFIX = "msg_tel_";
/** At most this many people found in texts are offered (separate from the macOS rows). */
export const TEXT_PEOPLE_CAP = 200;

const PHONE_SHAPED = /^\+[1-9][0-9]{9,14}$/;

/** Digits only, last 10 — the autoLinkSql / contact phone match key. */
const L10_PERSON = sql`substr(replace(replace(replace(replace(replace(p.number_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)`;
const L10_OWN = sql`substr(replace(replace(replace(replace(replace(s.own_number, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)`;
const L10_CONTACT_E164 = sql`substr(replace(replace(replace(replace(replace(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)`;
const L10_CONTACT_DISPLAY = sql`substr(replace(replace(replace(replace(replace(COALESCE(cp.phone_display, ''), '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)`;

/** One member of a stored chat: its number and the name shown for it (or null). */
export interface RcsChatPersonRow {
  number: string;
  name: string | null;
}

/**
 * The rows to record for one chat: every member number (phone-shaped only),
 * with its Details name; a 1:1 chat with no Details name takes the chat
 * title, unless the title is itself a number.
 */
export function chatPeopleRows(
  people: { numbers: readonly string[]; names: ReadonlyArray<{ name: string; number: string }> },
  chatTitle: string | null | undefined,
): RcsChatPersonRow[] {
  const out: RcsChatPersonRow[] = [];
  const title = typeof chatTitle === "string" ? chatTitle.trim() : "";
  const titleIsName = title !== "" && !/^[\d+()\-.\s]+$/.test(title);
  for (const number of people.numbers) {
    if (!PHONE_SHAPED.test(number)) continue;
    const named = people.names.find((n) => n.number === number && n.name.trim() !== "");
    const name = named ? named.name.trim() : people.numbers.length === 1 && titleIsName ? title : null;
    out.push({ number, name: name ? name.slice(0, 120) : null });
  }
  return out;
}

/** Record a stored chat's people (upsert; a newer name or later message wins). */
export function recordRcsChatPeople(
  userId: string,
  chatHash: string,
  rows: readonly RcsChatPersonRow[],
  lastMessageAt: string | null,
): void {
  for (const r of rows) {
    dbRun(
      sql`INSERT INTO rcs_chat_people (user_id, chat_hash, number_e164, name, last_message_at, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, chat_hash, number_e164) DO UPDATE SET
            name = COALESCE(excluded.name, rcs_chat_people.name),
            last_message_at = CASE
              WHEN rcs_chat_people.last_message_at IS NULL THEN excluded.last_message_at
              WHEN excluded.last_message_at IS NULL THEN rcs_chat_people.last_message_at
              WHEN excluded.last_message_at > rcs_chat_people.last_message_at THEN excluded.last_message_at
              ELSE rcs_chat_people.last_message_at END,
            updated_at = CURRENT_TIMESTAMP`,
      [userId, chatHash, r.number, r.name, lastMessageAt],
    );
  }
}

/** Force re-import: every person found in this user's Google Messages texts. */
export function clearRcsChatPeople(userId: string): number {
  return dbRun(sql`DELETE FROM rcs_chat_people WHERE user_id = ?`, [userId]).changes;
}

/** Auto-delete: the people of the chats deleted. */
export function clearRcsChatPeopleForChats(userId: string, chatHashes: readonly string[]): number {
  let n = 0;
  for (const h of chatHashes) {
    n += dbRun(sql`DELETE FROM rcs_chat_people WHERE user_id = ? AND chat_hash = ?`, [userId, h]).changes;
  }
  return n;
}

/** A person found in texts, shaped like the other message-derived records. */
export interface TextDerivedPerson {
  id: string;
  display_name: string;
  name: string;
  email: null;
  phone: string;
  company: null;
  source: "messages";
  is_imported: 0;
  is_message_derived: 1;
  last_communication_at: string | null;
  communication_count: number;
}

const TEXT_PEOPLE_SQL = sql`
  SELECT
    p.number_e164 AS number,
    (SELECT p2.name FROM rcs_chat_people p2
      WHERE p2.user_id = p.user_id AND p2.number_e164 = p.number_e164
        AND p2.name IS NOT NULL AND p2.name != ''
      ORDER BY p2.last_message_at DESC LIMIT 1) AS name,
    MAX(p.last_message_at) AS last_communication_at,
    (SELECT COUNT(*) FROM messages m
      WHERE m.user_id = p.user_id
        AND m.thread_id IN (SELECT 'gmweb2-' || p3.chat_hash FROM rcs_chat_people p3
                             WHERE p3.user_id = p.user_id AND p3.number_e164 = p.number_e164)) AS communication_count
  FROM rcs_chat_people p
  WHERE p.user_id = ?
    -- Don't-sync chats (BACKLOG-3658 P3c)
    AND NOT EXISTS (SELECT 1 FROM rcs_chat_exclusions x WHERE x.user_id = p.user_id AND x.chat_hash = p.chat_hash)
    -- the user's own number
    AND NOT EXISTS (SELECT 1 FROM rcs_cache_state s
                     WHERE s.user_id = p.user_id AND s.own_number IS NOT NULL
                       AND ${L10_OWN} = ${L10_PERSON})
    -- already a contact by NUMBER, removed contacts included (BACKLOG-2365)
    AND NOT EXISTS (SELECT 1 FROM contact_phones cp JOIN contacts c ON c.id = cp.contact_id
                     WHERE c.user_id = p.user_id
                       AND (${L10_CONTACT_E164} = ${L10_PERSON}
                         OR ${L10_CONTACT_DISPLAY} = ${L10_PERSON}))
  GROUP BY p.number_e164
  ORDER BY last_communication_at DESC
  LIMIT ?
`;

/**
 * People found in this user's Google Messages texts, newest first, capped.
 * `search` (the picker's query) matches the name or the number's digits.
 */
export function getTextDerivedPeople(userId: string, search?: string, limit: number = TEXT_PEOPLE_CAP): TextDerivedPerson[] {
  let rows: Array<{ number: string; name: string | null; last_communication_at: string | null; communication_count: number }>;
  try {
    rows = dbAll(TEXT_PEOPLE_SQL, [userId, Math.min(limit, TEXT_PEOPLE_CAP)]);
  } catch {
    // A database without the table yet (or a read failure): no suggestions,
    // never a broken contacts list.
    return [];
  }
  const needle = (search ?? "").trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const out: TextDerivedPerson[] = [];
  for (const r of rows) {
    if (!PHONE_SHAPED.test(r.number)) continue;
    const shown = r.name && r.name.trim() !== "" ? r.name.trim() : formatPhoneNumber(r.number);
    if (needle) {
      const byName = shown.toLowerCase().includes(needle);
      const byNumber = digits.length >= 3 && r.number.replace(/\D/g, "").includes(digits);
      if (!byName && !byNumber) continue;
    }
    out.push({
      id: `${TEXT_PERSON_ID_PREFIX}${r.number}`,
      display_name: shown,
      name: shown,
      email: null,
      phone: r.number,
      company: null,
      source: "messages",
      is_imported: 0,
      is_message_derived: 1,
      last_communication_at: r.last_communication_at,
      communication_count: r.communication_count ?? 0,
    });
  }
  return out;
}
