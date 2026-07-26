/**
 * Attachment Text-Extraction Backfill (BACKLOG-2257, Phase B of the 322 plan)
 *
 * Mirrors the BACKLOG-2250 metadata-backfill pattern
 * ({@link emailAttachmentBackfillService}): a one-shot, idempotent, BOUNDED batch that
 * fills `attachments.text_content` for rows whose bytes are already downloaded but
 * whose text has never been extracted.
 *
 * Manual / dev trigger ONLY (IPC `attachments:extract-text-backfill`). It is NOT wired
 * into startup / login / sync — extraction on the live path happens fire-and-forget at
 * download time (see emailAttachmentService).
 *
 * Selection (the "pending" set):
 *     storage_path IS NOT NULL      -- bytes are on disk
 *   AND text_content IS NULL        -- never attempted (see empty-vs-NULL semantics)
 *   AND mime_type IN (<extractable>)-- pdf / text-plain / text-csv only, no OCR
 *
 * Idempotency: each processed row is written a value ("" for no-text, or the text),
 * so it leaves the pending set and a re-run does not re-extract it. Rows that ERROR
 * are left NULL and may be retried on a later manual run. Everything is LOCAL — no
 * network of any kind.
 */

import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import logService from "./logService";
import {
  extractTextForAttachment,
  EXTRACTABLE_MIME_SQL_LIST,
  type AttachmentTextRow,
} from "./attachmentTextExtractionService";

const SERVICE_NAME = "AttachmentTextExtraction";

/** Default cap on attachments processed per run (bounds local parse work). */
export const DEFAULT_MAX_ATTACHMENTS = 500;

export interface AttachmentTextBackfillOptions {
  /** Max attachments to process in a single run. Default {@link DEFAULT_MAX_ATTACHMENTS}. */
  maxAttachments?: number;
}

export interface AttachmentTextBackfillResult {
  /** Rows eligible for extraction at the START of this run. */
  totalPending: number;
  /** Rows an extraction was attempted for this run. */
  processed: number;
  /** Rows for which non-empty text was stored. */
  extracted: number;
  /** Rows attempted but stored "" (no text layer / empty / over-cap file). */
  skipped: number;
  /** Rows whose extraction failed (left NULL — may retry later). */
  errors: number;
  /** Pending rows not attempted this run (totalPending - processed) — run again to drain. */
  remaining: number;
}

/** A downloaded attachment awaiting text extraction. */
type PendingRow = { id: string; storage_path: string; mime_type: string };

const PENDING_WHERE = `
  FROM attachments
  WHERE storage_path IS NOT NULL
    AND text_content IS NULL
    AND mime_type IN (${EXTRACTABLE_MIME_SQL_LIST})
`;

/**
 * BACKLOG-2257: bounded, idempotent local text-extraction backfill.
 * Populates `attachments.text_content` for already-downloaded rows. Safe to invoke
 * repeatedly; each run drains up to `maxAttachments` and reports `remaining`.
 */
export async function backfillAttachmentTextContent(
  options: AttachmentTextBackfillOptions = {}
): Promise<AttachmentTextBackfillResult> {
  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const result: AttachmentTextBackfillResult = {
    totalPending: 0,
    processed: 0,
    extracted: 0,
    skipped: 0,
    errors: 0,
    remaining: 0,
  };

  try {
    const db = databaseService.getRawDatabase();

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n ${PENDING_WHERE}`)
      .get() as { n: number } | undefined;
    result.totalPending = totalRow?.n ?? 0;
    if (result.totalPending === 0) return result;

    const rows = db
      .prepare(
        `SELECT id, storage_path, mime_type ${PENDING_WHERE}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(maxAttachments) as PendingRow[];

    result.remaining = Math.max(0, result.totalPending - rows.length);
    if (rows.length === 0) return result;

    logService.info("BACKLOG-2257: backfilling attachment text_content", SERVICE_NAME, {
      candidates: rows.length,
      totalPending: result.totalPending,
    });

    for (const row of rows) {
      result.processed++;
      // text_content is NULL by the query's guard → eligible.
      const attachmentRow: AttachmentTextRow = { ...row, text_content: null };
      const outcome = await extractTextForAttachment(attachmentRow);
      if (outcome === "extracted") {
        result.extracted++;
      } else if (outcome === "error") {
        result.errors++;
      } else {
        // "empty" (stored "") or the defensive "ineligible" — both drain the row.
        result.skipped++;
      }
    }

    logService.info(
      "BACKLOG-2257: attachment text_content backfill complete",
      SERVICE_NAME,
      { ...result }
    );
  } catch (err) {
    logService.error(
      "BACKLOG-2257: attachment text_content backfill failed",
      SERVICE_NAME,
      { error: err instanceof Error ? err.message : "Unknown" }
    );
    Sentry.captureException(err, {
      tags: {
        service: "attachment-text-extraction",
        operation: "backfillAttachmentTextContent",
      },
    });
  }

  return result;
}
