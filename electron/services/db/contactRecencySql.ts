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

/**
 * BACKLOG-2355 — external (address-book) contact recency, CONSOLIDATED with the
 * imported computation above.
 *
 * ## Why this exists
 * The select-jump the founder hit ("the date is the same date, so it should be
 * in the same place") was caused by the two paths computing recency
 * DIFFERENTLY: external contacts pre-computed `last_message_at` from
 * phone_last_message ONLY (so an email-only contact like hd@berkeley.edu read
 * NULL and sorted to the bottom), while the imported path (above) already used
 * phone + email. On import the value flipped null -> real and the row climbed.
 *
 * This fragment gives external contacts the SAME phone + email recency, using
 * the SAME underlying source tables (`phone_last_message`, `email_participants`
 * -> `emails`) and the SAME combine strategy (COALESCE each channel to '' so a
 * missing channel is ignored, scalar `MAX(...)` picks the greatest — scalar max
 * returns NULL if ANY arg is NULL, hence the COALESCE — then `NULLIF(..., '')`
 * maps "no activity" back to NULL). Datetimes are ISO TEXT so lexicographic =
 * chronological.
 *
 * ## Anti-jump invariant
 * For a given person, this expression yields the SAME timestamp as
 * IMPORTED_CONTACT_LAST_COMMUNICATION_SQL's channels 1 (phone) and 2 (email).
 * The imported fragment ALSO folds in the denormalized `c.last_inbound_at` /
 * `c.last_outbound_at` columns, which do not exist on `external_contacts` and
 * are NULL on a freshly-imported contact (they are backfilled later by message
 * sync). So at the moment of import external == imported and the row does not
 * move — killing the jump at the root.
 *
 * ## Why the storage shapes differ (and the string can't be byte-identical)
 * Imported contacts join the `contact_phones` / `contact_emails` junction tables
 * (keyed by `contact_id`); external contacts have no `contacts` row — their
 * phones/emails are JSON arrays on the `external_contacts` row itself. So this
 * fragment expands them with `json_each(...)` instead. The recency SOURCE and
 * math are identical; only the identity-lookup shape differs.
 *
 * ## Correlation contract
 * This is a bare SQL expression (no alias). It references the `external_contacts`
 * table by name, so the consuming statement MUST select from / update
 * `external_contacts` (unaliased). `emails_json` / `phones_normalized_json` are
 * COALESCE'd to '[]' so `json_each` never receives NULL. SET-BASED: two indexed
 * correlated subqueries per row (phone_last_message PK; email_participants
 * indexed on email_address) — no N+1 JS loop; safe on 1000+ contacts.
 */
export const EXTERNAL_CONTACT_LAST_MESSAGE_EXPR = `
      NULLIF(
        MAX(
          COALESCE((
            SELECT MAX(plm.last_message_at)
            FROM phone_last_message plm,
                 json_each(COALESCE(external_contacts.phones_normalized_json, '[]')) AS p_lc
            WHERE plm.user_id = external_contacts.user_id
              AND plm.phone_normalized = p_lc.value
          ), ''),
          COALESCE((
            SELECT MAX(COALESCE(em.sent_at, em.received_at))
            FROM json_each(COALESCE(external_contacts.emails_json, '[]')) AS e_lc
            JOIN email_participants ep_lc
              ON LOWER(ep_lc.email_address) = LOWER(e_lc.value)
            JOIN emails em
              ON em.id = ep_lc.email_id
             AND em.user_id = external_contacts.user_id
          ), '')
        ),
        ''
      )
`;

/**
 * BACKLOG-2355 — the canonical "load all external contacts" query, shared
 * verbatim by the worker (`contactQueryWorker.runExternalQuery`) and the sync
 * fallback (`externalContactDbService.getAllForUser`) so the two copies can
 * never drift. Recency is computed INLINE via EXTERNAL_CONTACT_LAST_MESSAGE_EXPR
 * (always fresh at load, independent of the last sync) and aliased back to
 * `last_message_at` — the column the renderer maps to `last_communication_at`.
 *
 * The computed value is produced in an inner SELECT and the ORDER BY runs in the
 * OUTER query, so `last_message_at` there resolves to a genuine result column
 * (NOT an alias-in-the-same-SELECT, which SQLite only substitutes for a *bare*
 * ORDER BY term and would otherwise silently fall back to the stored column
 * inside the `last_message_at IS NULL` expression). One `?` bind: userId.
 */
export const EXTERNAL_CONTACTS_GET_ALL_SQL = `
  SELECT * FROM (
    SELECT id, user_id, name, phones_json, emails_json, company,
           ${EXTERNAL_CONTACT_LAST_MESSAGE_EXPR} as last_message_at,
           external_record_id, source, synced_at,
           -- BACKLOG-2401: carried so an import can record ZEXTERNALUUID on the
           -- crosswalk row at the one moment the answer is certain. Never matched on.
           external_uuid
    FROM external_contacts
    WHERE user_id = ?
  )
  ORDER BY last_message_at IS NULL, last_message_at DESC, name ASC
`;

/**
 * BACKLOG-2355 — batch recompute of the stored `last_message_at` column, now
 * phone + email (was phone-only). Kept as a defensive/precomputed value for any
 * reader that does not go through EXTERNAL_CONTACTS_GET_ALL_SQL; the load path
 * itself no longer depends on it being fresh. One `?` bind: userId. The old
 * `phones_normalized_json IS NOT NULL` guard is dropped so email-only contacts
 * are also updated (json_each COALESCEs NULL arrays to '[]').
 */
export const EXTERNAL_CONTACT_RECENCY_UPDATE_SQL = `
    UPDATE external_contacts
    SET last_message_at = ${EXTERNAL_CONTACT_LAST_MESSAGE_EXPR}
    WHERE user_id = ?
`;
