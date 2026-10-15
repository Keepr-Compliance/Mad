/**
 * BACKLOG-3868: the 1:1 thread identities the attached-thread expansion needs, read
 * TARGETED instead of from every text message of the user.
 *
 * The expansion (autoLinkService.expandAttachedThreadsForUser) needs two things:
 *   1. the identity of each ATTACHED thread (to pool its 1:1 contact token), and
 *   2. for each pooled token T, every thread whose own identity is exactly {T}.
 * Until 3868 both came from `readOneToOneThreadIndexOn`, which reads and JSON-parses
 * every text message of the user (671,105 rows on the founder's PC) on every run.
 *
 * Here (1) is an indexed read of the attached threads only (`idx_messages_thread_id`),
 * and (2) is a SUPERSET filter evaluated inside SQLite — only rows that could contribute
 * a pooled token reach JavaScript — followed by the exact identity of just those threads.
 *
 * WHY THE SUPERSET HOLDS (a thread with identity {T} passes it):
 * a thread has token T only if one of its rows contributes T, i.e. a raw handle `h` in
 * `from` / `to` / `chat_members` with handleToIdentityToken(h) === T
 * (electron/utils/handleIdentity.ts):
 *   - phone:D  — D is the last 10 (or all) ASCII digits of h. A digit-led phone handle may
 *     hold only digits, whitespace, `-`, `(` and `)` (isPhoneLikeHandle), so once spaces,
 *     `-`, `(`, `)`, `.` and `/` are removed from the participants text, D is a contiguous
 *     substring of it. Whitespace other than a space is either escaped by JSON (a
 *     backslash) or non-ASCII, and such rows are always kept (below). A cheap instr on the
 *     LAST FOUR digits runs first, so the replace() chain only runs on rows that have them.
 *     COVERED CASES, stated: the last four digits are written together, and the digits are
 *     separated only by those six characters (E.164 "+12065550103", "+1 (206) 555-0103",
 *     "206.555.0103", "+1/206/555/0103"). Not covered: "+1 206 555 01 03"-style grouping
 *     inside the last four, and a `+`-led handle (which may hold any character) with, say,
 *     letters between its digits. The three producers of
 *     text participants write E.164 handles, emails, or national formats of this kind
 *     (macOSMessagesImportService.ts:1631, iPhoneSyncStorageService.ts:574,
 *     localSyncService.ts:1179). A `+` handle with, say, letters between its digits is not
 *     covered and would not be cross-linked from a thread the targeted read did not find.
 *     A subsequence GLOB would cover it but keeps nearly every row: the user's own number
 *     sits in the same JSON and supplies the digits (measured, BACKLOG-3868).
 *   - handle:x — x = lower(trim(h)). When the participants text is printable ASCII with no
 *     backslash, JSON holds h verbatim and SQLite's ASCII lower() equals JS toLowerCase(),
 *     so `instr(lower(participants), x) > 0`. Every other row (any non-ASCII or control
 *     character, or a backslash escape) is ALWAYS kept and decided exactly in JS.
 *   - A token that only String() of a nested array/object can produce (`,` or
 *     `[object`) has no textual form to filter on: those runs read the full index instead.
 * The identity of every kept thread is then computed from ALL its rows with the same
 * `computeThreadIdentitySet` the full index uses, so the 1:1-vs-group answer is identical.
 *
 * No Electron import: the contact query worker loads this file.
 */
import { sql, type SafeSql } from "./core/sqlText";
import { joinFragments, placeholderList } from "./core/sqlFragments";
import { computeThreadIdentitySet, type ThreadIdentityRow } from "../../utils/threadIdentity";
import { readOneToOneThreadIndexOn, type ThreadIdentityRunner } from "./threadIdentityIndexDb";

/** The same row filter as THREAD_DIRECTION_PARTICIPANTS_SQL (autoLinkSql.ts), after the user id term. */
// Unary `+`: these terms must never pick the index (idx_messages_channel,
// idx_messages_duplicate_of) — without statistics SQLite would (pinned by
// threadIdentityQueryPlan.test.ts).
const TEXT_THREAD_ROW_REST = sql`+channel IN ('sms', 'imessage')
          AND +duplicate_of IS NULL
          AND +thread_id IS NOT NULL
          AND +thread_id != ''`;
const TEXT_THREAD_ROW = sql`user_id = ?
          AND ${TEXT_THREAD_ROW_REST}`;

