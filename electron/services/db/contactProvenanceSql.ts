/**
 * SQL for contact provenance — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactProvenance.ts` (2 sites). Provenance answers
 * "where did this contact's information come from", which is the audit question behind
 * the app's whole reason to exist.
 *
 * ## `ec.id IS NOT NULL AS present` — reporting absence rather than hiding it
 *
 * The LEFT JOIN plus that projected boolean is the load-bearing part. A source link
 * whose external record has since vanished from the address book still appears, marked
 * `present = 0`, instead of dropping out of the result. An audit trail that silently
 * omits a source it once used is worse than one that says "this came from a record I
 * can no longer see" — the first looks complete and is not.
 *
 * That is the same choice `contactCompareSql.ts` makes and the opposite of
 * `contactLinkReviewSql.ts`, and the three are consistent once you read what each is
 * for: evidence and audit must not hide, a decision queue must not offer the
 * unanswerable.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";

/**
 * Every source link for a contact except one match method, with whether the source
 * record still exists. Three bound parameters: user id, contact id, the method to
 * exclude.
 *
 * `ec.synced_at` comes from the external row when it is still there, so the caller can
 * say how fresh the provenance is rather than only where it came from.
 */
export const CONTACT_PROVENANCE_SQL = sql`SELECT l.id, l.source_type, l.source_record_id, l.match_method, l.matched_at,
            ec.name AS source_name, ec.synced_at, ec.id IS NOT NULL AS present
       FROM contact_source_links l
       LEFT JOIN external_contacts ec
         ON ec.user_id = l.user_id
        AND ec.source = l.source_type
        AND ec.external_record_id = l.source_record_id
      WHERE l.user_id = ? AND l.contact_id = ?
        AND l.match_method <> ?
      ORDER BY l.source_type, l.source_record_id`;

/** One source link by its own id. One bound parameter. */
export const CONTACT_SOURCE_LINK_BY_ID_SQL = sql`SELECT id, user_id, contact_id, source_type, source_record_id, match_method
       FROM contact_source_links WHERE id = ?`;
