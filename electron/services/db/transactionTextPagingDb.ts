/**
 * BACKLOG-3884: the Texts tab reads a deal's linked texts as a CONVERSATION LIST
 * plus PAGES, never the whole set.
 *
 * Before this, opening the Texts tab of a deal whose linked threads carry a whole
 * phone history sent every linked text in one IPC reply (183,043 rows, ~152 MB on
 * the PC) and the renderer then grouped all of them.
 *
 * Two reads, both on the SAME rows `getCommunicationsWithMessages` returns for the
 * text channel (that reader is what export and submit use, and it is unchanged):
 *
 *   1. {@link transactionTextThreadsSql} — one row per linked conversation with its
 *      counts (deduplicated, reactions excluded) in the audit window and overall,
 *      and {@link transactionTextThreadSamplesSql} — a few header rows per
 *      conversation (its distinct participant sets) so the card can name it.
 *   2. {@link readTransactionTextPage} — one page of one conversation (or of the
 *      threads a contact-merged card shows), newest first.
 *
 * PAGING AND DE-DUPLICATION. The full reader de-duplicates in JS, by id and then by
 * `body_text|sent_at` (the hidden copy wins). Both keys imply the same `sent_at`. A
 * page therefore never ends inside a group of rows sharing one sent_at: the last
 * group is completed by a second read, and the same de-duplication applied to the
 * page equals applying it to the whole conversation. The scope of de-duplication is
 * the REQUEST: a merged contact card asks for all its threads at once, so a text in
 * two of them shows once and the hidden copy wins (SR B3). Counts are per thread, so a
 * merged card's count can exceed what it shows by its cross-thread duplicates; two
 * separate cards each keep their copy (the full reader keeps one).
 *
 * THREAD-LESS TEXTS (SR B4) are grouped per person, by the participant-set key the
 * tab has always used (threadlessTextKey.ts); they are read without the thread index
 * and filtered in JS, so they cost a read of the deal's thread-less texts.
 *
 * A same-timestamp group larger than {@link MAX_SAME_TIMESTAMP_GROUP} rows is split
 * by id instead (so no reply is unbounded); de-duplication inside such a group is
 * then per page.
 */
import { sql, type SafeSql } from "./core/sqlText";
import { joinFragments } from "./core/sqlFragments";
import { reactionExclusion } from "./reactionExclusion";
import { dedupeLinkedCommunicationRows } from "./linkedRowDedup";
import { isThreadlessKey, threadlessTextKey } from "./threadlessTextKey";
export { THREADLESS_KEY_PREFIX, isThreadlessKey, threadlessTextKey } from "./threadlessTextKey";
import type { Communication } from "../../types";

/** Rows per page the main process will return, whatever the caller asks for. */
export const MAX_TEXT_PAGE_ROWS = 200;

/** Larger same-timestamp groups are split by id rather than returned whole. */
export const MAX_SAME_TIMESTAMP_GROUP = 1000;

/** Header rows kept per conversation. */
export const MAX_THREAD_SAMPLES = 12;

export type { TextWindow, TextPageCursor, TextThreadSummary, TextPage } from "../../types/textThreads";
import type { TextWindow, TextPageCursor, TextThreadSummary, TextPage } from "../../types/textThreads";

export type TextDb = { prepare(sql: SafeSql): { all(...params: unknown[]): unknown[] } };
type Db = TextDb;

const TEXT_CHANNELS = sql`('sms', 'imessage', 'text')`;
/** Linked texts with a thread_id (the indexed path). */
const HAS_THREAD = sql`(m.thread_id IS NOT NULL AND m.thread_id <> '')`;
/** Linked texts without one (grouped per person in JS). */
export const NO_THREAD = sql`(m.thread_id IS NULL OR m.thread_id = '')`;
/** The sort key the pages run on (full reader: ORDER BY sent_at DESC). */
const SORT_KEY = sql`COALESCE(m.sent_at, '')`;
/** Epoch ms of the timestamp the renderer classifies on (sent_at || received_at; none = 0). */
// Integer milliseconds from the stored text (the renderer compares Date.getTime()
// integers). The julianday form gave the same answers on the fixture's edge rows;
// this one has no floating-point step at all.
const TS_TEXT = sql`COALESCE(NULLIF(m.sent_at, ''), NULLIF(m.received_at, ''))`;
const TS_MS = sql`COALESCE(CAST(strftime('%s', ${TS_TEXT}) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ${TS_TEXT}), 4, 3) AS INTEGER), 0)`;
/** Window predicate; bound: startMs, startMs, endMs, endMs (NULL = open). */
const IN_WINDOW = sql`((? IS NULL OR ${TS_MS} >= ?) AND (? IS NULL OR ${TS_MS} <= ?))`;

