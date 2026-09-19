/**
 * SQL for name-based auto-linking — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactNameAutoLink.ts` (2 sites). Both are the
 * full-corpus reads the name matcher scans: every named external record on one side,
 * every named live contact on the other.
 *
 * ## Both are deliberately unfiltered beyond "has a name", and both are ORDERed
 *
 * The matcher compares the two sets in memory, so pre-filtering here would decide the
 * match before the matcher sees it. What the statements DO enforce is that a row
 * without a name is not a candidate at all — `name IS NOT NULL` and
 * `display_name IS NOT NULL` — because a null-named row cannot match by name and
 * would only widen the scan.
 *
 * The `ORDER BY` clauses are not cosmetic. Name matching is the weakest signal this
 * app links on, and the founder's ruling is that it is gated; when it does run, the
 * pairs it proposes must be reproducible run to run, or the review queue reshuffles
 * under the user between openings. A total order on both inputs is what makes the
 * output deterministic.
 *
 * Note the asymmetry in tombstone handling: contacts are filtered by
 * `removed_at IS NULL` (a removed contact is not a link target), while external records
 * are not — an external record has no tombstone column, its absence IS its removal.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";

/**
 * Every named external record for a user. One bound parameter: the user id.
 *
 * `external_record_id IS NOT NULL` excludes rows with no crosswalk key — there is
 * nothing stable to link TO — and the order is total on `(source, external_record_id)`.
 */
export const NAMED_EXTERNAL_RECORDS_SQL = sql`SELECT external_record_id, source, name FROM external_contacts
      WHERE user_id = ? AND external_record_id IS NOT NULL AND name IS NOT NULL
      ORDER BY source, external_record_id`;

/**
 * Every named live contact for a user. One bound parameter: the user id.
 *
 * `removed_at IS NULL` is spelled out here rather than spliced from
 * `ACTIVE_CONTACTS_CLAUSE_UNALIASED`, and that is a byte-identity constraint rather
 * than a preference: the shared fragment begins with a leading ` AND `, so splicing it
 * into this statement's existing `WHERE user_id = ?` would produce different text from
 * what this statement has always sent. Changing the text is what this move must not
 * do. Re-expressing it against the shared clause is a legitimate follow-up, but it is a
 * statement change and belongs in a PR that says so.
 */
export const NAMED_LIVE_CONTACTS_SQL = sql`SELECT id, display_name FROM contacts
      WHERE user_id = ? AND removed_at IS NULL AND display_name IS NOT NULL
      ORDER BY id`;
