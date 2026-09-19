/**
 * SQL for the email-attachment backfill — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/services/emailAttachmentBackfillService.ts`. The rule
 * and its CI gate are BACKLOG-2959.
 *
 * ## The fragment moved WITH its two statements, and that is what makes the
 * ## content hashes still match
 *
 * The two statements share a `MISSING_WHERE` fragment and compose it with a
 * template literal. Composing at the CALL SITE is a violation — the gate reads
 * the assembled template as text authored outside the layer, and importing the
 * fragment from `db/` would not have helped (that is exactly the shape that
 * keeps `contactQueryWorker.ts` non-compliant). Composing INSIDE this module
 * makes each call site a bare identifier, which is the one shape the gate
 * greens.
 *
 * Because the fragment kept its name, the exported constants' source text is
 * character-for-character what the call sites held, so both still hash to the
 * values the gate recorded (`59ec41dd73eb`, `1bad3000d7b2`).
 *
 * **A limit of that control, stated rather than glossed:** the hash covers the
 * template SHELL — `SELECT COUNT(*) AS n ${MISSING_WHERE}` — not the fragment's
 * contents. Two statements could hash identically while `MISSING_WHERE` said
 * something different. The fragment is separately verified byte-identical
 * against the pre-move blob, and the pin tests execute the composed result.
 */

/**
 * Emails that advertise attachments but have no attachment rows — "the search
 * gap", the set the backfill exists to drain. One bound parameter: the user id.
 *
 * `external_id IS NOT NULL AND source IS NOT NULL` are not redundant checks:
 * without both, the row cannot be re-fetched from any provider, so selecting it
 * would queue a download that can only fail.
 */
const MISSING_WHERE = `
      FROM emails e
      WHERE e.user_id = ?
        AND e.has_attachments = 1
        AND e.external_id IS NOT NULL
        AND e.source IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
    `;

/** Size of the backlog. One bound parameter: the user id. */
export const COUNT_EMAILS_MISSING_ATTACHMENTS_SQL = `SELECT COUNT(*) AS n ${MISSING_WHERE}`;

/**
 * One page of the backlog, newest first. Two bound parameters: the user id and
 * the page size.
 *
 * `ORDER BY e.received_at DESC` means a bounded run drains the most recent mail
 * first — the mail a user is most likely to be looking for while the backfill
 * is still catching up.
 */
export const SELECT_EMAILS_MISSING_ATTACHMENTS_SQL = `SELECT e.id, e.external_id, e.source ${MISSING_WHERE}
         ORDER BY e.received_at DESC
         LIMIT ?`;
