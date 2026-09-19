/**
 * SQL for the pre-export attachment sweep — BACKLOG-2989 (epic BACKLOG-2958).
 *
 * Moved out of `submissionService.downloadMissingEmailAttachments` so that the
 * text lives in `electron/services/db/**` like every other statement in the
 * app. The rule and its CI gate are BACKLOG-2959; this module is one of the
 * moves BACKLOG-2989 makes to satisfy it.
 *
 * ## What the statement is for
 *
 * BACKLOG-1369. An export is only honest if the attachments it claims to
 * include are actually on disk. `emails.has_attachments` is set from the
 * provider's own metadata at sync time, but the attachment ROWS are fetched
 * lazily, so a transaction can be linked to an email that advertises
 * attachments and has none stored. This finds exactly those emails, so the
 * submission path can fetch them before it packages anything.
 *
 * ## Why each clause is load-bearing
 *
 *  - `INNER JOIN communications` — scope is one transaction, not the mailbox.
 *  - `has_attachments = 1` — the provider said there is something to fetch.
 *  - `external_id IS NOT NULL AND source IS NOT NULL` — without both, the row
 *    cannot be re-fetched from any provider, so selecting it produces a
 *    download attempt that can only fail.
 *  - The "still missing" test. Dropping it re-downloads every attachment on
 *    every export. **What counts as "missing" changed in BACKLOG-3389 — see
 *    the next section.**
 *
 * ## BACKLOG-3389: "missing" means NO BYTES, not NO ROW
 *
 * Until 2026-09-16 the test was a bare `NOT EXISTS (SELECT 1 FROM attachments a
 * WHERE a.email_id = e.id)` — "is there a ROW". Since BACKLOG-1870
 * (`bd3612476`, 2026-07-25) an ordinary email sync persists attachment METADATA
 * with `storage_path` NULL ({@link
 * import("./attachmentDbService").upsertEmailAttachmentMetadata}) so filenames
 * are searchable without downloading anything. Such a row satisfied the bare
 * `NOT EXISTS`, so the pre-download was SKIPPED — and the gather that follows
 * it (`submissionDbService.getTransactionAttachments`, email branch) then
 * discarded the row on `AND a.storage_path IS NOT NULL`, because an upload
 * needs bytes.
 *
 * The attachment was therefore dropped from the submission silently: nothing
 * was attempted, so nothing failed, and the run logged `attachmentsFailed: 0`.
 * Traced on a real submission — `[Submission] Downloading attachments for N
 * emails before export` never appeared in the main-process log.
 *
 * The test is now a disjunction, and BOTH arms are load-bearing:
 *
 *  - `NOT EXISTS (any row)` — nothing has ever been persisted for this email.
 *  - `EXISTS (row WHERE storage_path IS NULL)` — a row exists but holds no
 *    bytes. Written as a second EXISTS rather than by narrowing the first to
 *    `storage_path IS NOT NULL`, because narrowing gets the MIXED case wrong:
 *    an email with one stored attachment and one metadata-only attachment HAS
 *    a stored row, so the narrowed `NOT EXISTS` is false and the byte-less one
 *    would never download. That case is pinned in the test.
 *
 * Re-selecting an email whose attachments are already stored costs nothing:
 * `emailAttachmentService.downloadEmailAttachment` skips per attachment when
 * that attachment's own row already has `storage_path` (`:333`), so only the
 * byte-less ones are fetched.
 *
 * This statement carries NO audit window — pre-existing, and unchanged here. An
 * email linked to the transaction but outside `[started_at, closed_at]` is
 * downloaded and then correctly excluded by the gather's own window.
 *
 * ## `DISTINCT` is unreachable, and is kept anyway — deliberately
 *
 * An earlier draft of this docblock justified the `DISTINCT` by saying one
 * email can be linked to a transaction more than once through
 * `communications`. **That is false.** `electron/database/schema.sql:1172`
 * declares
 *
 *     CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_email_txn
 *       ON communications(email_id, transaction_id)
 *       WHERE email_id IS NOT NULL AND transaction_id IS NOT NULL;
 *
 * and both columns are non-null by construction on this join — the statement
 * binds `transaction_id` and joins `email_id` to `emails.id`. So the join
 * matches at most one `communications` row per email, and the `DISTINCT`
 * cannot change the result set.
 *
 * This was found by executing the real schema in the pin test rather than
 * trusting a fixture written from the statement: the first draft of that test
 * tried to insert the duplicate and the database refused it.
 *
 * The keyword is nonetheless retained, because the unreachability rests on an
 * INDEX, which a future migration can drop far more easily than this reasoning
 * can be reconstructed. So it is pinned instead: `submissionEmailSql.test.ts`,
 * "cannot hold the duplicate link its DISTINCT would deduplicate", fails if
 * that index ever goes away.
 *
 * **The statement is NO LONGER byte-identical to the one BACKLOG-2989 moved.**
 * An earlier revision of this docblock said it was, and cited the SQL boundary
 * gate's content hash `d7061f35bd88` as the proof. That claim was true of the
 * move and is false of the text below: BACKLOG-3389 changed the "still
 * missing" predicate, for the reason given above. The hash is deliberately not
 * restated here — a stale hash reads as a live control.
 */

/**
 * Emails linked to a transaction that advertise attachments and are missing the
 * BYTES of at least one of them. One bound parameter: the transaction id.
 *
 * BACKLOG-3389: "missing" is not "has no attachment row" — a metadata-only row
 * (`storage_path` NULL) is exactly the shape a normal sync writes, and it has
 * no bytes to upload. See the module docblock.
 *
 * Columns are the four the caller needs to re-fetch from the provider:
 * `id`, `external_id`, `source`, `user_id`.
 */
export const TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL = `
        SELECT DISTINCT e.id, e.external_id, e.source, e.user_id
        FROM emails e
        INNER JOIN communications c ON c.email_id = e.id
        WHERE c.transaction_id = ?
          AND e.has_attachments = 1
          AND e.external_id IS NOT NULL
          AND e.source IS NOT NULL
          AND (
            NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
            OR EXISTS (
              SELECT 1 FROM attachments a
              WHERE a.email_id = e.id AND a.storage_path IS NULL
            )
          )
      `;
