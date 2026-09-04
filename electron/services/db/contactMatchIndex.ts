/**
 * The three probes the linker makes per record, behind one interface — with a
 * BATCH implementation that reads each relation once per pass (BACKLOG-2620).
 *
 * ===========================================================================
 * THE DEFECT THIS EXISTS TO FIX
 * ===========================================================================
 * `contactSourceLinker.linkExternalContactsForUser` feeds every row of
 * `external_contacts` to a per-record resolver, and its docblock claimed the
 * cost was self-limiting: "only the genuinely unlinked ones reach the content
 * fallback, and only until they converge."
 *
 * **That convergence never happens for a record that will never match.** Nothing
 * is written about a record that matched nothing, so it re-enters the content
 * fallback on the next pass, and the next, permanently. The founder's own log at
 * `71ddcbb0`:
 *
 *     links: 1169 records -> id-matched 10 -> content-matched 0
 *            -> flagged 5 -> declined 1 -> unmatched 1153
 *
 * 1,153 of 1,169 records, three SQL statements each, every pass, forever — and
 * the passes are frequent (`contactLinkingScheduler` fires one per quiet period,
 * routinely twice per sync run).
 *
 * ===========================================================================
 * WHY THIS IS BATCH RECOMPUTATION AND NOT A CACHED "NO MATCH"
 * ===========================================================================
 * The obvious fix is to remember that a record matched nothing and skip it. The
 * obvious fix is a worse bug: a record that matched nothing today must be
 * reconsidered when the contact set changes, or a contact created tomorrow
 * never picks up the records that predate it — the same defect inverted, and
 * silent.
 *
 * A cached negative result is therefore only sound with an invalidation signal,
 * and there are exactly two kinds:
 *
 *   DERIVED FROM THE DATA — a digest over `contacts JOIN contact_emails/phones`.
 *     Sound by construction, because the digest is taken over the same relation
 *     the match reads. But computing it costs THE SAME READS this file already
 *     does to build the maps. The cache would then save nothing and add a
 *     staleness surface.
 *
 *   EVENT-DRIVEN — triggers or call-site bumps on a generation counter. Cheap to
 *     check, but it must enumerate every write path that can add an identifier
 *     to a contact, and the failure mode of missing one is exactly the silent
 *     defect above. It also needs a migration.
 *
 * So the maps below are REBUILT FROM THE LIVE RELATIONS ON EVERY PASS. No
 * negative result is ever reused, so there is nothing to invalidate: a contact
 * created, edited, merged, deleted or restored between two passes is simply read
 * on the second pass. What that buys is the shape of the cost, not a cache —
 * content-matching SQL becomes a fixed four statements per pass instead of ~3
 * per unmatched record.
 *
 * This does NOT reduce the pass to zero work: it still iterates every record, at
 * in-memory cost. If a corpus ever makes that iteration matter, the answer is
 * the trigger-and-generation design with its own migration. It is not needed at
 * 1,169 records.
 *
 * ===========================================================================
 * THE ONE THING THAT CAN INVALIDATE A MAP *DURING* A PASS
 * ===========================================================================
 * A content match does not only write a crosswalk row. `resolveSourceRecord`
 * then calls `applyLinkedSourceValues`, which COPIES THE SOURCE RECORD'S EMAILS
 * AND PHONES ONTO THE SAVED CONTACT (BACKLOG-2423). Those are rows in the very
 * tables these maps are built from, so a later record in the SAME pass can
 * legitimately match a contact through an address the pass itself just added.
 *
 * With per-record SQL that happened for free. Here it must be said out loud:
 * `noteContactValuesChanged` re-reads that one contact's identifiers and merges
 * them in. It is called by the linker immediately after the copy, and it is the
 * only in-pass invalidation there is, because linking writes nothing else that
 * these maps read.
 */

import { dbAll, dbGet } from "./core/dbConnection";
import { sql, type SafeSql } from "./core/sqlText";
import { placeholderList } from "./core/sqlFragments";
import type { ExternalContactSource } from "./externalContactDbService";
import { toMatchingKey } from "../../utils/phoneNormalization";

