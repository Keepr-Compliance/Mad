/**
 * Recover the provenance of values already in the database (BACKLOG-2427).
 *
 * ===========================================================================
 * THE PROBLEM THIS CLEANS UP
 * ===========================================================================
 * Until BACKLOG-2427 threaded it through, every value-level insert hard-coded
 * `contact_emails.source = 'import'` — including `createContact` and the
 * `allEmails` / `allPhones` arrays on `contacts:create`, both of which the
 * manual Add Contact form goes through. So in an existing install, a
 * hand-typed address and an address-book address are INDISTINGUISHABLE: both
 * say `'import'`.
 *
 * That matters because BACKLOG-2427 gives the unlink permission to DELETE
 * `'import'` values. Shipping the removal without this pass would delete
 * hand-typed client contact details on every existing install the first time a
 * user pressed "Not this person".
 *
 * ===========================================================================
 * HOW PROVENANCE IS RECOVERED — AND WHICH WAY IT FAILS
 * ===========================================================================
 * The origin was never recorded, so it is DERIVED from what is still true:
 *
 *   Does any source record currently linked to this contact carry this value?
 *     yes -> it plausibly came from a source     -> leave `'import'`
 *     no  -> it cannot have come from a source   -> relabel `'manual'`
 *
 * AMBIGUITY ALWAYS RESOLVES TO NEVER-REMOVE. A value whose origin cannot be
 * established is treated as typed. The harms are not symmetric and it is worth
 * being explicit about which one is chosen: misclassifying an imported value as
 * typed leaves a stale row the user can delete themselves; the reverse silently
 * deletes a client's phone number from an audit record.
 *
 * A KNOWN, ACCEPTED CONSEQUENCE: a value that really was imported from a source
 * the user has since unlinked — or a contact whose crosswalk has not converged
 * yet — is classified `'manual'` and becomes permanently non-removable. That is
 * the safe direction and it is correct.
 *
 * Note what this does NOT damage: the case BACKLOG-2427 exists for. A contact
 * assembled from two live sources still has both links at migration time, so
 * the rejected source's addresses still read `'import'` and are still removable.
 * The pass protects typed values without disarming the fix.
 *
 * Runs once, from migration v60. It only ever moves `'import'` -> `'manual'`,
 * so a second run is a no-op — there is no `'import'` left to reconsider.
 */

/**
 * The slice of a synchronous SQLite handle this needs.
 *
 * Structural rather than `better-sqlite3`'s `Database`, so the migration can be
 * exercised against `node:sqlite` in tests. The repo's better-sqlite3 binary is
 * an Electron build (ABI 139) and cannot be loaded by plain node, which is why
 * every suite that requires it is red on a developer machine — a migration
 * whose test cannot run is not a tested migration.
 */
export interface SyncSqliteDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface RelabelResult {
  emails: number;
  phones: number;
}

function tableExists(d: SyncSqliteDb, name: string): boolean {
  return !!d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
}

/**
 * Relabel `'import'` values that no currently-linked source record carries.
 *
 * Returns the number of rows moved in each table so the migration can log a
 * real count rather than "done".
 */
export function relabelTypedContactValues(d: SyncSqliteDb): RelabelResult {
  // Nothing to derive from without the crosswalk and the shadow table. Both
  // predate v60, but an upgrade path that somehow lacks them must be a no-op
  // rather than a failed migration — and a no-op here is the SAFE direction
  // only if we leave the rows alone, since relabelling everything to 'manual'
  // on a missing table would disarm the removal entirely.
  if (
    !tableExists(d, "contact_source_links") ||
    !tableExists(d, "external_contacts") ||
    !tableExists(d, "contact_emails") ||
    !tableExists(d, "contact_phones")
  ) {
    return { emails: 0, phones: 0 };
  }

  // Emails: compared case-insensitively and trimmed, exactly as
  // `removeUnlinkedSourceValues` and `getContactEmailsForTransaction` compare
  // them. A stricter comparison here would classify a differently-cased
  // duplicate as typed; a looser one would leave a typed value removable.
  const emails = d
    .prepare(
      `UPDATE contact_emails
          SET source = 'manual'
        WHERE source = 'import'
          AND NOT EXISTS (
            SELECT 1
              FROM contact_source_links csl
              JOIN external_contacts ec
                ON ec.user_id = csl.user_id
               AND ec.source = csl.source_type
               AND ec.external_record_id = csl.source_record_id
              JOIN json_each(COALESCE(ec.emails_json, '[]')) j
             WHERE csl.contact_id = contact_emails.contact_id
               AND TRIM(j.value) <> ''
               AND LOWER(TRIM(j.value)) = LOWER(TRIM(contact_emails.email))
          )`,
    )
    .run();

  // Phones: matched on the last-10 normalized key, since the stored spelling
  // ("+14082104874") and the source's spelling ("(408) 210-4874") differ.
  // COALESCE covers rows written before `phone_normalized` was populated.
  const phones = d
    .prepare(
      `UPDATE contact_phones
          SET source = 'manual'
        WHERE source = 'import'
          AND NOT EXISTS (
            SELECT 1
              FROM contact_source_links csl
              JOIN external_contacts ec
                ON ec.user_id = csl.user_id
               AND ec.source = csl.source_type
               AND ec.external_record_id = csl.source_record_id
              JOIN json_each(COALESCE(ec.phones_normalized_json, '[]')) j
             WHERE csl.contact_id = contact_phones.contact_id
               AND TRIM(j.value) <> ''
               AND j.value = COALESCE(NULLIF(contact_phones.phone_normalized, ''), contact_phones.phone_e164)
          )`,
    )
    .run();

  return { emails: Number(emails.changes), phones: Number(phones.changes) };
}
