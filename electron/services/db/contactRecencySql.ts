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
 * emails/phones — NOT an N+1 JS loop). It takes the
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
 *
 * ## BACKLOG-2633 — this fragment has the same defect, and needs the same index
 * "Scoped to the contact's own few emails/phones" is a statement about what the
 * subquery MEANS, not about what SQLite executes. `LOWER(ep_lc.email_address)`
 * makes `idx_email_participants_email_address` unusable, so with no by-address
 * path the planner drives the email half from `emails` — the whole mailbox, once
 * per contact. Measured at 1,162 contacts / 3,073 emails, no
 * `idx_email_participants_lower_address`, plain `JOIN`s: **3,859 ms**, driving
 * from `emails`. With the index: 5.1 ms. It is cheap in the founder's database
 * today ONLY because he has 4 imported contacts, and would have surfaced the
 * moment an address book was imported.
 *
 * The index that fixes it is the one the external fragment needs —
 * `idx_email_participants_lower_address`, in schema.sql — because both probe
 * `email_participants` under `LOWER(email_address)`.
 *
 * ## Honest note: GIVEN the index, the CROSS JOINs below change nothing here
 * Unlike the external fragment — where the index alone is worth 1.0x and the
 * pin is the whole fix — the index alone closes this one, and the plan is
 * identical with or without the pin. The two differ in what sits leftmost:
 * `json_each` is a virtual table with no cost estimate and is always ranked
 * LAST, whereas `contact_emails` constrained by `contact_id = c.id` is served by
 * a UNIQUE covering index the planner already treats as a cheap entry point.
 *
 * The pins are kept for defence in depth — the external half is the standing
 * proof that "the index will save us" is not a general truth. But BE PRECISE
 * ABOUT WHICH OF THEM A TEST CAN CATCH, because the answer differs per join and
 * an over-broad claim here is worse than no claim: it teaches the next engineer
 * to distrust a suite that is working correctly.
 *
 *   EMAIL half (`ce_lc` -> `ep_lc` -> `em`) — FALSIFIABLE.
 *     `contactRecencySql.queryPlan.test.ts` removes
 *     `idx_email_participants_lower_address` and asserts the plan still refuses
 *     to fall back to the mailbox (CROSS: 1,450 ms from contact_emails; plain
 *     JOIN: 3,859 ms from emails). Revert those two `CROSS JOIN`s and that test,
 *     and only that test, goes red. Confirmed by running exactly that.
 *
 *   PHONE half (`cp_lc` -> `plm`) — NOT FALSIFIABLE. THE SUITE CANNOT SEE IT.
 *     Reverting this one `CROSS JOIN` to a plain `JOIN` leaves every test green,
 *     and that is correct rather than a weak test: `contact_phones` constrained
 *     by `contact_id = c.id` resolves through an index regardless of join order,
 *     so the plan and the timing are IDENTICAL either way. Measured at 1,162
 *     contacts against a 5,000-row phone cache, all EIGHT combinations of
 *     {idx_contact_phones_contact_id present / dropped} x {ANALYZE on / off} x
 *     {JOIN / CROSS JOIN}: always `SEARCH cp_lc USING INDEX ... (contact_id=?)`,
 *     always 1.1-1.3 ms. Dropping the named index does not change it either —
 *     the UNIQUE(contact_id, phone_e164) autoindex serves it.
 *     This pin is therefore DEFENSIVE ONLY, kept for consistency with its
 *     neighbours. If you revert it and see green, the suite is not failing you;
 *     there is genuinely nothing there to catch.
 */
