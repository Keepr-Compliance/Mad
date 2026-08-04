/**
 * Shared SQL for resolving a saved contact to its external source records
 * (BACKLOG-2401).
 *
 * Lives in its own module because there are TWO backfill implementations that
 * must not drift apart: the main-thread path in
 * `electron/handlers/contactHandlers.ts` and its twin in
 * `electron/workers/contactQueryWorker.ts`, which wins whenever the worker pool
 * is warm. The worker holds its own `better-sqlite3` handle and cannot import
 * the db service, so the one thing they can genuinely share is the SQL text.
 * Changing the rule in only one of them is how a fix becomes invisible in the
 * field, so it is expressed exactly once, here.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION ORDER — mirrors contactSourceLinker.ts, and never uses NAME
 * ---------------------------------------------------------------------------
 *   pri 1  source_id  — the crosswalk claims this record. Immune to a rename,
 *                       and immune to an identifier moving between people.
 *   pri 2  email      — content fallback for a contact with no crosswalk row.
 *   pri 3  phone      — weakest, last.
 *
 * Display name is ABSENT on purpose. `... WHERE name = ?` against
 * `contacts.display_name` was the entire previous mechanism and the defect this
 * work removes: rename yourself in Contacts.app and your saved record orphaned.
 *
 * ---------------------------------------------------------------------------
 * ALL MATCHES ARE RETURNED, IN AN EXPLICIT ORDER — not one arbitrary row
 * ---------------------------------------------------------------------------
 * A contact can legitimately map to several source records at once (the same
 * person in macOS, Outlook and an iPhone). Backfill is ADDITIVE — it inserts
 * missing emails/phones and dedupes — so reading every linked record is both
 * more complete and immune to the "which source wins?" question for everything
 * except which value is written first.
 *
 * Where order is still observable it is DECLARED rather than left to whichever
 * row the query planner happened to emit last (catalogue C12):
 *
 *   `source_rank`: macos(1) < iphone(2) < outlook(3) < google_contacts(4) <
 *                  android_sync(5)
 *
 * Rationale, recorded so it can be argued with rather than rediscovered: the
 * two address books the user curates by hand on their own devices (macos,
 * iphone) outrank the two server directories (outlook, google_contacts), which
 * in turn outrank the companion-derived feed (android_sync) — the most derived
 * and the least directly edited by the person whose contacts these are.
 *
 * Final tiebreak is `external_record_id`, so the order is TOTAL and the same on
 * every machine and every run.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FALLBACK GATE SAYS `match_method <> 'origin'` (BACKLOG-2473)
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE SIMPLIFYING THE GATE BACK TO A BARE `NOT EXISTS`.
 *
 * Priorities 2 and 3 are a fallback for a contact the crosswalk does not claim,
 * so they switch on when the contact has no crosswalk row. v61 gives EVERY
 * contact an origin row — the row that records where it came from (typed by
 * hand, inferred from a thread) so provenance has one source of truth.
 *
 * An origin row is not a claim about an external record; it points at a
 * synthetic `source_record_id` that JOINs nothing. If it counted here, the bare
 * gate would be false for every contact in the database and BOTH content
 * fallbacks would be dead code — every contact whose addresses are resolved by
 * email/phone matching against `external_contacts` would silently stop resolving.
 * No error, no failing row count; the addresses simply stop arriving.
 *
 * The gate therefore counts only RECORD-BACKED links. Spelled as a literal
 * rather than an interpolated constant because this string is also read verbatim
 * by `contactQueryWorker`, which holds its own driver handle.
 */

/**
 * Params: @userId = user_id, @contactId = contact_id.
 * Columns: emails_json, phones_json, matched_by, pri, source_rank, external_record_id.
 *
 * `COALESCE(..., '[]')` guards `json_each` against a NULL json column, which is
 * an error rather than an empty set.
 */
export const CONTACT_SOURCE_RECORDS_SQL = `
  SELECT emails_json, phones_json, matched_by, pri, source_rank, external_record_id FROM (
    SELECT
      ec.emails_json                AS emails_json,
      ec.phones_json                AS phones_json,
      'source_id'                   AS matched_by,
      1                             AS pri,
      CASE ec.source
        WHEN 'macos' THEN 1 WHEN 'iphone' THEN 2 WHEN 'outlook' THEN 3
        WHEN 'google_contacts' THEN 4 WHEN 'android_sync' THEN 5 ELSE 6
      END                           AS source_rank,
      ec.external_record_id         AS external_record_id
    FROM contact_source_links csl
    JOIN external_contacts ec
      ON ec.user_id = csl.user_id
     AND ec.source = csl.source_type
     AND ec.external_record_id = csl.source_record_id
    WHERE csl.user_id = @userId AND csl.contact_id = @contactId

    UNION ALL

    SELECT
      ec.emails_json, ec.phones_json, 'email', 2,
      CASE ec.source
        WHEN 'macos' THEN 1 WHEN 'iphone' THEN 2 WHEN 'outlook' THEN 3
        WHEN 'google_contacts' THEN 4 WHEN 'android_sync' THEN 5 ELSE 6
      END,
      ec.external_record_id
    FROM external_contacts ec
    WHERE ec.user_id = @userId
      AND NOT EXISTS (
            SELECT 1 FROM contact_source_links x
             WHERE x.contact_id = @contactId
               AND x.match_method <> 'origin'
          )
      AND EXISTS (
        SELECT 1 FROM contact_emails ce, json_each(COALESCE(ec.emails_json, '[]')) j
         WHERE ce.contact_id = @contactId
           AND LOWER(TRIM(ce.email)) = LOWER(TRIM(j.value))
           AND TRIM(j.value) <> ''
      )

    UNION ALL

    SELECT
      ec.emails_json, ec.phones_json, 'phone', 3,
      CASE ec.source
        WHEN 'macos' THEN 1 WHEN 'iphone' THEN 2 WHEN 'outlook' THEN 3
        WHEN 'google_contacts' THEN 4 WHEN 'android_sync' THEN 5 ELSE 6
      END,
      ec.external_record_id
    FROM external_contacts ec
    WHERE ec.user_id = @userId
      AND NOT EXISTS (
            SELECT 1 FROM contact_source_links x
             WHERE x.contact_id = @contactId
               AND x.match_method <> 'origin'
          )
      AND EXISTS (
        SELECT 1 FROM contact_phones cp, json_each(COALESCE(ec.phones_normalized_json, '[]')) j
         WHERE cp.contact_id = @contactId
           AND COALESCE(NULLIF(cp.phone_normalized, ''), cp.phone_e164) = j.value
           AND TRIM(j.value) <> ''
      )
  )
  ORDER BY pri, source_rank, external_record_id
`;

export interface ContactSourceRecordRow {
  emails_json: string | null;
  phones_json: string | null;
  matched_by: "source_id" | "email" | "phone";
  pri: number;
  source_rank: number;
  external_record_id: string;
}
