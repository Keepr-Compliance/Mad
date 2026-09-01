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
 *  - `DISTINCT` — one email can be linked to a transaction more than once
 *    through `communications`, and fetching it twice is wasted network.
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