/** What the crosswalk knows about one source record. */
export interface LinkedRecordRow {
  contactId: string;
  /**
   * Does the row already carry a portable identifier?
   *
   * STEP 1's `createLink` call exists ONLY to backfill `external_uuid` onto a
   * row that predates it. When the row already has one the UPDATE is a COALESCE
   * no-op that touches nothing but `updated_at` — which nothing reads — so the
   * caller can skip a SELECT and a WRITE per id-matched record per pass. In the
   * healthy steady state EVERY record is id-matched, so that is the cost the
   * feature settles into.
   */
  hasExternalUuid: boolean;
}

/**
 * The probes `resolveSourceRecord` makes before it knows whether a record
 * matches anything at all.
 *
 * Two implementations, pinned to each other by
 * `contactSourceLinker.convergence-2620.test.ts`'s parity control: they must
 * return identical id sets, in identical order, for the same corpus.
 */
export interface ContactMatchIndex {
  /** STEP 1 — the crosswalk row that already claims this record. */
  linkedRecord(
    userId: string,
    sourceType: ExternalContactSource,
    sourceRecordId: string,
  ): LinkedRecordRow | null;
  /** Imported contacts carrying any of these emails. Exact, case-insensitive. */
  contactIdsByEmail(userId: string, emails: string[]): string[];
  /** Imported contacts carrying any of these phones, compared as lookup keys. */
  contactIdsByPhone(userId: string, phones: string[]): string[];
  /**
   * This contact's emails/phones just changed — re-read them.
   *
   * A no-op for the live implementation, which never held a copy.
   */
  noteContactValuesChanged(contactId: string): void;
}

// ---------------------------------------------------------------------------
// The live implementation — one statement per probe, exactly as before.
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * WHY `+c.user_id` AND NOT `c.user_id` — BACKLOG-2621, and it still applies
 * ===========================================================================
 * The unary `+` is SQLite's documented no-op prefix: same value, same result
 * set, but the term can no longer drive an index. Without it SQLite anchors
 * `contacts` as the outer loop on `user_id` and does one seek into the child
 * table PER CONTACT, never touching the value indexes — O(contacts owned by
 * this user) on every call. With it the plan is driven by
 * `idx_contact_emails_email_lower` / `idx_contact_phones_normalized` and costs
 * O(values probed). `matchingIndexUsage.test.ts` asserts the plan both ways, and
 * captures these queries FROM THIS MODULE at runtime rather than transcribing
 * them, so deleting the `+` turns that suite red.
 *
 * The batch loader below deliberately does NOT carry the `+`, for the opposite
 * reason — see its own note.
 */
/**
 * BACKLOG-3085: these were `%PLACEHOLDERS%` constants finished by `String.replace`
 * at the call site — SQL assembled by a runtime string operation, which the `sql`
 * tag refuses. They are now functions OF the placeholder fragment, so the width and
 * the text are produced together and the same characters reach SQLite.
 * `contactMatchIndex.brand.test.ts` asserts that, against the pre-conversion text.
 */
const liveEmailSql = (marks: SafeSql): SafeSql => sql`SELECT DISTINCT c.id FROM contacts c
       JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE +c.user_id = ? AND LOWER(ce.email) IN (${marks})
      ORDER BY c.id`;

const livePhoneSql = (marks: SafeSql): SafeSql => sql`SELECT DISTINCT c.id FROM contacts c
       JOIN contact_phones cp ON cp.contact_id = c.id
      WHERE +c.user_id = ?
        AND cp.phone_normalized IN (${marks})
      ORDER BY c.id`;

/**
 * Probe emails, normalised the way the query compares them.
 *
 * The PROBE side trims and lowercases in JavaScript; the STORED side is
 * lowercased by SQL `LOWER()` and is NOT trimmed. That asymmetry is the shipped
 * behaviour — a stored address with a leading space does not match — and the
 * batch loader reproduces it by lowercasing the stored side IN SQL rather than
 * in JavaScript. (They are not the same function: SQLite's `LOWER` is
 * ASCII-only, `String.prototype.toLowerCase` is Unicode-aware.)
 *
 * EXPORTED for `contactIdentityEvidence` (BACKLOG-2630 D2 piece 2) so the
 * evidence gatherer probes with THIS function rather than a second copy of the
 * rule. A gatherer that keyed identifiers differently from the linker would
 * report facts about a match the linker could never make.
 */