/**
 * The linked-text join of `getCommunicationsWithMessages`, text arm only.
 * Bound: transaction id.
 */
export const LINKED_TEXTS_FROM = sql`
    FROM communications c
    JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id
       AND +m.user_id = c.user_id)
    )
    LEFT JOIN message_thread_names tn ON (
      tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    )
    WHERE c.transaction_id = ?
      AND c.email_id IS NULL
      AND m.channel IN ${TEXT_CHANNELS}`;

/** The columns of `getCommunicationsWithMessages` for a text row (email-only ones NULL). */
const TEXT_ROW_COLUMNS = sql`
      m.id as id,
      c.id as communication_id,
      c.user_id,
      c.transaction_id,
      COALESCE(c.message_id, m.id) as message_id,
      c.email_id,
      c.link_source,
      c.link_confidence,
      c.match_reason,
      c.linked_at,
      c.created_at,
      m.channel as channel,
      m.channel as communication_type,
      m.body_text as body_text,
      m.body_text as body_plain,
      m.body_html as body,
      m.subject as subject,
      json_extract(m.participants, '$.from') as sender,
      (SELECT group_concat(value) FROM json_each(json_extract(m.participants, '$.to'))) as recipients,
      m.sent_at as sent_at,
      m.received_at as received_at,
      m.has_attachments as has_attachments,
      m.thread_id as thread_id,
      m.participants as participants,
      tn.display_name as thread_display_name,
      m.direction as direction,
      m.external_id as external_id,
      m.associated_message_type as associated_message_type,
      m.associated_message_guid as associated_message_guid,
      EXISTS (SELECT 1 FROM transaction_hidden_texts h
              WHERE h.transaction_id = c.transaction_id
                AND (h.message_id = m.id
                     OR (h.message_external_id IS NOT NULL AND h.message_external_id = m.external_id))
      ) AS hidden_from_export,
      NULL as source,
      NULL as cc,
      NULL as bcc,
      NULL as attachment_count`;

/**
 * The de-duplication key the JS dedup uses, as SQL: content for a non-empty
 * sms/imessage body, the message id otherwise. COUNT(DISTINCT key) per thread is the
 * number of rows the dedup keeps. The trim set is JavaScript's String.prototype.trim
 * whitespace, so a whitespace-only body is "empty" on both sides (SR).
 */
const DEDUP_KEY = sql`CASE
      WHEN m.channel IN ('sms', 'imessage') AND length(trim(COALESCE(m.body_text, ''), ' ' || char(9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) > 0
        THEN 'c:' || COALESCE(m.body_text, '') || '|' || COALESCE(m.sent_at, '')
      ELSE 'i:' || m.id
    END`;

/**
 * One row per linked conversation. Bound: window (4), window (4), transaction id.
 */
export function transactionTextThreadsSql(): SafeSql {
  const real = reactionExclusion("m");
  return sql`
    SELECT m.thread_id AS thread_key,
           COUNT(DISTINCT CASE WHEN ${real} THEN ${DEDUP_KEY} END) AS total_count,
           COUNT(DISTINCT CASE WHEN ${real} AND ${IN_WINDOW} THEN ${DEDUP_KEY} END) AS in_window_count,
           MAX(CASE WHEN ${real} THEN m.sent_at END) AS last_sent_at,
           MAX(CASE WHEN ${real} AND ${IN_WINDOW} THEN m.sent_at END) AS last_in_window_sent_at
    ${LINKED_TEXTS_FROM}
      AND ${HAS_THREAD}
    GROUP BY thread_key`;
}

/**
 * Header rows: per conversation, the newest row of each distinct (participants,
 * direction). Bound: transaction id.
 */
