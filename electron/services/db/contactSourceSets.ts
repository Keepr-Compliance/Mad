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
import { sql } from "./core/sqlText";
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
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_source_links'`,
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
    sql`SELECT DISTINCT contact_id, source_type
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
    sql`SELECT DISTINCT source_type FROM contact_source_links WHERE contact_id = ?`,
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
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_link_verdicts'`,
  );
  return !!row;
}

/** Same guard, same reason, for the table the `Suggestion` badge reads. */
function proposalsExist(): boolean {
  const row = dbGet<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_link_proposals'`,
  );
  return !!row;
}

/**
 * How many questions are OPEN against each contact (BACKLOG-2626).
 *
 * ===========================================================================
 * THE PREDICATE IS COPIED FROM THE QUEUE ON PURPOSE
 * ===========================================================================
 * `contactLinkReview.ts`'s `PENDING_JOIN` is the definition of an ASKABLE
 * question: pending, against a contact that still exists, about a source record
 * that still exists. A proposal whose record has vanished from the address book
 * is a question with no answer, and the queue deliberately does not ask it.
 *
 * The badge must count the same set. A `Suggestion` badge on a contact the queue
 * has no question for is the BACKLOG-2626 defect restated from the other side —
 * the row would promise something outstanding and the walk would open onto
 * nothing. So the two predicates agree, and `contactCompare.test.ts` asserts that
 * agreement against the queue's own reader rather than against a copy of the SQL.
 *
 * NOT imported from `contactLinkReview.ts`: that module is a service that opens
 * transactions and writes verdicts, and this is the DB layer beneath it. The
 * dependency would run the wrong way. The test is what keeps them equal.
 */
function getOpenQuestionsByContact(userId: string): Map<string, number> {
  if (!proposalsExist()) return new Map();

  const rows = dbAll<{ contact_id: string; open_questions: number }>(
    sql`SELECT p.contact_id AS contact_id, COUNT(*) AS open_questions
       FROM contact_link_proposals p
       JOIN contacts c
         ON c.id = p.contact_id AND c.removed_at IS NULL
       JOIN external_contacts ec
         ON ec.user_id = p.user_id
        AND ec.source = p.source_type
        AND ec.external_record_id = p.source_record_id
      WHERE p.user_id = ? AND p.status = 'pending'
      GROUP BY p.contact_id`,
    [userId],
  );

  return new Map(rows.map((r) => [r.contact_id, r.open_questions]));
}

