/**
 * Shared SQL fragment: per-imported-contact `last_communication_at`.
 *
 * BACKLOG-2354. The Clients & Contacts screen loads via the get-all path
 * (`contacts:get-all` -> `getImportedContactsByUserIdAsync` ->
 * `getImportedContactsByUserId` / the worker's `runImportedQuery`), which
 * previously computed NO recency timestamp. With the picker's default "Recent"
 * sort that left every contact tied on an empty timestamp, so the list
 * degenerated to the invisible email tiebreaker (alphabetical-by-email, with
 * never-contacted people on top).
 *
 * This computes a populated `last_communication_at` per imported contact,
 * SET-BASED (correlated scalar subqueries scoped to the contact's own few
 * emails/phones — NOT an N+1 JS loop; safe on 1000+ contacts). It takes the
 * most-recent across four channels, reusing the patterns already in
 * contactDbService:
 *   1. text/SMS/iMessage via `phone_last_message` (mirrors
 *      `getUnimportedContactsByUserId`'s indexed subquery),
 *   2. email via `email_participants` -> `emails` (indexed on email_address),
 *   3/4. the denormalized `last_inbound_at` / `last_outbound_at` columns
 *      (the `getContactsSortedByActivity` pattern).
 *
 * Combine strategy: each channel is COALESCE'd to '' (empty string sorts before
 * any ISO-8601 datetime, so it is ignored), the scalar `MAX(...)` picks the
 * greatest, and `NULLIF(..., '')` maps "no activity on any channel" back to
 * NULL. Datetimes are stored as ISO TEXT, so lexicographic order = chronological
 * order. The final cross-contact recency sort is still done on the renderer
 * (`buildVisibleContacts`) via `new Date().getTime()`; this fragment only needs
 * to surface each contact's own newest timestamp.
 *
 * It references the outer query's `c` (the `contacts` row aliased `c`), so the
 * consuming SELECT MUST alias the contacts table as `c`.
 *
 * This is a pure string constant with NO imports so it can be shared by the
 * Electron main process (contactDbService) AND the query worker thread
 * (contactQueryWorker) without either copy drifting.
 */
export const IMPORTED_CONTACT_LAST_COMMUNICATION_SQL = `
      NULLIF(
        MAX(
          COALESCE((
            SELECT MAX(plm.last_message_at)
            FROM contact_phones cp_lc
            JOIN phone_last_message plm
              ON plm.user_id = c.user_id
             AND plm.phone_normalized = cp_lc.phone_normalized
            WHERE cp_lc.contact_id = c.id
              AND cp_lc.phone_normalized IS NOT NULL
          ), ''),
          COALESCE((
            SELECT MAX(COALESCE(em.sent_at, em.received_at))
            FROM contact_emails ce_lc
            JOIN email_participants ep_lc
              ON LOWER(ep_lc.email_address) = LOWER(ce_lc.email)
            JOIN emails em
              ON em.id = ep_lc.email_id
             AND em.user_id = c.user_id
            WHERE ce_lc.contact_id = c.id
          ), ''),
          COALESCE(c.last_inbound_at, ''),
          COALESCE(c.last_outbound_at, '')
        ),
        ''
      ) as last_communication_at
`;