export function emailProbeKeys(emails: string[]): string[] {
  return emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e);
}

/**
 * Probe phones as MATCH CANDIDATE keys. Empty keys are dropped: `IN` never
 * matches them.
 *
 * BACKLOG-2630 slice 1 / BACKLOG-2754: `toMatchingKey`, not `toLookupKey`. This
 * function decides which phone values are allowed to propose that two records
 * are the same person, so the founder's digit floor belongs exactly here — a
 * shared extension or a 4-digit typo must not put two unrelated contacts in
 * front of him as a duplicate.
 *
 * The probe side alone is sufficient. A below-floor value emits nothing and so
 * matches nothing, and no above-floor probe key can equal a stored below-floor
 * key (they differ in length). Flooring the STORED side as well would mean
 * re-keying `contact_phones` to drop short values, which is the key-layer floor
 * BACKLOG-2754 rejects.
 *
 * EXPORTED for `contactIdentityEvidence` (BACKLOG-2630 D2 piece 2), for the same
 * reason as `emailProbeKeys` above: one digit floor, one place.
 */
export function phoneProbeKeys(phones: string[]): string[] {
  return phones.map((p) => toMatchingKey(p)).filter((k) => k.length > 0);
}

function placeholders(n: number): SafeSql {
  return placeholderList(n);
}

/**
 * Reads the database on every probe. The single-record path, and the shape the
 * batch implementation is checked against.
 */