/** Rows of the given threads. Bound: user id, then one thread id per placeholder. */
function threadRowsSql(threadCount: number): SafeSql {
  // `+user_id`: without table statistics SQLite otherwise walks idx_messages_user_id
  // (every message of the user) instead of idx_messages_thread_id (measured: 37 threads,
  // 6,253 rows, 770 ms on a 671k-row store).
  return sql`SELECT thread_id, direction, participants
         FROM messages
        WHERE +user_id = ?
          AND ${TEXT_THREAD_ROW_REST}
          AND thread_id IN (${placeholderList(threadCount)})`;
}

/** Rows that are ALWAYS decided in JS: any non-ASCII character, or a backslash (a JSON escape). */
// Non-ASCII: fewer characters than bytes (cheaper than GLOB '*[^ -~]*', measured). A raw
// control character cannot sit inside a valid JSON string, and JSON.parse skips such rows.
const UNFILTERABLE_PARTICIPANTS = sql`length(participants) < length(CAST(participants AS BLOB)) OR instr(participants, char(92)) > 0`;
// The plain instr on the last four digits first: it rejects nearly every row before the
// six replace() calls run (those cost ~0.4 s per token over 671k rows; measured).
const PHONE_TOKEN_MATCH = sql`(instr(participants, ?) > 0 AND instr(replace(replace(replace(replace(replace(replace(participants, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''), ?) > 0)`;
const HANDLE_TOKEN_MATCH = sql`instr(lower(participants), ?) > 0`;

/** Threads with at least one row that can contribute one of the tokens. Bound: user id, then one value per token. */
function supersetThreadsSql(matchers: readonly SafeSql[]): SafeSql {
  return sql`SELECT DISTINCT thread_id
         FROM messages
        WHERE ${TEXT_THREAD_ROW}
          AND participants IS NOT NULL
          AND (${joinFragments([...matchers, UNFILTERABLE_PARTICIPANTS], sql` OR `)})`;
}

/** Highest rowid of the user's messages (any channel). Bound: user id. Index seek on idx_messages_user_id. */
export const MAX_MESSAGE_ROWID_SQL = sql`SELECT MAX(rowid) AS max_rowid FROM messages WHERE user_id = ?`;

/** Text rows added after a rowid. Bound: user id, rowid. Range on idx_messages_user_id. */
const TEXT_ROWS_AFTER_SQL = sql`SELECT DISTINCT thread_id
         FROM messages
        WHERE ${TEXT_THREAD_ROW}
          AND rowid > ?`;

const IN_CHUNK = 500;