export function transactionTextThreadSamplesSql(): SafeSql {
  return sql`
    SELECT m.thread_id AS thread_key,
           MAX(${SORT_KEY}) AS sk,
           m.id AS id,
           m.thread_id AS thread_id,
           m.channel AS channel,
           m.channel AS communication_type,
           m.participants AS participants,
           m.direction AS direction,
           json_extract(m.participants, '$.from') AS sender,
           m.sent_at AS sent_at,
           m.received_at AS received_at,
           tn.display_name AS thread_display_name
    ${LINKED_TEXTS_FROM}
      AND ${HAS_THREAD}
      AND ${reactionExclusion("m")}
    GROUP BY thread_key, m.participants, m.direction`;
}

/**
 * Thread-less linked texts, the columns the per-person grouping, the counts and the
 * header rows need. Bound: window (4), transaction id.
 */
export function transactionThreadlessTextsSql(): SafeSql {
  return sql`
    SELECT m.id AS id,
           m.thread_id AS thread_id,
           m.channel AS channel,
           m.channel AS communication_type,
           m.participants AS participants,
           m.direction AS direction,
           json_extract(m.participants, '$.from') AS sender,
           m.body_text AS body_text,
           m.sent_at AS sent_at,
           m.received_at AS received_at,
           m.associated_message_type AS associated_message_type,
           tn.display_name AS thread_display_name,
           CASE WHEN ${IN_WINDOW} THEN 1 ELSE 0 END AS in_window
    ${LINKED_TEXTS_FROM}
      AND ${NO_THREAD}`;
}

type ThreadlessRow = Communication & { in_window: number; body_text: string | null };

const isRealRow = (r: { associated_message_type?: number | null }): boolean =>
  !(typeof r.associated_message_type === "number" && r.associated_message_type >= 2000 && r.associated_message_type <= 3005);

/** The JS dedup's key for one row (linkedRowDedup.ts): content for a non-empty text body, else id. */
function dedupKeyOf(r: { id: unknown; channel?: unknown; body_text?: unknown; sent_at?: unknown }): string {
  const body = typeof r.body_text === "string" ? r.body_text : "";
  const text = r.channel === "sms" || r.channel === "imessage";
  return text && body.trim().length > 0 ? `c:${body}|${(r.sent_at as string | null) || ""}` : `i:${r.id as string}`;
}