export function liveContactMatchIndex(): ContactMatchIndex {
  return {
    linkedRecord(userId, sourceType, sourceRecordId) {
      if (!sourceRecordId) return null;
      const row = dbGet<{ contact_id: string; external_uuid: string | null }>(
        sql`SELECT contact_id, external_uuid FROM contact_source_links
          WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
        [userId, sourceType, sourceRecordId],
      );
      if (!row) return null;
      return { contactId: row.contact_id, hasExternalUuid: !!row.external_uuid };
    },

    contactIdsByEmail(userId, emails) {
      const cleaned = emailProbeKeys(emails);
      if (cleaned.length === 0) return [];
      return dbAll<{ id: string }>(
        liveEmailSql(placeholders(cleaned.length)),
        [userId, ...cleaned],
      ).map((r) => r.id);
    },

    contactIdsByPhone(userId, phones) {
      const keys = phoneProbeKeys(phones);
      if (keys.length === 0) return [];
      return dbAll<{ id: string }>(
        livePhoneSql(placeholders(keys.length)),
        [userId, ...keys],
      ).map((r) => r.id);
    },

    noteContactValuesChanged() {
      /* nothing is held, so nothing can be stale */
    },
  };
}

// ---------------------------------------------------------------------------
// The batch implementation
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * THESE LOADS DROP THE UNARY `+`, AND THAT IS THE SAME DECISION, NOT ITS OPPOSITE
 * ===========================================================================
 * `+c.user_id` exists to stop `user_id` driving the join when a VALUE predicate
 * should. These queries have no value predicate: `user_id` is the only term, so
 * it is exactly the right driver and `idx_contacts_user_id` is exactly the index
 * to use. Adding the `+` here would force a full scan of `contacts` for no
 * reason.
 *
 * `ORDER BY c.id` is load-bearing, not tidiness: it is what makes the id lists
 * come out in the order the live queries produce, which is the order
 * `resolveSourceRecord` reads `matches[0]` from when two contacts share one
 * identifier.
 */
const BATCH_EMAIL_SQL = sql`SELECT c.id AS contact_id, LOWER(ce.email) AS k
       FROM contacts c
       JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ?
      ORDER BY c.id`;

const BATCH_PHONE_SQL = sql`SELECT c.id AS contact_id, cp.phone_normalized AS k
       FROM contacts c
       JOIN contact_phones cp ON cp.contact_id = c.id
      WHERE c.user_id = ?
      ORDER BY c.id`;

/**
 * The user's contact ids in SQLite's own `ORDER BY id` order.
 *
 * A separate statement rather than a JavaScript sort. Union order has to match
 * `ORDER BY c.id` under the column's collation, and reproducing a SQLite
 * collation in JavaScript is a guess that happens to be right for ASCII ids —
 * asking the database is not a guess. It also costs one statement per pass.
 */
const BATCH_ORDER_SQL = sql`SELECT id FROM contacts WHERE user_id = ? ORDER BY id`;

const BATCH_LINKS_SQL = sql`SELECT source_type, source_record_id, contact_id, external_uuid
       FROM contact_source_links
      WHERE user_id = ?`;

function crosswalkKey(sourceType: string, sourceRecordId: string): string {
  // =========================================================================
  // THE DELIMITER IS WRITTEN AS AN ESCAPE, AND THAT IS NOT A STYLE CHOICE
  // =========================================================================
  // `\u0000` rather than a literal NUL byte in the source. A raw NUL makes the
  // whole FILE read as binary -- `file` reports "data", and every plain `grep`
  // over the repository silently skips it, which is how `contactManualLink.ts`
  // went missing from repo-wide sweeps. Caught here by running `file` before
  // this shipped, having written the byte itself.
  //
  // NUL is the right delimiter because it cannot occur in either part: both are
  // TEXT columns written by a JSON parser or a SQL writer, and `source_type` is
  // additionally CHECK-constrained to a nine-value vocabulary
  // (`contactIdentitySchemaSql.ts`). Two distinct (type, record id) pairs
  // therefore cannot collide on one key however exotic a provider's record id
  // is -- and an Outlook record id IS an opaque Graph token, not a UUID.
  return `${sourceType}\u0000${sourceRecordId}`;
}

function addTo(map: Map<string, string[]>, key: string, contactId: string): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [contactId]);
    return;
  }
  // `includes` rather than a check against the last element: during the ordered
  // load a repeat IS adjacent, but `noteContactValuesChanged` re-adds one
  // contact's keys mid-pass and has no such guarantee. This is what the live
  // query's DISTINCT removes — a contact reaching one key through two of its
  // own rows ("A@x" and "a@x" both lower to one key).
  if (!existing.includes(contactId)) existing.push(contactId);
}

function removeFrom(map: Map<string, string[]>, key: string, contactId: string): void {
  const existing = map.get(key);
  if (!existing) return;
  const next = existing.filter((id) => id !== contactId);
  if (next.length === 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Read every relation the content fallback probes, once.
 *
 * Four statements, independent of how many records the pass is about to resolve.
 */
export function loadContactMatchIndex(userId: string): ContactMatchIndex {
  const order = new Map<string, number>();
  dbAll<{ id: string }>(BATCH_ORDER_SQL, [userId]).forEach((r, i) => order.set(r.id, i));

  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  /** contact -> the keys it currently contributes, so a refresh can retract them. */
  const emailKeysOf = new Map<string, Set<string>>();
  const phoneKeysOf = new Map<string, Set<string>>();

  function index(
    rows: Array<{ contact_id: string; k: string | null }>,
    map: Map<string, string[]>,
    keysOf: Map<string, Set<string>>,
  ): void {
    for (const row of rows) {
      // A NULL or empty key is unreachable by `IN (?)`, so it is not a
      // candidate in the live query either. Dropping it here keeps the two
      // implementations answering the same question.
      if (!row.k) continue;
      addTo(map, row.k, row.contact_id);
      let keys = keysOf.get(row.contact_id);
      if (!keys) {
        keys = new Set<string>();
        keysOf.set(row.contact_id, keys);
      }
      keys.add(row.k);
    }
  }

  index(dbAll<{ contact_id: string; k: string | null }>(BATCH_EMAIL_SQL, [userId]), byEmail, emailKeysOf);
  index(dbAll<{ contact_id: string; k: string | null }>(BATCH_PHONE_SQL, [userId]), byPhone, phoneKeysOf);

  const links = new Map<string, LinkedRecordRow>();
  for (const row of dbAll<{
    source_type: string;
    source_record_id: string;
    contact_id: string;
    external_uuid: string | null;
  }>(BATCH_LINKS_SQL, [userId])) {
    const key = crosswalkKey(row.source_type, row.source_record_id);
    // (user_id, source_type, source_record_id) is UNIQUE, so this never
    // overwrites a different row. `set` unconditionally would still be correct;
    // keeping the first mirrors `dbGet`, which returns one row and stops.
    if (!links.has(key)) {
      links.set(key, { contactId: row.contact_id, hasExternalUuid: !!row.external_uuid });
    }
  }

  /**
   * The contacts holding any of these keys, in `ORDER BY c.id` order.
   *
   * ===========================================================================
   * THE SORT IS UNCONDITIONAL, AND A ONE-KEY FAST PATH WAS A REAL BUG
   * ===========================================================================
   * The first version returned the stored array unsorted when there was only one
   * key, reasoning that the load is already ordered by contact id. It is — until
   * `noteContactValuesChanged` appends a contact mid-pass, which puts a
   * LATER-sorting id at the front of a key it just joined.
   *
   * That is not cosmetic. When two contacts share an identifier the record is
   * flagged `ambiguous_identifier` and `matches[0]` is the contact the question
   * NAMES, so the order decides what a human is asked. The parity control caught
   * it: the live query said `c-both`, the batch said `c-phone-only`, for a
   * record whose rival contact had just been given the phone number by the
   * previous record's link.
   */
  function union(map: Map<string, string[]>, keys: string[]): string[] {
    if (keys.length === 0) return [];
    const out = new Set<string>();
    for (const key of keys) {
      for (const id of map.get(key) ?? []) out.add(id);
    }
    // Rank comes from the database's own ordering of `contacts.id`.
    return [...out].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  return {
    linkedRecord(callerUserId, sourceType, sourceRecordId) {
      assertSameUser(userId, callerUserId);
      if (!sourceRecordId) return null;
      return links.get(crosswalkKey(sourceType, sourceRecordId)) ?? null;
    },

    contactIdsByEmail(callerUserId, emails) {
      assertSameUser(userId, callerUserId);
      return union(byEmail, emailProbeKeys(emails));
    },

    contactIdsByPhone(callerUserId, phones) {
      assertSameUser(userId, callerUserId);
      return union(byPhone, phoneProbeKeys(phones));
    },

    /**
     * Re-read one contact's identifiers after the pass changed them.
     *
     * Full replace rather than append: `applyLinkedSourceValues` only adds
     * today, but a retract that silently did nothing would be the same class of
     * bug this module exists to close, and the cost is identical.
     */
    noteContactValuesChanged(contactId: string) {
      for (const [map, keysOf, statement] of [
        [byEmail, emailKeysOf, sql`SELECT LOWER(email) AS k FROM contact_emails WHERE contact_id = ?`],
        [byPhone, phoneKeysOf, sql`SELECT phone_normalized AS k FROM contact_phones WHERE contact_id = ?`],
      ] as Array<[Map<string, string[]>, Map<string, Set<string>>, SafeSql]>) {
        for (const key of keysOf.get(contactId) ?? []) removeFrom(map, key, contactId);
        keysOf.delete(contactId);
        const fresh = dbAll<{ k: string | null }>(statement, [contactId]);
        index(
          fresh.map((r) => ({ contact_id: contactId, k: r.k })),
          map,
          keysOf,
        );
      }
      // A contact that gained its first identifier during the pass still needs a
      // rank, or a union involving it would sort it to the front.
      if (!order.has(contactId)) order.set(contactId, order.size);
    },
  };
}

/**
 * An index is loaded for ONE user and answers for that user only.
 *
 * Throwing beats returning the wrong user's contacts: the pass is per-user
 * (`linkExternalContactsForUser`), so a mismatch is a programming error, and the
 * quiet failure mode would be cross-account linking.
 */
function assertSameUser(loadedFor: string, asked: string): void {
  if (loadedFor !== asked) {
    throw new Error(
      `contactMatchIndex was loaded for one user and probed for another`,
    );
  }
}
