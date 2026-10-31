/**
 * SQL for the attachment text-extraction backfill — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/services/attachmentTextExtractionBackfillService.ts`.
 * The rule and its CI gate are BACKLOG-2959.
 *
 * ## This is the one move in BACKLOG-2989 that deliberately CHANGES the SQL
 *
 * Every other statement this item moves is verified byte-identical by content
 * hash. These two cannot be, and the reason is worth stating plainly.
 *
 * The statements filtered on `mime_type IN (${EXTRACTABLE_MIME_SQL_LIST})`,
 * where that constant lived in `attachmentTextExtractionService.ts` and was
 * built by concatenating values into single quotes:
 *
 *     EXTRACTABLE_MIME_TYPES.map((m) => `'${m}'`).join(", ")
 *
 * Preserving the text would have meant one of two things, both rejected on
 * review: `db/` importing that fragment from `services/` (the BACKLOG-2789
 * inverse leak), or moving the extractor's CAPABILITY list into the database
 * layer so that `isExtractableMime()` — a predicate about what the parser can
 * read — would import its own capability list from `db/`.
 *
 * So the values are BOUND instead of interpolated. `mime_type IN (?, ?, ?)`,
 * one placeholder per type, values passed as data. Nothing SQL-shaped crosses
 * the layer boundary, which is what guardrail (i) is actually protecting: it
 * forbids SQL TEXT crossing, never data.
 *
 * That also deletes a service-side string-concatenation-into-SQL with no
 * escaping — safe today only because the three MIME types contain no
 * apostrophe. It is not a hazard that was worth carrying forward.
 *
 * **The control is replaced, not waived.** Because byte-identity cannot be
 * claimed, `chunk3TextExtraction.test.ts` runs a DIFFERENTIAL test: the
 * pre-move statement is reconstructed and both are executed against the same
 * real database, asserting the same exact ID SET across every branch of the
 * WHERE clause.
 *
 * ## An empty list is refused rather than silently matching nothing
 *
 * Measured on this project's driver, not assumed:
 *
 *     SELECT id FROM t WHERE mime IN ()        -> OK, []
 *     SELECT COUNT(*) AS n FROM t WHERE mime IN ()  -> OK, [{ n: 0 }]
 *
 * SQLite ACCEPTS an empty `IN` list and evaluates it as false. With the old
 * interpolation an empty capability list produced exactly that: the backfill
 * would report `totalPending: 0`, return successfully, and have done nothing —
 * indistinguishable from "nothing to do", with no error and no log.
 *
 * That failure mode predates this move. It is closed here because these
 * functions are being written fresh and the guard is three lines: an empty list
 * is a programming error, so it throws rather than quietly succeeding.
 */

/** The minimal handle these helpers need (better-sqlite3-shaped). */
export interface TextExtractionQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Rows the backfill still has to do: a file is on disk, no text has been
 * extracted from it yet, and its type is one the extractor can read.
 *
 * `storage_path IS NOT NULL` — the file must actually be downloaded.
 * `text_content IS NULL` — distinguishes "not attempted" from "attempted and
 * empty"; an extraction that legitimately yields no text stores an empty
 * string, and re-queueing those forever is how a bounded backfill stops
 * terminating.
 */
const pendingWhere = (placeholders: string): string => `
  FROM attachments
  WHERE storage_path IS NOT NULL
    AND text_content IS NULL
    AND mime_type IN (${placeholders})
`;

function placeholdersFor(mimeTypes: readonly string[]): string {
  if (mimeTypes.length === 0) {
    // See the module header: SQLite would accept `IN ()` and match nothing, so
    // the backfill would report a clean, complete run having examined no rows.
    throw new Error(
      "attachmentTextExtractionSql: mimeTypes is empty — `IN ()` is valid SQL that " +
        "matches nothing, so this would report a successful no-op backfill.",
    );
  }
  return mimeTypes.map(() => "?").join(", ");
}

/**
 * How many attachments are still awaiting extraction.
 * Bind: one parameter per MIME type, in the order given.
 */
export function preparePendingCount(
  db: TextExtractionQueryable,
  mimeTypes: readonly string[],
): ReturnType<TextExtractionQueryable["prepare"]> {
  return db.prepare(`SELECT COUNT(*) AS n ${pendingWhere(placeholdersFor(mimeTypes))}`);
}

