/**
 * A contact's LIVE source set, derived from the crosswalk (BACKLOG-2472).
 *
 * ===========================================================================
 * THE DEFECT THIS EXISTS TO END
 * ===========================================================================
 * `contacts.source` is ONE scalar, written at INSERT and never revised. The
 * Clients & Contacts source filter switched on it, so:
 *
 *   - A contact present in BOTH the Mac address book and Outlook was filed
 *     under whichever imported FIRST, and was invisible under the other. No
 *     unlinking required — this was wrong from the moment BACKLOG-2401 replaced
 *     the one-source-per-contact model with a crosswalk.
 *   - Unlinking a source could not fix it, because nothing on the unlink path
 *     rewrites the scalar. The founder saw Casey Lane keep his `outlook` label
 *     — and keep appearing under the Outlook filter — after his Outlook link was
 *     removed, while every email and phone he still carried came from macOS.
 *
 * The truth about where a contact comes from is the set of rows in
 * `contact_source_links` that are still there. That is what this module reads.
 *
 * ===========================================================================
 * ONE QUERY FOR THE WHOLE LIST, NOT ONE PER CONTACT
 * ===========================================================================
 * The founder's machine holds ~1,100 contacts. A per-contact lookup — whether a
 * JS loop or a correlated subquery — is 1,100 index probes on a list render that
 * already competes with a worker-thread query for the same screen. `SELECT
 * DISTINCT contact_id, source_type ... WHERE user_id = ?` is one statement whose
 * result is smaller than the contact list itself, grouped in memory.
 *
 * ===========================================================================
 * EMPTY LINK SET => FALL BACK TO THE SCALAR (deliberate, not defensive)
 * ===========================================================================
 * Two large populations have NO crosswalk rows and must not vanish from the
 * list:
 *
 *   - manual contacts — typed in by hand, they have no source record anywhere,
 *     and `contact_source_links.source_type` has no `manual` value to hold one;
 *   - contacts created before v57, whose links only appear once a sync has run.
 *
 * For those, `contacts.source` remains the best statement available and is used
 * unchanged. The fallback lives in the RENDERER predicate (`contactFilterModel`)
 * rather than here, so this module never invents a source a contact does not
 * have: it returns the links, or nothing.
 *
 * `contacts.source` is therefore demoted, NOT removed — it is still meaningful
 * as first-import provenance and is still the only source a manual contact has.
 */

import type { Contact, ContactSource } from "../../types/models";
import { toPersistedContactSource } from "../../utils/contactSourceVocabulary";
import { dbAll, dbGet } from "./core/dbConnection";

/**
 * Whether the crosswalk table exists yet.
 *
 * NOT belt-and-braces: `contact_source_links` arrived in migration v57, and this
 * module is called from the contacts list, which is reachable against a database
 * that has not finished migrating and from test fixtures that seed only the
 * tables their subject touches. A missing table is answered exactly as an empty
 * link set is answered — the caller falls back to `contacts.source` — so the
 * guard adds no behaviour of its own; it only stops a `no such table` throw from
 * blanking a screen that has a correct answer available.
 */
function crosswalkExists(): boolean {
  const row = dbGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_source_links'`,
  );
  return !!row;
}

/**
 * Every contact's live source set for one user, in the DISPLAY vocabulary
 * (`contacts.source`), keyed by contact id.
 *
 * Contacts with no links are ABSENT from the map rather than present with an
 * empty array — "we know of no source records for this person" and "this person
 * has no sources" are different claims and only the first is true here.
 */
export function getLiveSourcesByContact(userId: string): Map<string, ContactSource[]> {
  const byContact = new Map<string, Set<ContactSource>>();
  if (!crosswalkExists()) return new Map();

  const rows = dbAll<{ contact_id: string; source_type: string }>(
    `SELECT DISTINCT contact_id, source_type
       FROM contact_source_links
      WHERE user_id = ?`,
    [userId],
  );

  for (const row of rows) {
    // DISTINCT is on the RAW pair; two raw types could still collapse to one
    // display value, so the Set is what actually de-duplicates the answer.
    const mapped = toPersistedContactSource(row.source_type);
    const existing = byContact.get(row.contact_id);
    if (existing) existing.add(mapped);
    else byContact.set(row.contact_id, new Set([mapped]));
  }

  // Sorted so the value is stable across runs — it is compared in tests and
  // rendered in the card, and neither should depend on row order.
  const result = new Map<string, ContactSource[]>();
  for (const [contactId, sources] of byContact) {
    result.set(contactId, [...sources].sort());
  }
  return result;
}

/**
 * The live source set for ONE contact. Used by the single-contact read path.
 *
 * RETURNS `[]` FOR "NO LINKS" — THE OPPOSITE OF `attachLiveSources`, which
 * leaves `source_types` `undefined` (noted for BACKLOG-2493). The asymmetry is
 * fine here: a bare array return has nowhere to put "absent". But every caller
 * that puts this value ONTO a contact or a DTO owes the field its contract —
 * `undefined` and `[]` are NOT interchangeable, and `[]` asserts "this person
 * has no sources", which hides them from every source leaf. Callers therefore
 * spread it conditionally: `getContactById` and the `contacts:get-edit-data`
 * handler both do `...(liveSources.length > 0 ? { source_types } : {})`.
 * Getting that wrong is invisible in tests, because every consumer today reads
 * `.length` rather than `=== undefined`.
 */
export function getLiveSourcesForContact(contactId: string): ContactSource[] {
  if (!crosswalkExists()) return [];
  const rows = dbAll<{ source_type: string }>(
    `SELECT DISTINCT source_type FROM contact_source_links WHERE contact_id = ?`,
    [contactId],
  );
  const sources = new Set(rows.map((r) => toPersistedContactSource(r.source_type)));
  return [...sources].sort();
}

/**
 * Stamp `source_types` onto a list of contacts with ONE crosswalk query.
 *
 * Contacts with no links are returned untouched — `source_types` stays
 * `undefined`, which is the signal the renderer predicate reads as "fall back to
 * the scalar". An empty array would be a different and wrong signal: it would
 * say this contact has no sources, and hide it from every source leaf.
 */
export function attachLiveSources<T extends Contact>(userId: string, contacts: T[]): T[] {
  if (contacts.length === 0) return contacts;
  const byContact = getLiveSourcesByContact(userId);
  if (byContact.size === 0) return contacts;

  return contacts.map((contact) => {
    const sources = byContact.get(contact.id);
    return sources ? ({ ...contact, source_types: sources } as T) : contact;
  });
}
