/**
 * SQL for email/message deduplication lookups — BACKLOG-2989 chunk 4.
 *
 * Moved out of `electron/services/emailDeduplicationService.ts`. The rule and
 * its CI gate are BACKLOG-2959.
 *
 * ## Two identity tests, and they are not interchangeable
 *
 * `message_id_header` is the sender's own RFC-5322 Message-ID: authoritative
 * when present, absent or malformed often enough that it cannot be the only
 * test. `content_hash` is computed locally and always available, but two
 * genuinely distinct messages can share one (an identical automated
 * notification sent twice). So the pair is checked in that order — header
 * first, hash as the fallback — and both statements exist for that reason
 * rather than as variations on a theme.
 *
 * `duplicate_of IS NULL` appears in all four. A row already marked as a
 * duplicate must never be returned as the ORIGINAL a new message dedups
 * against: that would chain duplicates to duplicates and orphan the real row.
 *
 * ## The batch statements take VALUES, not a width
 *
 * The two batch lookups build an `IN (?, ?, ?)` list sized to their input. The
 * code this replaced computed the width in one place and bound the values in
 * another:
 *
 *     const placeholders = messageIds.map(() => "?").join(", ");
 *     ...
 *     .all(userId, ...messageIds)
 *
 * Those cannot disagree today, but nothing structural stops them: passing a
 * different array of the SAME LENGTH binds the wrong values and SQLite reports
 * no error, because the arity still matches. So these functions take the values
 * and execute — the width is derived from the array that is about to be bound,
 * and divergence is unrepresentable rather than merely unlikely.
 *
 * The single-row statements are byte-identical to the text they replaced
 * (`79c2c7914b51`, `b43cb4601f26`). The batch statements are recomposed, so
 * their control is the pin plus a boundary sweep over the `IN` width (0, 1, 2,
 * N) rather than a content hash.
 */

/** The minimal handle these lookups need (better-sqlite3-shaped). */
export interface DedupQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** One message by its sender-assigned Message-ID. Params: user id, header. */
export const FIND_BY_MESSAGE_ID_HEADER_SQL = `
          SELECT id FROM messages
          WHERE user_id = ?
            AND message_id_header = ?
            AND duplicate_of IS NULL
          LIMIT 1
        `;

/** One message by locally computed content hash. Params: user id, hash. */
export const FIND_BY_CONTENT_HASH_SQL = `
          SELECT id FROM messages
          WHERE user_id = ?
            AND content_hash = ?
            AND duplicate_of IS NULL
          LIMIT 1
        `;

/**
 * An empty batch is answered without touching the database.
 *
 * Not a micro-optimisation: `IN ()` is VALID SQLite that matches nothing (see
 * `attachmentTextExtractionSql` for the measurement), so building one would
 * work by accident rather than by design. Returning early states the intent.
 */
function emptyResult<T>(): T[] {
  return [];
}

/**
 * Existing messages among a batch of Message-IDs.
 *
 * Takes the values; derives the `IN` width from them. Params bound: the user
 * id, then every id in the array, in order.
 */
export function findExistingByMessageIdHeaders(
  db: DedupQueryable,
  userId: string,
  messageIdHeaders: readonly string[],
): Array<{ id: string; message_id_header: string }> {
  if (messageIdHeaders.length === 0) return emptyResult();
  const placeholders = messageIdHeaders.map(() => "?").join(", ");
  return db
    .prepare(
      `
            SELECT id, message_id_header FROM messages
            WHERE user_id = ?
              AND message_id_header IN (${placeholders})
              AND duplicate_of IS NULL
          `,
    )
    .all(userId, ...messageIdHeaders) as Array<{
    id: string;
    message_id_header: string;
  }>;
}

/**
 * Existing messages among a batch of content hashes. Same shape and the same
 * reason: the width comes from the array that is bound.
 */
export function findExistingByContentHashes(
  db: DedupQueryable,
  userId: string,
  contentHashes: readonly string[],
): Array<{ id: string; content_hash: string }> {
  if (contentHashes.length === 0) return emptyResult();
  const placeholders = contentHashes.map(() => "?").join(", ");
  return db
    .prepare(
      `
            SELECT id, content_hash FROM messages
            WHERE user_id = ?
              AND content_hash IN (${placeholders})
              AND duplicate_of IS NULL
          `,
    )
    .all(userId, ...contentHashes) as Array<{
    id: string;
    content_hash: string;
  }>;
}