/**
 * One page of pending attachments, newest first.
 * Bind: one parameter per MIME type, then the page size.
 */
export function preparePendingPage(
  db: TextExtractionQueryable,
  mimeTypes: readonly string[],
): ReturnType<TextExtractionQueryable["prepare"]> {
  return db.prepare(
    `SELECT id, storage_path, mime_type ${pendingWhere(placeholdersFor(mimeTypes))}
         ORDER BY created_at DESC
         LIMIT ?`,
  );
}

// ─── BACKLOG-3943: OCR second pass ────────────────────────────────────────────
//
// OCR state lives in `attachments.analysis_metadata` (JSON, nullable, no other
// writer or reader — founder ruling 1, 2026-10-31). `text_content` keeps its
// meaning; a row becomes an OCR candidate only after the text-layer pass has
// stored "" for it.
//
// A row is OCR-pending when:
//   - its bytes are on disk, the text-layer pass stored "", its type is one
//     the OCR child reads, AND
//   - it has never been OCR'd (metadata NULL), OR the last OCR attempt failed
//     in a way worth retrying (`retryable: true`) fewer than `maxAttempts`
//     times.
//
// `json_extract` is reached only through `CASE WHEN json_valid(...)`: SQLite
// raises "malformed JSON" from json_extract on a non-JSON value, and a CASE
// guarantees the order where AND does not. A stray non-JSON value therefore
// makes that one row ineligible (fails safe) instead of failing the query.

const ocrPendingWhere = (placeholders: string): string => `
  FROM attachments
  WHERE storage_path IS NOT NULL
    AND text_content = ''
    AND mime_type IN (${placeholders})
    AND (
      analysis_metadata IS NULL
      OR (CASE WHEN json_valid(analysis_metadata)
               THEN json_extract(analysis_metadata, '$.retryable') = 1
                    AND json_extract(analysis_metadata, '$.attempts') < ?
               ELSE 0 END)
    )
`;

/**
 * How many attachments are waiting for OCR.
 * Bind: one parameter per MIME type, then the max attempts.
 */
export function prepareOcrPendingCount(
  db: TextExtractionQueryable,
  mimeTypes: readonly string[],
): ReturnType<TextExtractionQueryable["prepare"]> {
  return db.prepare(`SELECT COUNT(*) AS n ${ocrPendingWhere(placeholdersFor(mimeTypes))}`);
}

/**
 * One page of OCR-pending attachment ids, newest first.
 * Bind: one parameter per MIME type, then the max attempts, then the page size.
 */
export function prepareOcrPendingPage(
  db: TextExtractionQueryable,
  mimeTypes: readonly string[],
): ReturnType<TextExtractionQueryable["prepare"]> {
  return db.prepare(
    `SELECT id ${ocrPendingWhere(placeholdersFor(mimeTypes))}
         ORDER BY created_at DESC
         LIMIT ?`,
  );
}

/** The fields the OCR pass reads before it starts. Bind: id. */
export const SELECT_ATTACHMENT_OCR_ROW_SQL = `SELECT storage_path, mime_type, text_content, analysis_metadata
       FROM attachments WHERE id = ? LIMIT 1`;

/**
 * The OCR write, compare-and-set (SR plan review R1). The row is written only
 * if it is still exactly as the OCR pass read it: text_content "" and the same
 * analysis_metadata value (`IS ?` matches NULL to NULL). If anything changed the
 * row while the child ran, zero rows change and the result is dropped.
 * Bind: text, metadata JSON, id, the metadata value read at the start (or NULL).
 */
export const CAS_ATTACHMENT_OCR_RESULT_SQL = `UPDATE attachments
          SET text_content = ?, analysis_metadata = ?
        WHERE id = ?
          AND text_content = ''
          AND analysis_metadata IS ?`;

/**
 * The text-layer write (BACKLOG-2257), now fill-only (SR plan review R2): it
 * sets text_content only where it is still NULL, so a stale backfill pass can
 * never overwrite text another pass (OCR, or the live download path) stored.
 * Bind: text, id.
 */
export const SET_ATTACHMENT_TEXT_IF_NULL_SQL = `UPDATE attachments SET text_content = ? WHERE id = ? AND text_content IS NULL`;
