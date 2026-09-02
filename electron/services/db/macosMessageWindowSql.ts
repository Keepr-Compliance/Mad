/**
 * The macOS Messages import WINDOW, built from plan data — BACKLOG-3062.
 *
 * ## Why this file exists
 *
 * `importHelpers.ts` passed BACKLOG-2990 chunk 1's completion criterion at
 * baseline zero while still authoring SQL in six places. The gate is not wrong:
 * it enumerates CALL SITES OF DATABASE VERBS, and `buildMessageWindowSql`
 * called no verb — it RETURNED SQL text for someone else to splice. Invisible by
 * construction, and the first such defect found inside already-merged, already-
 * approved work.
 *
 * `buildMessageWindowSql` is gone. It existed only to turn plan data into SQL
 * text; with the predicates built here from that same data, it has nothing left
 * to do.
 *
 * ## Values cross the boundary, text does not
 *
 * Every number now BINDS. `AND message.date > ${plan.cutoffNano}` became
 * `AND message.date > ?`. Apple's nanosecond timestamps and a ROWID are values,
 * and a value that travels as text is a value nobody can see going wrong — the
 * same conclusion this epic reached for the staging table names, the force-set
 * predicate and the extractable-MIME list.
 *
 * ## The rule
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter. The
 * builders here return text and execute nothing. The readers execute — and take
 * a `MessageWindow`, numbers, and the caller's bound `all` accessor, never SQL.
 *
 * ## The durable fix is BACKLOG-3064, not this file
 *
 * A branded SQL-text value that only `db/` can mint would make this class
 * impossible rather than merely absent here, and closes BACKLOG-3044 by
 * construction. Cited, deliberately not absorbed.
 */

/** The window a run imports, as DATA. Formerly `MessageWindowSql`, which was text. */
export interface MessageWindow {
  /** Apple-epoch nanoseconds; `null` means no date filter at all. */
  readonly cutoffNano: number | null;
  /** Audit periods whose messages are always complete. `endNano: null` = open-ended. */
  readonly protectedSpans: ReadonlyArray<{ startNano: number; endNano: number | null }>;
}

/** SQL and the values it binds, travelling together so they cannot drift apart. */
export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly number[];
}

const EMPTY: SqlFragment = { sql: "", params: [] };

/**
 * The date filter, or nothing.
 *
 * Returns `""` rather than `1=1` when there is no cutoff, because every caller
 * splices this into a WHERE that already has a term — keeping the empty case
 * empty is what lets the surrounding statements stay byte-stable.
 */
export function windowDateFilter(window: MessageWindow): SqlFragment {
  return window.cutoffNano === null
    ? EMPTY
    : { sql: "AND message.date > ?", params: [window.cutoffNano] };
}

/**
 * The protected-period predicate: TRUE for a message inside an audit period.
 *
 * `"0"` with no spans is load-bearing and not a placeholder. Callers use it as
 * `AND NOT (${protected})`, and `NOT (0)` is TRUE — every row is unprotected,
 * which is the correct reading of "no audit periods". A `""` here would produce
 * `AND NOT ()`, a syntax error.
 *
 * An open-ended span (`endNano: null`) is a deal that has not closed: everything
 * from its start onward is protected.
 *
 * `message.date IS NOT NULL` is per-span rather than hoisted, because these are
 * OR-ed: one span omitting it would make the whole disjunction NULL-permissive.
 */
export function protectedPredicate(window: MessageWindow): SqlFragment {
  if (window.protectedSpans.length === 0) return { sql: "0", params: [] };
  const params: number[] = [];
  const terms = window.protectedSpans.map((span) => {
    if (span.endNano === null) {
      params.push(span.startNano);
      return "(message.date IS NOT NULL AND message.date > ?)";
    }
    params.push(span.startNano, span.endNano);
    return "(message.date IS NOT NULL AND message.date > ? AND message.date <= ?)";
  });
  return { sql: terms.join(" OR "), params };
}

/**
 * BACKLOG-2772's Cap': everything from the cap window's start, PLUS everything
 * protected however old.
 *
 * A WHERE term rather than a cursor seed, because under Cap' the kept set is no
 * longer a contiguous ROWID tail — a protected message can be arbitrarily old,
 * and seeding the fetch cursor would skip every one of them.
 */
export function capFetchPredicate(
  window: MessageWindow,
  capWindowStartRowId: number | null,
): SqlFragment {
  if (capWindowStartRowId === null) return EMPTY;
  const protectedRows = protectedPredicate(window);
  return {
    sql: `AND (message.ROWID >= ? OR (${protectedRows.sql}))`,
    params: [capWindowStartRowId, ...protectedRows.params],
  };
}

/** `(sql, params?) => rows`, bound to an open chat.db handle by the caller. */
export type ChatDbAll = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Importable messages inside the window.
 *
 * BACKLOG-2280: reactions ARE imported, so this count and the fetch SELECT must
 * cover the SAME scope. The fetch loop runs `while (fetched < total)`, so a
 * count narrower than the SELECT terminates it early and silently drops the
 * newest rows, which are last under `ORDER BY message.ROWID ASC`.
 */
export async function countMessagesInWindow(
  all: ChatDbAll,
  window: MessageWindow,
): Promise<number> {
  const date = windowDateFilter(window);
  const rows = await all<{ count: number }>(
    `
          SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL ${date.sql}
        `,
    [...date.params],
  );
  return rows[0]?.count ?? 0;
}

