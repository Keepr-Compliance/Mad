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
 * ONE THREAD (counts are per thread too); a content duplicate in two different
 * threads is kept in both, where the full reader keeps one.
 *
 * A same-timestamp group larger than {@link MAX_SAME_TIMESTAMP_GROUP} rows is split
 * by id instead (so no reply is unbounded); de-duplication inside such a group is
 * then per page.
 */
import { sql, type SafeSql } from "./core/sqlText";
import { reactionExclusion } from "./reactionExclusion";
import { dedupeLinkedCommunicationRows } from "./linkedRowDedup";
import type { Communication } from "../../types";

/** Thread key for linked texts that carry no thread_id. */
export const UNTHREADED_TEXT_KEY = "__unthreaded__";

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
/** The thread key: thread_id, or one bucket for threadless texts. */
export const THREAD_KEY = sql`COALESCE(NULLIF(m.thread_id, ''), '__unthreaded__')`;
/** The sort key the pages run on (full reader: ORDER BY sent_at DESC). */
const SORT_KEY = sql`COALESCE(m.sent_at, '')`;
/** Epoch ms of the timestamp the renderer classifies on (sent_at || received_at; none = 0). */
const TS_MS = sql`COALESCE((julianday(COALESCE(NULLIF(m.sent_at, ''), NULLIF(m.received_at, ''))) - 2440587.5) * 86400000.0, 0)`;
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
 * number of rows the dedup keeps.
 */
const DEDUP_KEY = sql`CASE
      WHEN m.channel IN ('sms', 'imessage') AND length(trim(COALESCE(m.body_text, ''))) > 0
        THEN 'c:' || COALESCE(m.body_text, '') || '|' || COALESCE(m.sent_at, '')
      ELSE 'i:' || m.id
    END`;

/**
 * One row per linked conversation. Bound: window (4), window (4), transaction id.
 */
export function transactionTextThreadsSql(): SafeSql {
  const real = reactionExclusion("m");
  return sql`
    SELECT ${THREAD_KEY} AS thread_key,
           COUNT(DISTINCT CASE WHEN ${real} THEN ${DEDUP_KEY} END) AS total_count,
           COUNT(DISTINCT CASE WHEN ${real} AND ${IN_WINDOW} THEN ${DEDUP_KEY} END) AS in_window_count,
           MAX(CASE WHEN ${real} THEN m.sent_at END) AS last_sent_at,
           MAX(CASE WHEN ${real} AND ${IN_WINDOW} THEN m.sent_at END) AS last_in_window_sent_at
    ${LINKED_TEXTS_FROM}
    GROUP BY thread_key`;
}

/**
 * Header rows: per conversation, the newest row of each distinct (participants,
 * direction). Bound: transaction id.
 */
export function transactionTextThreadSamplesSql(): SafeSql {
  return sql`
    SELECT ${THREAD_KEY} AS thread_key,
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
      AND ${reactionExclusion("m")}
    GROUP BY thread_key, m.participants, m.direction`;
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
  return buildTextThreadSummaries(counts, samples);
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
  out.sort((a, b) => ((a.lastSentAt ?? "") < (b.lastSentAt ?? "") ? 1 : (a.lastSentAt ?? "") > (b.lastSentAt ?? "") ? -1 : 0));
  return out;
}

type PageRow = Communication & { sk: string | null; communication_id?: string };

