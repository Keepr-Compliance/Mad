/**
 * SQL for the transaction attachment counters — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/handlers/attachmentHandlers.ts`. The rule and its CI
 * gate are BACKLOG-2959.
 *
 * ## Two shapes here, and the reason is the audit window
 *
 * `EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL` is static, so the caller keeps its
 * `.prepare()` and the text is verified byte-identical by content hash.
 *
 * The four counters are not static. Each ends with a date filter the handler
 * assembles at run time from an optional audit window — nothing, a lower bound,
 * an upper bound, or both. That is a template with a runtime part, which the
 * gate reads as text authored outside the layer, so the `.prepare()` moved in
 * here instead. The handler now passes a SHAPE (two booleans) and keeps no SQL.
 *
 * **Nothing that crosses this boundary is SQL.** The window is described, not
 * spelled: `{ hasStart, hasEnd }`. A function here that accepted a filter
 * STRING would put the composition back outside the layer while appearing to
 * respect the rule, which is the failure this epic keeps finding.
 *
 * ## Why counts and sizes are four statements and not two
 *
 * Texts and emails reach a transaction by different routes. A text is linked
 * through `messages` and may be joined either directly (`c.message_id`) or via
 * its thread (`c.thread_id`), because a thread-level link covers every message
 * in it. An email is linked directly through `communications.email_id`. The
 * join shapes are genuinely different, so a single "attachments for a
 * transaction" statement would have to be a union that is harder to read than
 * the four it replaces.
 *
 * `COUNT(DISTINCT a.id)` on the text side is load-bearing: the thread-link arm
 * can match the same attachment through more than one `communications` row, and
 * a plain `COUNT(*)` would report an inflated attachment count on exactly the
 * transactions with the most linked conversation.
 */

/** The minimal handle these helpers need (better-sqlite3-shaped). */
export interface AttachmentStatsQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Which ends of the audit window the caller is binding. Booleans, never SQL —
 * see the module header.
 */
export interface AuditWindowShape {
  readonly hasStart: boolean;
  readonly hasEnd: boolean;
}

/**
 * Emails for one user that advertise attachments and have none stored.
 * One bound parameter: the user id.
 *
 * Byte-identical to the text it replaced (`fd1ee402faab`).
 *
 * NOTE — this predicate now exists in three places in the tree, and this move
 * did not merge them: `emailAttachmentBackfillSql.MISSING_WHERE` is the same
 * user-scoped test, and `submissionEmailSql` is the transaction-scoped variant.
 * Merging them would have changed statement text inside a mechanical move,
 * which is how a refactor smuggles a behaviour change past review. The
 * duplication is recorded on BACKLOG-2989 as a follow-up rather than fixed
 * here.
 */
export const EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL = `
      SELECT e.id, e.external_id, e.source, e.user_id
      FROM emails e
      WHERE e.user_id = ?
        AND e.has_attachments = 1
        AND e.external_id IS NOT NULL
        AND e.source IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
    `;

/**
 * The audit-window clauses, one per bound. Kept as private constants rather
 * than built inline so the two counter families cannot drift from each other.
 * `m.` is the messages alias, `e.` the emails alias.
 */
const TEXT_WINDOW_START = " AND m.sent_at >= ?";
const TEXT_WINDOW_END = " AND m.sent_at <= ?";
const EMAIL_WINDOW_START = " AND e.sent_at >= ?";
const EMAIL_WINDOW_END = " AND e.sent_at <= ?";

const textWindow = (w: AuditWindowShape): string =>
  `${w.hasStart ? TEXT_WINDOW_START : ""}${w.hasEnd ? TEXT_WINDOW_END : ""}`;

const emailWindow = (w: AuditWindowShape): string =>
  `${w.hasStart ? EMAIL_WINDOW_START : ""}${w.hasEnd ? EMAIL_WINDOW_END : ""}`;

/**
 * Attachments on TEXTS linked to a transaction, directly or through a thread.
 * Parameters: the transaction id, then whichever window bounds the shape says.
 */
const textStatsSql = (projection: string, w: AuditWindowShape): string => `
        SELECT ${projection}
        FROM attachments a
        INNER JOIN messages m ON a.message_id = m.id
        INNER JOIN communications c ON (
          (c.message_id IS NOT NULL AND c.message_id = m.id)
          OR
          (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
        )
        WHERE c.transaction_id = ?
        AND a.message_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${textWindow(w)}
      `;

/** Attachments on EMAILS linked to a transaction. */
const emailStatsSql = (projection: string, w: AuditWindowShape): string => `
        SELECT ${projection}
        FROM attachments a
        INNER JOIN emails e ON a.email_id = e.id
        INNER JOIN communications c ON c.email_id = e.id
        WHERE c.transaction_id = ?
        AND a.email_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${emailWindow(w)}
      `;

const COUNT_PROJECTION = "COUNT(DISTINCT a.id) as count";
const SIZE_PROJECTION = "COALESCE(SUM(a.file_size_bytes), 0) as total_size";

/**
 * `storage_path IS NOT NULL` appears in all four: an attachment row whose file
 * was never downloaded is not something the user can be shown or exported, so
 * counting it would overstate what the audit actually holds.
 */
export function prepareTextAttachmentCount(
  db: AttachmentStatsQueryable,
  w: AuditWindowShape,
): ReturnType<AttachmentStatsQueryable["prepare"]> {
  return db.prepare(textStatsSql(COUNT_PROJECTION, w));
}

export function prepareEmailAttachmentCount(
  db: AttachmentStatsQueryable,
  w: AuditWindowShape,
): ReturnType<AttachmentStatsQueryable["prepare"]> {
  return db.prepare(emailStatsSql(COUNT_PROJECTION, w));
}

/**
 * `COALESCE(SUM(...), 0)` rather than a bare `SUM`: over zero matching rows
 * SQLite's `SUM` is NULL, and the caller adds the two totals together — so
 * without the coalesce a transaction with no text attachments would produce
 * `null + n`, which is `null` in SQL and `NaN` after the cast.
 */
export function prepareTextAttachmentSize(
  db: AttachmentStatsQueryable,
  w: AuditWindowShape,
): ReturnType<AttachmentStatsQueryable["prepare"]> {
  return db.prepare(textStatsSql(SIZE_PROJECTION, w));
}

export function prepareEmailAttachmentSize(
  db: AttachmentStatsQueryable,
  w: AuditWindowShape,
): ReturnType<AttachmentStatsQueryable["prepare"]> {
  return db.prepare(emailStatsSql(SIZE_PROJECTION, w));
}