/**
 * Messages inside the window that the cap GOVERNS — i.e. not protected.
 *
 * `protectedCount` is derived from this by subtraction rather than queried
 * separately: the two are guaranteed to sum by the totality of the predicate,
 * and deriving the subordinate number keeps them from ever reporting a partition
 * that does not add up.
 */
export async function countUnprotectedInWindow(
  all: ChatDbAll,
  window: MessageWindow,
): Promise<number> {
  const date = windowDateFilter(window);
  const prot = protectedPredicate(window);
  const rows = await all<{ count: number }>(
    `
      SELECT COUNT(*) as count FROM message
      WHERE message.guid IS NOT NULL ${date.sql} AND NOT (${prot.sql})
    `,
    [...date.params, ...prot.params],
  );
  return rows[0]?.count ?? 0;
}

/**
 * The ROWID of the Nth-newest UNPROTECTED message — where the cap window starts.
 *
 * BACKLOG-2744: when the cap bites, keep the NEWEST N, not the oldest. The fetch
 * is keyset pagination on ROWID ASC, so simply stopping at N walks upward from 0
 * and keeps the archive where the Settings copy promises "most recent". Do NOT
 * fix that by flipping the ORDER BY — the ascending order IS the fetch cursor.
 *
 * BACKLOG-2772's `AND NOT (protected)` is load-bearing: the offset is taken
 * against the set the cap governs, so a protected row must not occupy an offset
 * slot. With protected rows counted, the Nth-newest lands too far back and the
 * run keeps FEWER than `maxMessages` unprotected messages while believing it
 * kept exactly that many.
 *
 * Takes no join. The count is join-free, and joining `chat_message_join` here
 * would let a message belonging to two chats occupy two offset slots.
 *
 * `null` when the OFFSET falls out of range — reachable without a throw, because
 * each read runs against a live WAL-mode chat.db that Messages is writing to.
 */
export async function resolveCapWindowStartRowId(
  all: ChatDbAll,
  window: MessageWindow,
  maxMessages: number,
): Promise<number | null> {
  const date = windowDateFilter(window);
  const prot = protectedPredicate(window);
  const rows = await all<{ start_rowid: number }>(
    `
      SELECT message.ROWID as start_rowid
      FROM message
      WHERE message.guid IS NOT NULL
        ${date.sql}
        AND NOT (${prot.sql})
      ORDER BY message.ROWID DESC
      LIMIT 1 OFFSET ?
    `,
    [...date.params, ...prot.params, maxMessages - 1],
  );
  return rows[0]?.start_rowid ?? null;
}

/**
 * One page of importable messages, newest-safe keyset pagination on ROWID.
 *
 * Parameter ORDER follows the text, because these bind positionally: the cursor
 * first (it is in the WHERE before the window terms), then the date filter, then
 * the cap predicate, then the page size. That ordering is the reason `sql` and
 * `params` travel together in one object — two expressions maintained apart
 * drift the moment a term is added in the middle.
 *
 * `ORDER BY message.ROWID ASC` IS the pagination cursor. Do not flip it to get
 * newest-first; `capFetchPredicate` is what bounds the set to the newest N.
 */
export async function selectMessageBatch<T>(
  all: ChatDbAll,
  window: MessageWindow,
  capWindowStartRowId: number | null,
  lastRowId: number,
  batchLimit: number,
): Promise<T[]> {
  const date = windowDateFilter(window);
  const cap = capFetchPredicate(window, capWindowStartRowId);
  return all<T>(
    `
            SELECT
              message.ROWID as id,
              message.guid,
              message.text,
              message.attributedBody,
              message.date,
              message.is_from_me,
              handle.id as handle_id,
              message.service,
              chat_message_join.chat_id,
              message.cache_has_attachments,
              message.associated_message_type,
              message.associated_message_guid
            FROM message
            LEFT JOIN handle ON message.handle_id = handle.ROWID
            LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
            WHERE message.guid IS NOT NULL AND message.ROWID > ?
              ${date.sql}
              ${cap.sql}
            ORDER BY message.ROWID ASC
            LIMIT ?
          `,
    [lastRowId, ...date.params, ...cap.params, batchLimit],
  );
}

/**
 * Attachment sizes for the admitted set, for the pre-flight disk estimate.
 *
 * `GROUP BY attachment.ROWID`: one source file counts ONCE even when it is
 * joined to several messages. Same ROWID = same source path = same content hash
 * = a single copy on disk. Counting it per-message would overstate the estimate
 * and could refuse an import that fits.
 */
export async function selectAttachmentSizes<T>(
  all: ChatDbAll,
  window: MessageWindow,
  capWindowStartRowId: number | null,
): Promise<T[]> {
  const date = windowDateFilter(window);
  const cap = capFetchPredicate(window, capWindowStartRowId);
  return all<T>(
    `
          SELECT
            attachment.filename as filename,
            attachment.transfer_name as transfer_name,
            attachment.total_bytes as total_bytes,
            message.guid as message_guid
          FROM attachment
          JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
          JOIN message ON message.ROWID = message_attachment_join.message_id
          WHERE message.guid IS NOT NULL AND attachment.filename IS NOT NULL ${date.sql} ${cap.sql}
          GROUP BY attachment.ROWID
        `,
    [...date.params, ...cap.params],
  );
}