export const IMPORTED_CONTACT_LAST_COMMUNICATION_SQL = `
      NULLIF(
        MAX(
          COALESCE((
            SELECT MAX(plm.last_message_at)
            FROM contact_phones cp_lc
            CROSS JOIN phone_last_message plm
              ON plm.user_id = c.user_id
             AND plm.phone_normalized = cp_lc.phone_normalized
            WHERE cp_lc.contact_id = c.id
              AND cp_lc.phone_normalized IS NOT NULL
          ), ''),
          COALESCE((
            SELECT MAX(COALESCE(em.sent_at, em.received_at))
            FROM contact_emails ce_lc
            CROSS JOIN email_participants ep_lc
              ON LOWER(ep_lc.email_address) = LOWER(ce_lc.email)
            CROSS JOIN emails em
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
 * COALESCE'd to '[]' so `json_each` never receives NULL.
 *
 * ## BACKLOG-2633 — WHY BOTH SUBQUERIES START AT `json_each` AND SAY `CROSS JOIN`
 *
 * This docblock used to claim "two indexed correlated subqueries per row
 * (phone_last_message PK; email_participants indexed on email_address) — no N+1
 * JS loop; safe on 1000+ contacts". Every clause of that was true about the
 * INTENT and false about the EXECUTION, and the gap cost the founder 7.4 seconds
 * on every contacts-picker load.
 *
 * `EXPLAIN QUERY PLAN` on the shipped expression, on a database with no
 * `sqlite_stat1` (the normal state — `ANALYZE` runs only from
 * maintenanceDbService, never at startup):
 *
 *     CORRELATED SCALAR SUBQUERY 1
 *       SEARCH plm USING INDEX idx_phone_last_msg_user (user_id=?)   <- ALL his phone rows
 *       SEARCH p_lc VIRTUAL TABLE INDEX 1:
 *     CORRELATED SCALAR SUBQUERY 2
 *       SEARCH em USING INDEX idx_emails_user_sent (user_id=?)       <- his WHOLE MAILBOX
 *       SEARCH ep_lc USING INDEX idx_email_participants_email_id (email_id=?)
 *       SEARCH e_lc VIRTUAL TABLE INDEX 1:
 *
 * Both halves drive from the big table and probe the contact's own handful of
 * values LAST, so the real cost is `external_contacts x mailbox`, linear in
 * mailbox size — not the per-contact constant the comment promised. `json_each`
 * is a virtual table with no useful cost estimate, which is why the planner
 * ranks it last and puts it at the bottom of the loop nest.
 *
 * THE FIX IS TWO THINGS AND NEITHER WORKS ALONE. Measured at the founder's own
 * record count (1,162 external_contacts / 3,073 emails / 9,219 participants /
 * 762 phone_last_message), no ANALYZE:
 *
 *     as shipped                                     7,410 ms
 *     + idx_email_participants_lower_address ONLY    7,457 ms   (1.0x — nothing)
 *     + CROSS JOIN ONLY (no index to probe)          3,792 ms   (2.0x)
 *     + both, email half only                          247 ms   (30x)
 *     + both, BOTH halves pinned                        12 ms   (602x)
 *
 * The index alone changes nothing because the planner keeps the mailbox-first
 * order and never opens a by-address path. The order alone helps only until it
 * has nothing to probe with. `CROSS JOIN` in SQLite means exactly "do not
 * reorder these" — it is not a cartesian product and the row set is identical;
 * the ON clauses still constrain it. So the leftmost table is now the contact's
 * own values, which is what the docblock always said this did.
 *
 * The 247 ms line is why the PHONE half is pinned too. `phone_last_message` is a
 * precomputed cache (762 rows for the founder, written at ingest by
 * messageDbService), so it is far smaller than the mailbox — but 762 x 1,162 is
 * still 885k probes, and it is the term that remains once the email half is
 * fixed. The `messages` table (164k rows) is NOT on this path and appears in no
 * plan: the cache is what stands in for it.
 *
 * The index is declared in schema.sql beside the other `email_participants`
 * indexes, with no migration behind it — see the comment there for why that
 * reaches existing installs, and the guard test that proves it.
 *
 * IF YOU EDIT THESE SUBQUERIES: keep `json_each` leftmost and keep every JOIN a
 * CROSS JOIN. A plain `JOIN` here reads identically and silently restores a
 * whole-mailbox scan per contact. The plan is asserted, in both stats regimes,
 * by contactRecencySql.queryPlan.test.ts.
 */
export const EXTERNAL_CONTACT_LAST_MESSAGE_EXPR = `
      NULLIF(
        MAX(
          COALESCE((
            SELECT MAX(plm.last_message_at)
            FROM json_each(COALESCE(external_contacts.phones_normalized_json, '[]')) AS p_lc
            CROSS JOIN phone_last_message plm
              ON plm.phone_normalized = p_lc.value
             AND plm.user_id = external_contacts.user_id
          ), ''),
          COALESCE((
            SELECT MAX(COALESCE(em.sent_at, em.received_at))
            FROM json_each(COALESCE(external_contacts.emails_json, '[]')) AS e_lc
            CROSS JOIN email_participants ep_lc
              ON LOWER(ep_lc.email_address) = LOWER(e_lc.value)
            CROSS JOIN emails em
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