/**
 * Every contact for one user that carries a badge, with the numbers behind it.
 * TWO queries for the whole list, for the reason stated at the top of this file.
 *
 * ===========================================================================
 * WHAT THIS SET MEANS NOW — BACKLOG-2626 CHANGED IT
 * ===========================================================================
 * It used to mean "the contacts the compare screen opens for", because the same
 * flag drove the row badge AND the click interception. **It no longer decides
 * where a click goes.** A click now opens the contact card, or walks the OPEN
 * QUESTIONS one at a time (`Contacts.tsx`), and those questions are proposals —
 * rows in `contact_link_proposals`, which the old rule could not see at all.
 *
 * That blindness was the founder's defect. He answered two candidates, clicked
 * the contact, and got a compare screen showing three columns he had ALREADY
 * approved, while the fourth, unanswered candidate — the actual reason it opened
 * — was nowhere on screen. The old membership rule reads the crosswalk, and the
 * crosswalk only knows about links that already exist.
 *
 * So the set is now a UNION of two populations:
 *
 *   1. **Crosswalk members** — contacts assembled from more than one record, or
 *      from a record attached after the fact. They earn `Autolinked` (the app
 *      attached something the user has not ratified) or `You linked these`.
 *   2. **Contacts with an open question** — which need NOT be crosswalk members
 *      at all. A proposal can stand against a contact holding nothing but the
 *      card it was imported from, and that contact must show `Suggestion` or the
 *      question is invisible outside the queue.
 *
 * A contact in NEITHER population carries no badge, and `review_state` stays
 * `undefined`. That is the regression guard against decorating every row, and it
 * is asserted directly.
 *
 * ===========================================================================
 * THE CROSSWALK MEMBERSHIP RULE, UNCHANGED
 * ===========================================================================
 * `columns` still promises exactly what `Compare sources` will draw, and that
 * button is still gated on `showSourcesPanel`. So the crosswalk half keeps the
 * rule it had, and for the same reason: a badge whose number disagrees with the
 * screen it describes is a small lie on an audit surface.
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
 * ===========================================================================
 * THE CONTACT'S OWN RECORD IS NOT A LINK ANYONE OWES A VERDICT ON
 * ===========================================================================
 * Founder QA, 10 Aug, on `010bfd93`: he imported Desmond Okafor and attached
 * Petra Lindqvist to him BY HAND. The row read `2 records combined` — correct —
 * beside **`Autolinked`**, which is a statement about who decided, and nothing
 * had guessed anything. Rosalind Vance, imported plus THREE hand-made links, had
 * been mislabelled the same way all evening.
 *
 * His crosswalk for Desmond, non-origin rows only:
 *
 *   | match_method | latest verdict                          |
 *   |--------------|-----------------------------------------|
 *   | `source_id`  | none, ever                              |
 *   | `manual`     | `same_person`, `decided_by=manual_link` |
 *
 * `linkSourceRecordToContact` writes that `same_person` verdict itself, so the
 * hand-made link was confirmed. The `source_id` row was not — because a
 * `source_id` row is the SOURCE ASSERTING ITS OWN RECORD. `linkImportedContact`
 * writes it when the user picks a record in the import picker ("the link is
 * asserted, not inferred — the strongest evidence this system ever gets"), and
 * `resolveSourceRecord` only ever writes it to backfill an `externalUuid` on a
 * pair that is ALREADY linked. Nothing reviews such a row, so no verdict is ever
 * written against it, so it fell to `ELSE 1` forever. One unreviewed row was
 * enough to flip the whole contact, and `user_linked` was unreachable for every
 * imported contact in the database.
 *
 * This is the SAME mistake `6f8374df` fixed in `records` — the contact's own
 * record treated as a match — and that fix corrected the counts and left this
 * expression alone.
 *
 * SO IT IS SUBTRACTED, NOT FILTERED. Widening the `WHERE` to drop `source_id`
 * rows is the intuitive fix and it silently re-breaks `6f8374df`: `link_count`
 * and `source_id_count` come from THIS row set and feed `records` and `columns`.
 * On a collapsed import — two `source_id` rows, the founder's Casey Lane — the
 * filtered version reports 2 records where 3 came together. Asserted directly,
 * because with a single `source_id` row the two spellings are numerically
 * identical and the trap is invisible.
 *
 * `MAX(...)` EXEMPTS AT MOST ONE ROW, mirroring what `columns` and `records`
 * already absorb — the ONE record the contact was made from. A collapsed import
 * keeps its second `source_id` row in the tally and stays `Autolinked`, which is
 * shipped behaviour left deliberately unchanged: whether picking one collapsed
 * picker row counts as the user linking BOTH records is the founder's call, and
 * it is filed on BACKLOG-2626 rather than decided here. It also keeps this
 * reader agreeing with `contactCompare.isConfirmed`, which quantifies over every
 * non-origin link — the two are asserted equal on every shape.
 *
 * `AND v.identity_verdict IS NULL` guards the arm order: a `source_id` row that
 * someone REJECTED (`different_people`, via provenance unlink) keeps counting as
 * unconfirmed. Only the never-judged row is exempt, because only that row is one
 * nobody was ever asked about.
 *
 * TIE-BREAK: `decided_at DESC, rowid DESC`, matching `getLatestVerdict`'s SQL —
 * NOT its docblock, which names `id`. `recordVerdict` assigns a `uuidv4()`, so
 * ordering by `id` would be random while `rowid` is insertion order. The list
 * and the screen must resolve "latest" the same way or they will disagree about
 * the same contact.
 */
