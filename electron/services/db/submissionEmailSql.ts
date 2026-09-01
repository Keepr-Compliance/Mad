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
 *  - `NOT EXISTS (SELECT 1 FROM attachments …)` — the "still missing" test.
 *    Dropping it re-downloads every attachment on every export.
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
 * The keyword is nonetheless retained BYTE-IDENTICALLY, for two reasons.
 * BACKLOG-2989 is a mechanical text move — editing a statement inside a move is
 * how a refactor smuggles a behaviour change past review — and the statement's
 * content hash is the control proving the move altered nothing. And the
 * unreachability rests on an INDEX, which a future migration can drop far more
 * easily than this reasoning can be reconstructed. So it is pinned instead:
 * `submissionEmailSql.test.ts`, "cannot hold the duplicate link its DISTINCT
 * would deduplicate", fails if that index ever goes away.
 *
 * The text is byte-identical to the statement this replaced; the move was
 * verified by comparing the SQL boundary gate's own content hash
 * (`d7061f35bd88`) before and after.
 */

/**
 * Emails linked to a transaction that advertise attachments but have none
 * stored. One bound parameter: the transaction id.
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
          AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
      `;
