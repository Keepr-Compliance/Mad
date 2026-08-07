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

import type { Contact, ContactReviewState, ContactSource } from "../../types/models";
import { toPersistedContactSource } from "../../utils/contactSourceVocabulary";
import { dbAll, dbGet } from "./core/dbConnection";
import { ORIGIN_MATCH_METHOD } from "./contactIdentitySchemaSql";

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

// ===========================================================================
// BACKLOG-2471 PR F — WHICH CONTACTS STILL OWE THE USER A DECISION
// ===========================================================================

/**
 * What the list needs to know about one combined contact.
 *
 * Present ONLY for contacts the compare screen would actually open for. A
 * contact absent from the map is one with nothing to compare — no flag, no
 * interception. That is the same three-state discipline as `source_types`
 * above, and it matters more here: `undefined` must never be read as
 * "reviewed", or a path that forgot to stamp would silently mark the whole
 * address book settled.
 */
// `ContactReviewState` is declared in `types/models.ts` — see the note there.

function verdictsExist(): boolean {
  const row = dbGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_link_verdicts'`,
  );
  return !!row;
}

/**
 * Every combined contact for one user, with its column count and whether it is
 * still awaiting a decision. ONE query for the whole list, for the reason
 * stated at the top of this file.
 *
 * ===========================================================================
 * THE MEMBERSHIP RULE, AND WHY IT IS NOT NEGOTIABLE
 * ===========================================================================
 * The set this produces decides which rows are flagged AND which clicks open
 * the compare screen. So it must equal the set the compare screen actually
 * opens for. If it does not, one of two lies ships: a flagged row that opens an
 * ordinary card, or an intercepted click landing on "there is nothing to
 * compare". Both are worse than no flag at all.
 *
 * `showSourcesPanel`, expressed in SQL:
 *   - more than one non-origin link, OR
 *   - exactly one, attached after the fact (`match_method <> 'source_id'`).
 * With one link `MIN(match_method)` IS that link's method, so the second clause
 * reads "the single link was attached"; with more, the first short-circuits.
 *
 * ===========================================================================
 * `rn = 1` BELONGS IN THE JOIN, NOT THE WHERE
 * ===========================================================================
 * Moving it to `WHERE` silently converts the LEFT JOIN into an inner one and
 * drops every link nobody has judged — which is precisely the set of contacts
 * that need review. The bug would look like "review works, but only for
 * contacts already partly reviewed".
 *
 * A NULL verdict falls to `ELSE 1`, so an unjudged link counts as unconfirmed.
 *
 * TIE-BREAK: `decided_at DESC, rowid DESC`, matching `getLatestVerdict`'s SQL —
 * NOT its docblock, which names `id`. `recordVerdict` assigns a `uuidv4()`, so
 * ordering by `id` would be random while `rowid` is insertion order. The list
 * and the screen must resolve "latest" the same way or they will disagree about
 * the same contact.
 */
export function getReviewStateByContact(userId: string): Map<string, ContactReviewState> {
  if (!crosswalkExists() || !verdictsExist()) return new Map();

  const rows = dbAll<{
    contact_id: string;
    link_count: number;
    source_id_count: number;
    unconfirmed: number;
  }>(
    `SELECT l.contact_id                                              AS contact_id,
            COUNT(*)                                                  AS link_count,
            SUM(CASE WHEN l.match_method = 'source_id' THEN 1 ELSE 0 END) AS source_id_count,
            SUM(CASE WHEN v.identity_verdict = 'same_person' THEN 0 ELSE 1 END) AS unconfirmed
       FROM contact_source_links l
       LEFT JOIN (
         SELECT contact_id, source_type, source_record_id, identity_verdict,
                ROW_NUMBER() OVER (
                  PARTITION BY contact_id, source_type, source_record_id
                  ORDER BY decided_at DESC, rowid DESC
                ) AS rn
           FROM contact_link_verdicts
          WHERE user_id = ?
       ) v ON v.rn = 1
          AND v.contact_id = l.contact_id
          AND v.source_type = l.source_type
          AND v.source_record_id = l.source_record_id
      WHERE l.user_id = ? AND l.match_method <> ?
      GROUP BY l.contact_id
     HAVING COUNT(*) > 1 OR MIN(l.match_method) <> 'source_id'`,
    [userId, userId, ORIGIN_MATCH_METHOD],
  );

  return new Map(
    rows.map((r) => [
      r.contact_id,
      {
        // The contact's own column, plus every non-origin link EXCEPT the one
        // that column absorbs — at most one `source_id` row.
        columns: 1 + r.link_count - (r.source_id_count > 0 ? 1 : 0),
        needsReview: r.unconfirmed > 0,
      },
    ]),
  );
}

/**
 * Stamp `review_state` onto a list of contacts with ONE query.
 *
 * Contacts with nothing to compare are returned untouched — `review_state`
 * stays `undefined`, which every consumer must read as "no flag, no
 * interception", never as "reviewed".
 *
 * Applied wherever `attachLiveSources` is, and for the same reason: a contact
 * reached through a path that stamps one and not the other carries half its
 * state, and the half it is missing is the half this feature is about.
 */
export function attachReviewState<T extends Contact>(userId: string, contacts: T[]): T[] {
  if (contacts.length === 0) return contacts;
  const byContact = getReviewStateByContact(userId);
  if (byContact.size === 0) return contacts;

  return contacts.map((contact) => {
    const state = byContact.get(contact.id);
    return state ? ({ ...contact, review_state: state } as T) : contact;
  });
}