/** Sort: sent_at DESC (NULL last), then id ASC — the order every page is cut in. */
function cmpRows(x: PageRow, y: PageRow): number {
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

/**
 * One page of the given conversation(s), newest first, de-duplicated per thread with
 * the full reader's rules. `limit` is capped at {@link MAX_TEXT_PAGE_ROWS}.
 *
 * Each thread is read on its own, through idx_messages_thread_sent (thread_id,
 * sent_at), so a page costs about a page of index entries however long the thread is;
 * a merged card's threads are merged here.
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
  // any offset); the exact window test above it decides.
  const lo = w && w.startMs !== null ? new Date(w.startMs - DAY_MS).toISOString() : null;
  const hi = w && w.endMs !== null ? new Date(w.endMs + DAY_MS).toISOString() : null;

  // Two phases in one statement: pick the page's (link, message) pairs on the cheap
  // columns, then build the full row for those only. Building the row (the
  // recipients json_each, the hidden-text EXISTS) for every row of a long thread
  // before the sort made a page cost a read of the whole thread.
  const read = (key: string, extra: SafeSql, extraParams: unknown[], orderLimit: SafeSql, tailParams: unknown[]): PageRow[] => {
    const unthreaded = key === UNTHREADED_TEXT_KEY;
    const thread = unthreaded ? sql`(m.thread_id IS NULL OR m.thread_id = '')` : sql`m.thread_id = ?`;
    const statement = sql`
    SELECT ${TEXT_ROW_COLUMNS}
    FROM (
      SELECT c.id AS pcid, m.id AS pmid, m.sent_at AS psk
      ${LINKED_TEXTS_FROM}
        AND ${thread}
        AND ${IN_WINDOW}
        AND (? IS NULL OR m.sent_at IS NULL OR m.sent_at >= ?)
        AND (? IS NULL OR m.sent_at IS NULL OR m.sent_at <= ?)
        AND ${extra}
      ${orderLimit}
    ) p
    JOIN communications c ON c.id = p.pcid
    JOIN messages m ON m.id = p.pmid
    LEFT JOIN message_thread_names tn ON (
      tn.thread_id = m.thread_id AND tn.user_id = m.user_id
    )`;
    const params = [transactionId, ...(unthreaded ? [] : [key]), ...windowParams(w), lo, lo, hi, hi, ...extraParams, ...tailParams];
    return (db.prepare(statement).all(...params) as PageRow[]).map((r) => ({ ...r, sk: (r.sent_at as string | null) ?? null }));
  };
  const readAll = (extra: SafeSql, extraParams: unknown[], orderLimit: SafeSql, tailParams: unknown[]): PageRow[] => {
    const out: PageRow[] = [];
    for (const k of keys) out.push(...read(k, extra, extraParams, orderLimit, tailParams));
    return out.sort(cmpRows);
  };
  const byIdAfter = sql`ORDER BY m.id ASC LIMIT ?`;
  const sameIdAs = (rows: PageRow[]): PageRow[] => {
    // Never split one message id (two link rows) across pages.
    if (rows.length === 0) return rows;
    const last = rows[rows.length - 1];
    const have = new Set(rows.filter((r) => r.id === last.id).map((r) => r.communication_id as string));
    const same = last.sk === null
      ? readAll(sql`m.sent_at IS NULL AND m.id = ?`, [last.id], sql``, [])
      : readAll(sql`m.sent_at = ? AND m.id = ?`, [last.sk, last.id], sql``, []);
    for (const r of same) if (!have.has(r.communication_id as string)) rows.push(r);
    return rows;
  };

  // Phase 2: rows with no sent_at, by id.
  if (cursor && cursor.sk === null) {
    const got = readAll(sql`m.sent_at IS NULL AND (? IS NULL OR m.id > ?)`, [cursor.afterId, cursor.afterId], byIdAfter, [n + 1]);
    if (got.length > n) {
      const page = sameIdAs(got.slice(0, n));
      return finish(page, { sk: null, afterId: page[page.length - 1].id as string });
    }
    return finish(got, null);
  }

  const rows: PageRow[] = [];
  // Inside an oversized same-timestamp group: continue it by id.
  if (cursor && cursor.afterId !== null) {
    const inGroup = readAll(sql`m.sent_at = ? AND m.id > ?`, [cursor.sk, cursor.afterId], byIdAfter, [n + 1]);
    if (inGroup.length > n) {
      const page = sameIdAs(inGroup.slice(0, n));
      return finish(page, { sk: cursor.sk, afterId: page[page.length - 1].id as string });
    }
    rows.push(...inGroup);
  }

  const room = n - rows.length;
  const below = cursor ? sql`m.sent_at < ?` : sql`m.sent_at IS NOT NULL`;
  const belowParams = cursor ? [cursor.sk] : [];
  const more = readAll(below, belowParams, sql`ORDER BY m.sent_at DESC, m.id ASC LIMIT ?`, [room + 1]);
  if (more.length > room) {
    const page = more.slice(0, room);
    const lastSk = page[page.length - 1].sk as string;
    const head = page.filter((r) => r.sk !== lastSk);
    const group = readAll(sql`m.sent_at = ?`, [lastSk], byIdAfter, [MAX_SAME_TIMESTAMP_GROUP + 1]);
    if (group.length <= MAX_SAME_TIMESTAMP_GROUP) {
      rows.push(...head, ...group);
      return finish(rows, { sk: lastSk, afterId: null });
    }
    // Oversized group: keep what fits, by id, and continue by id next time.
    const tail = sameIdAs(page.filter((r) => r.sk === lastSk));
    rows.push(...head, ...tail);
    return finish(rows, { sk: lastSk, afterId: tail[tail.length - 1].id as string });
  }
  rows.push(...more);
  // Dated rows are done; rows with no sent_at (if any) come next.
  const undated = readAll(sql`m.sent_at IS NULL`, [], sql`LIMIT 1`, []);
  if (undated.length === 0) return finish(rows, null);
  if (rows.length === 0) return readTransactionTextPage(db, transactionId, keys, w, { sk: null, afterId: null }, n);
  return finish(rows, { sk: null, afterId: null });
}

function finish(rows: PageRow[], next: TextPageCursor | null): TextPage {
  // De-duplicate per thread, in the order the page is sorted in.
  const byThread = new Map<string, Communication[]>();
  const order: string[] = [];
  for (const r of rows) {
    const key = (r.thread_id as string | null) || UNTHREADED_TEXT_KEY;
    let list = byThread.get(key);
    if (!list) {
      list = [];
      byThread.set(key, list);
      order.push(key);
    }
    const { sk: _sk, ...rest } = r;
    list.push(rest as Communication);
  }
  const kept = new Set<Communication>();
  for (const key of order) for (const r of dedupeLinkedCommunicationRows(byThread.get(key) ?? [])) kept.add(r);
  const out: Communication[] = [];
  for (const key of order) for (const r of byThread.get(key) ?? []) if (kept.has(r)) out.push(r);
  // Keep the page newest-first across threads.
  out.sort((a, b) => {
    const sa = (a.sent_at as string | null) ?? "";
    const sb = (b.sent_at as string | null) ?? "";
    return sa < sb ? 1 : sa > sb ? -1 : 0;
  });
  return { rows: out, nextCursor: next };
}

