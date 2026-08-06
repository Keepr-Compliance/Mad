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
 *
 * ===========================================================================
 * WHY MALFORMED JSON IS GUARDED RATHER THAN LEFT TO THROW
 * ===========================================================================
 * `json_each` raises `malformed JSON` on a non-JSON string — including the
 * empty string, which `COALESCE` does not catch because it is not NULL. SR
 * review judged this unreachable (`emails_json` is always written by
 * `JSON.stringify`, and production SQL already calls bare `json_each` on it)
 * and observed that a throw merely rolls the migration back to v59.
 *
 * Guarded anyway, because the rollback is not where the story ends. The NEW
 * code ships in the same release, and it treats `source = 'import'` as
 * permission to DELETE. A user whose row trips the throw stays at v59 with
 * their typed values still labelled `'import'`, and then runs the new removal
 * against exactly the un-reclassified data this pass exists to protect. The
 * failure mode is not "migration retried next launch", it is "the one user with
 * a corrupt shadow row is the one user who loses their typed contact details".
 *
 * `json_valid(x)` returns NULL for NULL, so the CASE covers the NULL case too
 * and replaces the previous `COALESCE`. A record whose JSON cannot be read is
 * treated as carrying NOTHING, so values it might have vouched for are
 * reclassified `'manual'` — the never-remove direction, consistent with the
 * rest of this pass.
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
 * Does a column exist yet?
 *
 * NOT paranoia — a caught defect. `contact_phones.phone_normalized` is added by
 * migration v40 and `external_contacts.phones_normalized_json` by BACKLOG-1727,
 * so ANY database upgrading from before those points reaches v60 without them.
 * The first version of this pass referenced both unconditionally and died with
 * `no such column: contact_phones.phone_normalized`, aborting the migration and
 * pinning the database at v59 — while the new removal code shipped alongside it
 * went on treating those users' typed values as removable.
 *
 * This is precisely the shape BACKLOG-2298 recorded: a migration that passes
 * every in-memory fixture built at HEAD and breaks a real old->new upgrade.
 * It was caught by running under the REAL driver against the older fixtures,
 * which is why that coverage was worth insisting on.
 */
function columnExists(d: SyncSqliteDb, table: string, column: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
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

  // The `source` column is what this pass writes. Without it there is nothing
  // to classify and nothing the removal could later read, so do nothing.
  if (
    !columnExists(d, "contact_emails", "source") ||
    !columnExists(d, "contact_phones", "source")
  ) {
    return { emails: 0, phones: 0 };
  }

  const sourceEmailJson = columnExists(d, "external_contacts", "emails_json")
    ? "CASE WHEN json_valid(ec.emails_json) THEN ec.emails_json ELSE '[]' END"
    : "'[]'";

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
              JOIN json_each(${sourceEmailJson}) j
             WHERE csl.contact_id = contact_emails.contact_id
               AND TRIM(j.value) <> ''
               AND LOWER(TRIM(j.value)) = LOWER(TRIM(contact_emails.email))
          )`,
    )
    .run();

  // Phones: matched on the last-10 normalized key, since the stored spelling
  // ("+14085550101") and the source's spelling ("(408) 555-0101") differ.
  // COALESCE covers rows written before `phone_normalized` was populated.
  // Degrade to `phone_e164` where `phone_normalized` (migration v40) is not
  // there yet. The comparison is then weaker — a differently-spelled number on
  // the source record will not match — which relabels the value `'manual'` and
  // protects it. The safe direction, consistently.
  const storedPhoneKey = columnExists(d, "contact_phones", "phone_normalized")
    ? "COALESCE(NULLIF(contact_phones.phone_normalized, ''), contact_phones.phone_e164)"
    : "contact_phones.phone_e164";
  // Likewise for the source record's parallel normalized array (BACKLOG-1727).
  // Absent, no source vouches for any phone, and every 'import' phone is
  // protected.
  const sourcePhoneJson = columnExists(d, "external_contacts", "phones_normalized_json")
    ? "CASE WHEN json_valid(ec.phones_normalized_json) THEN ec.phones_normalized_json ELSE '[]' END"
    : "'[]'";

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
              JOIN json_each(${sourcePhoneJson}) j
             WHERE csl.contact_id = contact_phones.contact_id
               AND TRIM(j.value) <> ''
               AND j.value = ${storedPhoneKey}
          )`,
    )
    .run();

  return { emails: Number(emails.changes), phones: Number(phones.changes) };
}