/** Pure: thread-less rows -> one summary per person (threadlessTextKey). */
export function buildThreadlessSummaries(rows: readonly ThreadlessRow[]): TextThreadSummary[] {
  const groups = new Map<string, ThreadlessRow[]>();
  for (const r of rows) {
    const k = threadlessTextKey(r.participants, r.id as string);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: TextThreadSummary[] = [];
  for (const [key, g] of groups) {
    const real = g.filter(isRealRow);
    const all = new Set(real.map(dedupKeyOf));
    if (all.size === 0) continue;
    const inWin = real.filter((r) => r.in_window === 1);
    const newest = (list: ThreadlessRow[]): string | null =>
      list.reduce<string | null>((m, r) => {
        const s = (r.sent_at as string | null) ?? null;
        return s !== null && (m === null || s > m) ? s : m;
      }, null);
    const seen = new Set<string>();
    const samples = [...real]
      .sort((a, b) => (((a.sent_at as string) ?? "") < ((b.sent_at as string) ?? "") ? 1 : -1))
      .filter((r) => {
        const k = `${String(r.participants)}|${String(r.direction)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_THREAD_SAMPLES)
      .map(({ in_window: _w, body_text: _b, ...rest }) => rest as Communication);
    out.push({
      threadId: key,
      totalCount: all.size,
      inWindowCount: new Set(inWin.map(dedupKeyOf)).size,
      lastSentAt: newest(real),
      lastInWindowSentAt: newest(inWin),
      samples,
    });
  }
  return out;
}

function windowParams(w: TextWindow | null): unknown[] {
  const s = w?.startMs ?? null;
  const e = w?.endMs ?? null;
  return [s, s, e, e];
}

/** Parameters of {@link transactionTextThreadsSql}. */
export function transactionTextThreadsParams(transactionId: string, w: TextWindow | null): unknown[] {
  return [...windowParams(w), ...windowParams(w), transactionId];
}

interface ThreadCountRow {
  thread_key: string;
  total_count: number;
  in_window_count: number;
  last_sent_at: string | null;
  last_in_window_sent_at: string | null;
}

type SampleRow = Communication & { thread_key: string; sk: string };

/** Both summary reads on a caller-supplied connection (main or the contact worker). */
export function readTransactionTextThreadsOn(
  db: Db,
  transactionId: string,
  w: TextWindow | null,
): TextThreadSummary[] {
  const counts = db.prepare(transactionTextThreadsSql()).all(...transactionTextThreadsParams(transactionId, w)) as ThreadCountRow[];
  const samples = db.prepare(transactionTextThreadSamplesSql()).all(transactionId) as SampleRow[];
  const threadless = db.prepare(transactionThreadlessTextsSql()).all(...windowParams(w), transactionId) as ThreadlessRow[];
  return sortSummaries([...buildTextThreadSummaries(counts, samples), ...buildThreadlessSummaries(threadless)]);
}

/** Pure: counts + sample rows -> summaries, newest conversation first. */
export function buildTextThreadSummaries(
  counts: readonly ThreadCountRow[],
  samples: readonly SampleRow[],
): TextThreadSummary[] {
  const byThread = new Map<string, SampleRow[]>();
  for (const s of samples) {
    const list = byThread.get(s.thread_key);
    if (list) list.push(s);
    else byThread.set(s.thread_key, [s]);
  }
  const out: TextThreadSummary[] = [];
  for (const c of counts) {
    if (!c.total_count) continue; // reaction-only conversation: not a conversation (BACKLOG-2280)
    const rows = (byThread.get(c.thread_key) ?? [])
      .sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0))
      .slice(0, MAX_THREAD_SAMPLES)
      .map(({ thread_key: _k, sk: _s, ...rest }) => rest as Communication);
    out.push({
      threadId: c.thread_key,
      totalCount: c.total_count,
      inWindowCount: c.in_window_count,
      lastSentAt: c.last_sent_at,
      lastInWindowSentAt: c.last_in_window_sent_at,
      samples: rows,
    });
  }
  return sortSummaries(out);
}

function sortSummaries(list: TextThreadSummary[]): TextThreadSummary[] {
  return list.sort((a, b) => ((a.lastSentAt ?? "") < (b.lastSentAt ?? "") ? 1 : (a.lastSentAt ?? "") > (b.lastSentAt ?? "") ? -1 : 0));
}

type PageRow = Communication & { sk: string | null; communication_id?: string };

/** One link row of the page, before its full row is built: (link, message, sort key). */
interface LightRow {
  communication_id: string;
  id: string;
  sk: string | null;
}

/** Sort: sent_at DESC (NULL last), then id ASC — the order every page is cut in. */
function cmpRows(x: { sk: string | null; id: unknown }, y: { sk: string | null; id: unknown }): number {
  if (x.sk !== y.sk) {
    if (x.sk === null) return 1;
    if (y.sk === null) return -1;
    return x.sk < y.sk ? 1 : -1;
  }
  const xi = x.id as string;
  const yi = y.id as string;
  return xi < yi ? -1 : xi > yi ? 1 : 0;
}

const DAY_MS = 86_400_000;

/** Rows whose full columns were built, per page request (test seam for the build bound). */
let lastPageBuiltRows = 0;
export function lastTextPageBuiltRowsForTests(): number {
  return lastPageBuiltRows;
}

/**
 * One page of the given conversation(s), newest first, de-duplicated across the whole
 * request with the full reader's rules. `limit` is capped at {@link MAX_TEXT_PAGE_ROWS}.
 *
 * Two phases. (1) Pick the page on cheap columns only — (link id, message id,
 * sent_at). A named thread is read through idx_messages_thread_sent with ORDER/LIMIT,
 * so a page costs about a page of index entries. A person's thread-less texts have no
 * index to page on: ONE cheap read per request (id, participants, sent_at) is grouped
 * per person in memory and paged there (SR). (2) Build the full row (the recipients
 * json_each, the hidden-text EXISTS) only for the page's rows.
 */
export function readTransactionTextPage(
  db: Db,
  transactionId: string,
  threadKeys: readonly string[],
  w: TextWindow | null,
  cursor: TextPageCursor | null,
  limit: number,
): TextPage {
  const keys = [...new Set(threadKeys)];
  if (keys.length === 0) return { rows: [], nextCursor: null };
  const n = Math.max(1, Math.min(MAX_TEXT_PAGE_ROWS, Math.floor(Number(limit) || MAX_TEXT_PAGE_ROWS)));
  // A sargable superset of the window on sent_at (a day of slack either side covers
  // any offset); the exact window test decides.
  const lo = w && w.startMs !== null ? new Date(w.startMs - DAY_MS).toISOString() : null;
  const hi = w && w.endMs !== null ? new Date(w.endMs + DAY_MS).toISOString() : null;
  const named = keys.filter((k) => !isThreadlessKey(k));
  const people = new Set(keys.filter(isThreadlessKey));
  const scope = sql`
        AND ${IN_WINDOW}
        AND (? IS NULL OR m.sent_at IS NULL OR m.sent_at = '' OR m.sent_at >= ?)
        AND (? IS NULL OR m.sent_at IS NULL OR m.sent_at = '' OR m.sent_at <= ?)`;
  const scopeParams = (): unknown[] => [...windowParams(w), lo, lo, hi, hi];

  // The requested people's thread-less texts: one cheap read, grouped once.
  let threadless: LightRow[] | null = null;
  const threadlessRows = (): LightRow[] => {
    if (threadless) return threadless;
    const got = db.prepare(sql`
      SELECT c.id AS communication_id, m.id AS id, m.sent_at AS sk, m.participants AS participants
      ${LINKED_TEXTS_FROM}
        AND ${NO_THREAD}
        ${scope}`).all(transactionId, ...scopeParams()) as Array<LightRow & { participants: unknown }>;
    threadless = got
      .filter((r) => people.has(threadlessTextKey(r.participants, r.id)))
      .map((r) => ({ communication_id: r.communication_id, id: r.id, sk: r.sk ?? null }))
      .sort(cmpRows);
    return threadless;
  };

  /**
   * The light rows matching one predicate, in page order, at most `max` per source
   * (null = all): the SQL form for named threads, the same test in JS for people.
   */
  const pick = (extra: SafeSql, extraParams: unknown[], js: (r: LightRow) => boolean, max: number | null, byId = false): LightRow[] => {
    const out: LightRow[] = [];
    const order = byId ? sql`ORDER BY m.id ASC` : sql`ORDER BY m.sent_at DESC, m.id ASC`;
    for (const key of named) {
      const statement = sql`
      SELECT c.id AS communication_id, m.id AS id, m.sent_at AS sk
      ${LINKED_TEXTS_FROM}
        AND m.thread_id = ?
        ${scope}
        AND ${extra}
      ${order} ${max === null ? sql`` : sql`LIMIT ?`}`;
      const params = [transactionId, key, ...scopeParams(), ...extraParams, ...(max === null ? [] : [max])];
      out.push(...(db.prepare(statement).all(...params) as LightRow[]).map((r) => ({ ...r, sk: r.sk ?? null })));
    }
    if (people.size > 0) {
      const mine = threadlessRows().filter(js);
      out.push(...(max === null ? mine : mine.slice(0, max)));
    }
    return out.sort(cmpRows);
  };

  const sameIdAs = (rows: LightRow[]): LightRow[] => {
    // Never split one message id (two link rows) across pages.
    if (rows.length === 0) return rows;
    const last = rows[rows.length - 1];
    const have = new Set(rows.filter((r) => r.id === last.id).map((r) => r.communication_id));
    const same = last.sk === null
      ? pick(sql`m.sent_at IS NULL AND m.id = ?`, [last.id], (r) => r.sk === null && r.id === last.id, null)
      : pick(sql`m.sent_at = ? AND m.id = ?`, [last.sk, last.id], (r) => r.sk === last.sk && r.id === last.id, null);
    for (const r of same) if (!have.has(r.communication_id)) rows.push(r);
    return rows;
  };
  const done = (rows: LightRow[], next: TextPageCursor | null): TextPage => finish(build(db, rows), next);

  // Phase 2: rows with no sent_at, by id.
  if (cursor && cursor.sk === null) {
    const after = cursor.afterId;
    const got = pick(sql`m.sent_at IS NULL AND (? IS NULL OR m.id > ?)`, [after, after], (r) => r.sk === null && (after === null || r.id > after), n + 1, true);
    if (got.length > n) {
      const page = sameIdAs(got.slice(0, n));
      return done(page, { sk: null, afterId: page[page.length - 1].id });
    }
    return done(got, null);
  }

  const rows: LightRow[] = [];
  // Inside an oversized same-timestamp group: continue it by id.
  if (cursor && cursor.afterId !== null) {
    const { sk, afterId } = cursor;
    const inGroup = pick(sql`m.sent_at = ? AND m.id > ?`, [sk, afterId], (r) => r.sk === sk && r.id > afterId, n + 1, true);
    if (inGroup.length > n) {
      const page = sameIdAs(inGroup.slice(0, n));
      return done(page, { sk, afterId: page[page.length - 1].id });
    }
    rows.push(...inGroup);
  }

  const room = n - rows.length;
  const below = cursor ? sql`m.sent_at < ?` : sql`m.sent_at IS NOT NULL`;
  const belowParams = cursor ? [cursor.sk] : [];
  const cut = cursor ? (cursor.sk as string) : null;
  const more = pick(below, belowParams, (r) => r.sk !== null && (cut === null || r.sk < cut), room + 1);
  if (more.length > room) {
    const page = more.slice(0, room);
    const lastSk = page[page.length - 1].sk as string;
    const head = page.filter((r) => r.sk !== lastSk);
    const group = pick(sql`m.sent_at = ?`, [lastSk], (r) => r.sk === lastSk, MAX_SAME_TIMESTAMP_GROUP + 1, true);
    if (group.length <= MAX_SAME_TIMESTAMP_GROUP) {
      rows.push(...head, ...group);
      return done(rows, { sk: lastSk, afterId: null });
    }
    // Oversized group: keep what fits, by id, and continue by id next time.
    const tail = sameIdAs(page.filter((r) => r.sk === lastSk));
    rows.push(...head, ...tail);
    return done(rows, { sk: lastSk, afterId: tail[tail.length - 1].id });
  }
  rows.push(...more);
  // Dated rows are done; rows with no sent_at (if any) come next.
  const undated = pick(sql`m.sent_at IS NULL`, [], (r) => r.sk === null, 1);
  if (undated.length === 0) return done(rows, null);
  if (rows.length === 0) return readTransactionTextPage(db, transactionId, keys, w, { sk: null, afterId: null }, n);
  return done(rows, { sk: null, afterId: null });
}

/** Build the full rows of the page's (link, message) pairs only, in page order. */
function build(db: Db, rows: readonly LightRow[]): PageRow[] {
  lastPageBuiltRows = rows.length;
  if (rows.length === 0) return [];
  const pairs = joinFragments(rows.map(() => sql`(?, ?)`), sql`, `);
  const statement = sql`
    WITH p(pcid, pmid) AS (VALUES ${pairs})
    SELECT ${TEXT_ROW_COLUMNS}
    FROM p
    JOIN communications c ON c.id = p.pcid
    JOIN messages m ON m.id = p.pmid
    LEFT JOIN message_thread_names tn ON (
      tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    )`;
  const full = db.prepare(statement).all(...rows.flatMap((r) => [r.communication_id, r.id])) as PageRow[];
  return full.map((r) => ({ ...r, sk: (r.sent_at as string | null) ?? null })).sort(cmpRows);
}

function finish(rows: PageRow[], next: TextPageCursor | null): TextPage {
  // De-duplicate the whole page (every thread of the request together, SR B3), in
  // the order the page is sorted in: a text in two threads of a merged card shows
  // once, and the hidden copy wins.
  const page = rows.map(({ sk: _sk, ...rest }) => rest as Communication);
  const out = dedupeLinkedCommunicationRows(page);
  out.sort((a, b) => {
    const sa = (a.sent_at as string | null) ?? "";
    const sb = (b.sent_at as string | null) ?? "";
    return sa < sb ? 1 : sa > sb ? -1 : 0;
  });
  return { rows: out, nextCursor: next };
}
