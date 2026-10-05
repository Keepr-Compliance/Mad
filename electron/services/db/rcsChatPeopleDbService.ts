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

import { dbAll, dbRun, ensureDb } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { formatPhoneNumber } from "../../utils/phoneNormalization";

/** The id prefix of a person found in texts by number (`msg_tel_<e164>`). */
export const TEXT_PERSON_ID_PREFIX = "msg_tel_";
/** At most this many people found in texts are offered (separate from the macOS rows). */
export const TEXT_PEOPLE_CAP = 200;

const PHONE_SHAPED = /^\+[1-9][0-9]{9,14}$/;

/** Digits only, last 10 — the autoLinkSql / contact phone match key. */
const L10_PERSON = sql`substr(replace(replace(replace(replace(replace(p.number_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)`;

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
  // SR: a chat was just stored (its messages imported): the per-thread
  // message counts — and a same-second upsert the fingerprint cannot see —
  // must not be served from the cache.
  invalidateTextPeopleCache(userId);
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
  invalidateTextPeopleCache(userId);
  return dbRun(sql`DELETE FROM rcs_chat_people WHERE user_id = ?`, [userId]).changes;
}

/** Auto-delete: the people of the chats deleted. */
export function clearRcsChatPeopleForChats(userId: string, chatHashes: readonly string[]): number {
  invalidateTextPeopleCache(userId);
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

/**
 * Live (Windows): the contact picker froze Keepr. The old single query
 * compared a 5-deep replace()/substr() last-10 of EVERY person row against
 * EVERY contact phone (no index usable) and counted messages per person with
 * a correlated sub-select — synchronously on the main thread (a 5k-person /
 * 5k-contact / 100k-message account took minutes). Now: a few indexed reads,
 * the matching in JS with Sets (one pass each), and a per-user cache keyed by
 * a cheap fingerprint of everything the answer depends on, so an unchanged
 * picker reopen costs a handful of COUNT()s.
 *
 * Same answer as before: suppressed by NUMBER (last 10 digits of any of the
 * user's contact phones — E.164 or display — removed contacts included,
 * BACKLOG-2365) and the user's own number; Don't-sync chats left out; the
 * newest non-empty name; the newest message time; messages in its chats.
 */

/** Digits only (the old SQL stripped + - space ( )), last 10 — L10_PERSON / L10_CONTACT_*. */
function last10(v: string | null | undefined): string {
  return String(v ?? "").replace(/[+\-\s()]/g, "").slice(-10);
}

interface PeopleRow {
  number: string;
  name: string | null;
  chatHash: string;
  lastMessageAt: string | null;
}

const PEOPLE_ROWS_SQL = sql`
  SELECT p.number_e164 AS number, p.name AS name, p.chat_hash AS chatHash, p.last_message_at AS lastMessageAt
  FROM rcs_chat_people p
  WHERE p.user_id = ?
    AND NOT EXISTS (SELECT 1 FROM rcs_chat_exclusions x WHERE x.user_id = p.user_id AND x.chat_hash = p.chat_hash)`;

const CONTACT_PHONES_SQL = sql`
  SELECT cp.phone_e164 AS e164, cp.phone_display AS display
  FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id
  WHERE c.user_id = ?`;

const OWN_NUMBER_SQL = sql`SELECT own_number AS own FROM rcs_cache_state WHERE user_id = ? AND own_number IS NOT NULL`;

/**
 * Messages per Google Messages thread. \`+m.user_id\` keeps the planner on
 * idx_messages_thread_id (the user filter applies to those rows only).
 */
const THREAD_COUNTS_SQL = sql`
  SELECT m.thread_id AS threadId, COUNT(*) AS n
  FROM messages m
  WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND +m.user_id = ?
  GROUP BY m.thread_id`;

/** What the answer depends on: cheap aggregates (all on indexed columns). */
const FINGERPRINT_SQL = sql`
  SELECT
    (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(MAX(rowid), 0) FROM rcs_chat_people WHERE user_id = ?) AS people,
    (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(MAX(rowid), 0) FROM contacts WHERE user_id = ?) AS contacts,
    -- SR: contact_phones has no updated_at, so an in-place edit of a number
    -- changes neither the count nor the max rowid: the digits themselves are
    -- summed (one pass over this user's phones; no cross product).
    (SELECT COUNT(*) || ':' || IFNULL(MAX(cp.rowid), 0) || ':' ||
            TOTAL(CAST(substr(replace(cp.phone_e164, '+', ''), -10) AS INTEGER)) || ':' ||
            TOTAL(CAST(substr(replace(replace(replace(replace(replace(IFNULL(cp.phone_display, ''), '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) AS INTEGER))
       FROM contacts c JOIN contact_phones cp ON cp.contact_id = c.id WHERE c.user_id = ?) AS phones,
    (SELECT COUNT(*) FROM rcs_chat_exclusions WHERE user_id = ?) AS excluded,
    (SELECT IFNULL(MAX(own_number), '') FROM rcs_cache_state WHERE user_id = ?) AS own`;

/** The reads this module runs (for the query-plan test). */
export const TEXT_PEOPLE_QUERIES: Record<string, { sql: string; params: (userId: string) => unknown[] }> = {
  people: { sql: PEOPLE_ROWS_SQL, params: (u) => [u] },
  contactPhones: { sql: CONTACT_PHONES_SQL, params: (u) => [u] },
  threadCounts: { sql: THREAD_COUNTS_SQL, params: (u) => [JSON.stringify(["gmweb2-x"]), u] },
  fingerprint: { sql: FINGERPRINT_SQL, params: (u) => [u, u, u, u, u] },
};

interface TextPersonAll {
  number: string;
  name: string | null;
  last: string | null;
  count: number;
}

/**
 * Per-user cache: the full, sorted, uncapped list and the fingerprint it was
 * built for — per database handle (a re-opened / swapped database never
 * serves another's answer).
 */
let cache = new Map<string, { key: string; all: TextPersonAll[] }>();
let cacheDb: unknown = null;

/** Drop the cache (Force re-import, auto-delete, tests). */
export function invalidateTextPeopleCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

function fingerprint(userId: string): string {
  const f = dbAll<Record<string, string | number>>(FINGERPRINT_SQL, [userId, userId, userId, userId, userId])[0] ?? {};
  return [f.people, f.contacts, f.phones, f.excluded, f.own].join("|");
}

function buildAll(userId: string): TextPersonAll[] {
  const rows = dbAll<PeopleRow>(PEOPLE_ROWS_SQL, [userId]);
  if (rows.length === 0) return [];
  const suppressed = new Set<string>();
  for (const p of dbAll<{ e164: string | null; display: string | null }>(CONTACT_PHONES_SQL, [userId])) {
    const a = last10(p.e164);
    const b = last10(p.display);
    if (a) suppressed.add(a);
    if (b) suppressed.add(b);
  }
  for (const o of dbAll<{ own: string }>(OWN_NUMBER_SQL, [userId])) {
    const k = last10(o.own);
    if (k) suppressed.add(k);
  }
  const byNumber = new Map<string, { number: string; name: string | null; nameAt: string | null; last: string | null; chats: Set<string> }>();
  for (const r of rows) {
    if (suppressed.has(last10(r.number))) continue;
    let e = byNumber.get(r.number);
    if (!e) {
      e = { number: r.number, name: null, nameAt: null, last: null, chats: new Set() };
      byNumber.set(r.number, e);
    }
    e.chats.add(r.chatHash);
    if (r.lastMessageAt !== null && (e.last === null || r.lastMessageAt > e.last)) e.last = r.lastMessageAt;
    // The newest non-empty name (by its row's last message).
    if (r.name !== null && r.name !== "") {
      const at = r.lastMessageAt ?? "";
      if (e.name === null || at > (e.nameAt ?? "")) {
        e.name = r.name;
        e.nameAt = at;
      }
    }
  }
  const threads = Array.from(new Set(Array.from(byNumber.values()).flatMap((e) => Array.from(e.chats, (h) => `gmweb2-${h}`))));
  const perThread = new Map<string, number>();
  for (let i = 0; i < threads.length; i += 900) {
    for (const t of dbAll<{ threadId: string; n: number }>(THREAD_COUNTS_SQL, [JSON.stringify(threads.slice(i, i + 900)), userId])) {
      perThread.set(t.threadId, t.n);
    }
  }
  const all: TextPersonAll[] = [];
  for (const e of byNumber.values()) {
    let count = 0;
    for (const h of e.chats) count += perThread.get(`gmweb2-${h}`) ?? 0;
    all.push({ number: e.number, name: e.name, last: e.last, count });
  }
  // Newest first (NULL last, as SQLite's DESC).
  all.sort((a, b) => (a.last === b.last ? 0 : a.last === null ? 1 : b.last === null ? -1 : a.last < b.last ? 1 : -1));
  return all;
}

/**
 * People found in this user's Google Messages texts, newest first, capped.
 * \`search\` (the picker's query) matches the name or the number's digits —
 * BEFORE the cap, so a match beyond the newest 200 is still found.
 */
export function getTextDerivedPeople(userId: string, search?: string, limit: number = TEXT_PEOPLE_CAP): TextDerivedPerson[] {
  let all: TextPersonAll[];
  try {
    const handle = ensureDb();
    if (handle !== cacheDb) {
      cacheDb = handle;
      cache = new Map();
    }
    const key = fingerprint(userId);
    const hit = cache.get(userId);
    if (hit && hit.key === key) all = hit.all;
    else {
      all = buildAll(userId);
      cache.set(userId, { key, all });
    }
  } catch {
    // A database without the tables yet (or a read failure): no suggestions,
    // never a broken contacts list.
    return [];
  }
  const needle = (search ?? "").trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const cap = Math.min(limit, TEXT_PEOPLE_CAP);
  const out: TextDerivedPerson[] = [];
  for (const r of all) {
    if (out.length >= cap) break;
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
      last_communication_at: r.last,
      communication_count: r.count,
    });
  }
  return out;
}