export function getReviewStateByContact(userId: string): Map<string, ContactReviewState> {
  const openQuestions = getOpenQuestionsByContact(userId);

  const rows = crosswalkExists() && verdictsExist() ? readCrosswalkAggregate(userId) : [];

  const byContact = new Map<string, ContactReviewState>();

  for (const r of rows) {
    const open = openQuestions.get(r.contact_id) ?? 0;
    const needsReview = r.unconfirmed > 0;
    byContact.set(r.contact_id, {
      // The contact's own column, plus every non-origin link EXCEPT the one
      // that column absorbs — at most one `source_id` row.
      columns: 1 + r.link_count - (r.source_id_count > 0 ? 1 : 0),
      /*
        REAL RECORDS, ONCE EACH — BACKLOG-2626, folding in `14617008`, corrected
        after founder QA on `b64da8c8`.

        Every non-origin link IS a real record, so `link_count` is the base. The
        `+ 1` stands for the CONTACT'S OWN record, and is added only when that
        record is not already among the links.

        ===================================================================
        THE OFF-BY-ONE THIS REPLACED, AND WHY IT SURVIVED A ROUND OF QA
        ===================================================================
        It was `1 + r.link_count`. The founder pasted his contact card beside the
        row: `Sources 4`, and the row read **"5 records combined"**. His first
        source is `Recognised by its own entry in your Mac address book` — the
        `source_id` row written at import. That row IS the contact's own record;
        it is non-origin, so it sits inside `link_count`, and the unconditional
        `+ 1` counted him twice.

        It was CORRECT for a hand-made contact, which carries only a synthetic
        `origin:${contactId}` row — excluded by `match_method <> ?` below — and
        so genuinely has a record of its own that no link represents. Right for
        one population and wrong for the other is why it survived: every shape
        anyone thought to check was a hand-made one.

        `origin` rows stand for no address-book record; `source_id` rows stand
        for a real one. That distinction is the whole fix.

        ===================================================================
        THIS CURRENTLY EQUALS `columns` — A COINCIDENCE TO WATCH, NOT A
        DUPLICATE TO COLLAPSE
        ===================================================================
        `columns` is `1 + link_count - (source_id_count > 0 ? 1 : 0)`, which is
        the same number on every shape. Established by RUNNING both over the
        shape table in `contactCompare.test.ts`, not by algebra alone.

        They are not the same question. `columns` is a UI fact: the compare
        screen chooses to FOLD the contact's own record into the contact's
        column. `records` is a data fact about how many real records came
        together. They agree today because the screen folds exactly the record
        this declines to double-count; a design that drew that record as its own
        column beside the contact would move `columns` and must not move this.

        So it is asserted against the SOURCES PANEL — the thing the founder
        actually compared it to — and deliberately never against `columns`.
      */
      records: r.link_count + (r.source_id_count > 0 ? 0 : 1),
      needsReview,
      openQuestions: open,
      badge: open > 0 ? "suggestion" : needsReview ? "autolinked" : "user_linked",
    });
  }

  /*
    THE SECOND POPULATION: a question standing against a contact the crosswalk
    has nothing to say about.

    Its `columns`/`records` are 1 — it is assembled from one record — so the row
    shows the badge and no count, which is correct: nothing is combined YET. The
    candidate is not a record this contact is made of; it is the question.
  */
  for (const [contactId, open] of openQuestions) {
    if (byContact.has(contactId)) continue;
    byContact.set(contactId, {
      columns: 1,
      records: 1,
      needsReview: false,
      openQuestions: open,
      badge: "suggestion",
    });
  }

  return byContact;
}

function readCrosswalkAggregate(userId: string): Array<{
  contact_id: string;
  link_count: number;
  source_id_count: number;
  unconfirmed: number;
}> {
  return dbAll<{
    contact_id: string;
    link_count: number;
    source_id_count: number;
    unconfirmed: number;
  }>(
    sql`SELECT l.contact_id                                              AS contact_id,
            COUNT(*)                                                  AS link_count,
            SUM(CASE WHEN l.match_method = 'source_id' THEN 1 ELSE 0 END) AS source_id_count,
            SUM(CASE WHEN v.identity_verdict = 'same_person' THEN 0 ELSE 1 END)
              - MAX(CASE WHEN l.match_method = 'source_id' AND v.identity_verdict IS NULL
                         THEN 1 ELSE 0 END)                          AS unconfirmed
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
}

/**
 * Stamp `review_state` onto a list of contacts with ONE pair of queries.
 *
 * Contacts with no badge to carry are returned untouched — `review_state` stays
 * `undefined`, which every consumer must read as "no badge", never as
 * "reviewed" and never as "nothing outstanding".
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