/** Result of a targeted identity read. Pairs, not Maps: it crosses postMessage. */
export interface TargetedThreadIdentity {
  /** [thread_id, its 1:1 token or null] for every requested thread (attached threads). */
  attached: Array<[string, string | null]>;
  /** [thread_id, token] for every thread that is itself a 1:1 whose token is one of the pooled tokens. */
  oneToOne: Array<[string, string]>;
  /** Message rows materialised in JS. */
  rows: number;
  /** Threads the SQLite-side superset filter kept. */
  supersetThreads: number;
  /** True when a token had no textual form and the full index was read instead. */
  fullIndex: boolean;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** The 1:1 token of each thread (null for a group / identity-less thread), from ALL its rows. */
export function readThreadIdentitiesOn(
  db: ThreadIdentityRunner,
  userId: string,
  threadIds: readonly string[],
): { identities: Map<string, string | null>; rows: number } {
  const byThread = new Map<string, ThreadIdentityRow[]>();
  for (const tid of threadIds) byThread.set(tid, []);
  let rows = 0;
  for (const part of chunk([...new Set(threadIds)], IN_CHUNK)) {
    const got = db.prepare(threadRowsSql(part.length)).all(userId, ...part) as ThreadIdentityRow[];
    rows += got.length;
    for (const r of got) byThread.get(r.thread_id)?.push(r);
  }
  const identities = new Map<string, string | null>();
  for (const [tid, rws] of byThread) {
    const set = computeThreadIdentitySet(rws);
    identities.set(tid, set.size === 1 ? [...set][0] : null);
  }
  return { identities, rows };
}

/** A token that only String() of a nested array/object can produce: no textual form to filter on. */
export function tokenHasNoTextualForm(token: string): boolean {
  return token.includes(",") || token.includes("[object");
}

function tokenMatcher(token: string): { fragment: SafeSql; values: string[] } {
  if (token.startsWith("phone:")) {
    const digits = token.slice("phone:".length);
    return { fragment: PHONE_TOKEN_MATCH, values: [digits.slice(-4), digits] };
  }
  // handle:<lowercased handle>
  return { fragment: HANDLE_TOKEN_MATCH, values: [token.slice("handle:".length)] };
}

/**
 * Identity of the attached threads, plus every thread that is itself a 1:1 for one of
 * the attached threads' tokens. Reads only those threads' rows (see the file header).
 */
export function readTargetedThreadIdentityOn(
  db: ThreadIdentityRunner,
  userId: string,
  attachedThreadIds: readonly string[],
): TargetedThreadIdentity {
  const attachedRead = readThreadIdentitiesOn(db, userId, attachedThreadIds);
  let rows = attachedRead.rows;
  const tokens = new Set<string>();
  for (const token of attachedRead.identities.values()) if (token !== null) tokens.add(token);
  const attached = [...attachedRead.identities.entries()];

  if (tokens.size === 0) {
    return { attached, oneToOne: [], rows, supersetThreads: 0, fullIndex: false };
  }

  if ([...tokens].some(tokenHasNoTextualForm)) {
    const full = readOneToOneThreadIndexOn(db, userId);
    return {
      attached,
      oneToOne: full.oneToOne.filter(([, token]) => tokens.has(token)),
      rows: rows + full.rows,
      supersetThreads: 0,
      fullIndex: true,
    };
  }

  const matchers = [...tokens].map(tokenMatcher);
  const supersetIds = (
    db.prepare(supersetThreadsSql(matchers.map((m) => m.fragment))).all(userId, ...matchers.flatMap((m) => m.values)) as Array<{
      thread_id: string;
    }>
  ).map((r) => r.thread_id);
  rows += supersetIds.length;

  // Attached threads were read above; read only the rest.
  const attachedSet = new Set(attachedThreadIds);
  const others = supersetIds.filter((tid) => !attachedSet.has(tid));
  const otherRead = readThreadIdentitiesOn(db, userId, others);
  rows += otherRead.rows;

  const oneToOne: Array<[string, string]> = [];
  for (const [tid, token] of attachedRead.identities) if (token !== null) oneToOne.push([tid, token]);
  for (const [tid, token] of otherRead.identities) if (token !== null && tokens.has(token)) oneToOne.push([tid, token]);

  return { attached, oneToOne, rows, supersetThreads: supersetIds.length, fullIndex: false };
}

/** Highest message rowid of the user, or 0. */
export function readMaxMessageRowidOn(db: ThreadIdentityRunner, userId: string): number {
  const row = db.prepare(MAX_MESSAGE_ROWID_SQL).all(userId)[0] as { max_rowid: number | null } | undefined;
  return row?.max_rowid ?? 0;
}

/** Threads of the user's text rows added after `afterRowid`. */
export function readThreadIdsWithRowsAfterOn(db: ThreadIdentityRunner, userId: string, afterRowid: number): string[] {
  return (db.prepare(TEXT_ROWS_AFTER_SQL).all(userId, afterRowid) as Array<{ thread_id: string }>).map((r) => r.thread_id);
}

/** What the expansion asks for: a targeted read, or the threads that grew after a rowid. */
export type ThreadIdentityRequest =
  | { kind: "targeted"; attachedThreadIds: string[] }
  | { kind: "since"; afterRowid: number };

/** Result of a `since` request: each thread with rows after the rowid, with its 1:1 token or null. */
export interface ThreadsSinceIdentity {
  threads: Array<[string, string | null]>;
  rows: number;
}

export type ThreadIdentityResponse = TargetedThreadIdentity | ThreadsSinceIdentity;

/** One entry point for the worker and the main-thread fallback, so both run the same code. */
export function runThreadIdentityRequestOn(
  db: ThreadIdentityRunner,
  userId: string,
  request: ThreadIdentityRequest,
): ThreadIdentityResponse {
  if (request.kind === "targeted") return readTargetedThreadIdentityOn(db, userId, request.attachedThreadIds);
  const threadIds = readThreadIdsWithRowsAfterOn(db, userId, request.afterRowid);
  const read = readThreadIdentitiesOn(db, userId, threadIds);
  return { threads: [...read.identities.entries()], rows: threadIds.length + read.rows };
}
