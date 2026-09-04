/**
 * SQL for the contact link review queue — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactLinkReview.ts` (2 sites), **together with the
 * `PENDING_JOIN` fragment both of them splice**. The fragment had to move too, for the
 * same reason as `onTransactionFor`: a statement inside the layer that interpolates
 * text authored in a service is only half moved.
 *
 * ## The count and the contents MUST come from one predicate
 *
 * Carried from the base, because it is the whole reason `PENDING_JOIN` is a shared
 * fragment rather than two similar clauses: *"the count on the button and the contents
 * of the modal MUST come from the same predicate. 'Review 12 possible duplicates'
 * opening onto 9 is the kind of small lie that costs a feature its credibility."*
 *
 * `COUNT_REVIEW_QUEUE_SQL` and `REVIEW_QUEUE_SQL` below splice the identical fragment,
 * so the two cannot drift apart. Keeping them in one file, next to each other, is what
 * makes that visible to the next reader.
 *
 * ## What the join excludes, and why it is an inner join
 *
 * Both `JOIN`s are inner on purpose. A proposal is only answerable while BOTH sides
 * still exist: `contacts` must be present and not tombstoned (`c.removed_at IS NULL`),
 * and the `external_contacts` row must still be there. A proposal whose source record
 * has vanished from the address book is a question with no answer, and a queue that
 * shows unanswerable questions is one the user stops opening. The rows are left in the
 * table rather than deleted — if the record comes back, so does the question, and the
 * pair's answer history is untouched either way.
 *
 * Contrast `contactCompareSql.ts`, which LEFT JOINs the same table on purpose. That is
 * not an inconsistency: the compare screen is gathering EVIDENCE and must not hide a
 * link whose source vanished, while this queue is offering a DECISION and must not
 * offer one that cannot be made.
 *
 * Text is byte-identical to what it replaced; the fragment's own text is pinned by
 * `__tests__/contactFragments.movedText.test.ts`.
 */

import { sql } from "./core/sqlText";

/**
 * The pending-proposal join and its predicate. One bound parameter: the user id.
 *
 * Not exported, and no test-only export exists to reach it either: `COUNT_REVIEW_QUEUE_SQL`
 * below is `SELECT COUNT(*) AS n ` plus this fragment verbatim, so
 * `__tests__/contactFragments.movedText.test.ts` pins the fragment's exact text through
 * that constant. Widening a module's surface to let a test see a private is a cost the
 * test does not need to impose.
 *
 * A third caller wanting "the pending queue, but…" should add a statement here beside
 * these two rather than re-join the tables itself.
 */
const PENDING_JOIN = sql`
    FROM contact_link_proposals p
    JOIN contacts c
      ON c.id = p.contact_id AND c.removed_at IS NULL
    JOIN external_contacts ec
      ON ec.user_id = p.user_id
     AND ec.source = p.source_type
     AND ec.external_record_id = p.source_record_id
   WHERE p.user_id = ? AND p.status = 'pending'
`;

/** How many proposals are waiting — the number on the button. One bound parameter. */
export const COUNT_REVIEW_QUEUE_SQL = sql`SELECT COUNT(*) AS n ${PENDING_JOIN}`;

/**
 * The proposals themselves — what the modal shows. One bound parameter: the user id.
 *
 * Ordered by `cluster_key` first so proposals about the same person arrive together,
 * then by `created_at` and `id` so the order is total and the list does not reshuffle
 * between openings.
 */
export const REVIEW_QUEUE_SQL = sql`SELECT p.id, p.user_id, p.contact_id, p.source_type, p.source_record_id, p.status,
            p.reason, p.matched_on, p.identity_assessment, p.relationship_assessment,
            p.cluster_key, p.evidence_json, p.created_at, p.resolved_at,
            ec.name AS source_name, ec.company AS source_company,
            ec.emails_json AS source_emails_json,
            ec.phones_json AS source_phones_json,
            c.display_name AS contact_name, c.company AS contact_company
       ${PENDING_JOIN}
      ORDER BY p.cluster_key, p.created_at, p.id`;