/** A number's name as shown in Google Messages (for naming texts' senders). */
export interface RcsPersonName {
  number: string;
  name: string;
}

const NAMES_BY_DIGITS_SQL = sql`
  SELECT p.number_e164 AS number,
    (SELECT p2.name FROM rcs_chat_people p2
      WHERE p2.user_id = p.user_id AND p2.number_e164 = p.number_e164
        AND p2.name IS NOT NULL AND trim(p2.name) != ''
        AND NOT EXISTS (SELECT 1 FROM rcs_chat_exclusions x WHERE x.user_id = p2.user_id AND x.chat_hash = p2.chat_hash)
      ORDER BY p2.last_message_at DESC, p2.updated_at DESC LIMIT 1) AS name
  FROM rcs_chat_people p
  WHERE p.user_id = ?
    AND ${L10_PERSON} IN (SELECT value FROM json_each(?))
  GROUP BY p.number_e164`;

/**
 * Group-sender names: for these numbers (any format; matched on the last 10
 * digits, as L10_PERSON), the newest non-empty name Google Messages showed
 * for each, in this user's chats only, Don't-sync chats left out. Numbers
 * with no name are not returned. Names are never logged.
 */
export function getRcsPeopleNamesByDigits(userId: string, numbers: readonly string[]): RcsPersonName[] {
  const last10 = Array.from(
    new Set(numbers.map((n) => n.replace(/\D/g, "")).filter((d) => d.length >= 10).map((d) => d.slice(-10))),
  );
  if (!userId || last10.length === 0) return [];
  try {
    const rows = dbAll<{ number: string; name: string | null }>(NAMES_BY_DIGITS_SQL, [userId, JSON.stringify(last10)]);
    return rows.filter((r): r is RcsPersonName => typeof r.name === "string" && r.name.trim() !== "").map((r) => ({ number: r.number, name: r.name.trim() }));
  } catch {
    // A database without the table yet: no names, never a broken lookup.
    return [];
  }
}
