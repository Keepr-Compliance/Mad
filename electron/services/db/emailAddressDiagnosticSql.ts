/**
 * SQL for the `diagnostic:check-email-data` IPC handler — BACKLOG-2989 PR 2.
 *
 * Moved out of `electron/handlers/diagnosticHandlers.ts`; the rule and its CI
 * gate are BACKLOG-2959. All three statements are static text, so the handler
 * keeps its `.prepare()` calls and only the text moved.
 *
 * ## What this answers
 *
 * "I added this person and nothing showed up." The three statements separate
 * three different causes that look identical from the UI:
 *
 *   1. the address is not on any contact       -> `CONTACT_EMAILS_BY_ADDRESS_SQL` empty
 *   2. the address is on a contact but no mail
 *      was ever ingested for it                -> `EMAILS_BY_PARTICIPANT_SQL` empty
 *   3. mail exists but none of it is linked
 *      to a transaction                        -> rows present, `transaction_id` null
 *
 * `USER_EMAIL_COUNT_SQL` is the denominator that tells apart "no mail for THIS
 * address" from "no mail at all", which is a different ticket entirely.
 */

/**
 * Contact-email junction rows for one address, with the contact's display name.
 *
 * `LOWER()` on both sides because addresses are stored as the provider supplied
 * them — case-preserved — while the local part is compared case-insensitively
 * in practice. Comparing raw would report "not found" for an address that is
 * present under different capitalisation, which is the exact confusion this
 * diagnostic exists to end.
 */
export const CONTACT_EMAILS_BY_ADDRESS_SQL = `
        SELECT ce.*, c.display_name
        FROM contact_emails ce
        JOIN contacts c ON ce.contact_id = c.id
        WHERE c.user_id = ? AND LOWER(ce.email) = LOWER(?)
      `;

/**
 * The 20 most recent emails involving an address, with the transaction each is
 * linked to (or NULL).
 *
 * BACKLOG-506 / BACKLOG-1722: this reads the `email_participants` junction for
 * an indexed exact match. The scan it replaced was an unindexed `LIKE` over the
 * emails table that ALSO missed BCC-only matches — so an address that appeared
 * solely as a BCC recipient reported as "never seen", which for a diagnostic
 * answering "where is this address mentioned" is the worst possible wrong
 * answer.
 *
 * `LEFT JOIN communications`, not an inner join: an email with no transaction
 * link must still appear, because case 3 above is precisely the case where the
 * link is what is missing.
 */
export const EMAILS_BY_PARTICIPANT_SQL = `
        SELECT DISTINCT e.id, e.sender, e.recipients, e.subject, e.sent_at,
               c.transaction_id
        FROM email_participants ep
        JOIN emails e ON e.id = ep.email_id
        LEFT JOIN communications c ON c.email_id = e.id
        WHERE e.user_id = ?
          AND ep.email_address = ?
        ORDER BY e.sent_at DESC
        LIMIT 20
      `;

/** Total emails stored for a user — the denominator for the two queries above. */
export const USER_EMAIL_COUNT_SQL = `
        SELECT COUNT(*) as count FROM emails
        WHERE user_id = ?
      `;
