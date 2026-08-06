/**
 * Contact Source Link Database Service (BACKLOG-2401)
 *
 * The crosswalk between a saved `contacts` row and the external source records
 * it came from. This is the substrate the identity / auto-matching layer sits
 * on, and it replaces the mechanism it is named after: before this table, the
 * ONLY bridge from a saved contact back to the address book was display-name
 * string equality (`... FROM external_contacts WHERE user_id = ? AND name = ?`).
 * Rename yourself in Contacts.app and you became a different person to Keepr.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE, NOT TWO COLUMNS ON `contacts`
 * ---------------------------------------------------------------------------
 * One contact maps to MANY source records. There are five sources, and after
 * BACKLOG-2392 the macOS reader returns EVERY address book, so one person in
 * both iCloud and Exchange already yields two macOS records before any other
 * source is considered. A single column keeps whichever import ran last and
 * silently drops every other source's updates.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY IS THE PAIR (source_type, source_record_id) — NEVER THE ID ALONE
 * ---------------------------------------------------------------------------
 * Every source has its own id space and nothing prevents collisions between
 * them, so UNIQUE(user_id, source_type, source_record_id) is what makes a
 * source record unclaimable by two contacts. `source_type` reuses
 * `ExternalContactSource` — it is deliberately NOT `contacts.source`, a
 * different display-facing vocabulary in which macOS is `'contacts_app'`.
 *
 * ---------------------------------------------------------------------------
 * EVERY ROW RECORDS **HOW** IT WAS MADE
 * ---------------------------------------------------------------------------
 * `match_method` / `confidence` / `matched_at` / `evidence_ref` exist from day
 * one because they cannot be retrofitted — you cannot determine after the fact
 * how a link was made. Today every link written by this codebase is
 * deterministic (`source_id` | `email` | `phone` | `manual`) and `confidence`
 * is always NULL. `scored` is declared so BACKLOG-2273 can write probabilistic
 * links into the same table and still be told apart from a certain one.
 * NO SCORING IS IMPLEMENTED HERE.
 *
 * A `scored` link must be reversible without data loss — `deleteLink*` removes
 * only the row asserting two things are the same person; it never touches the
 * contact or the source record. The first wrong auto-match will need exactly
 * that, so it is tested.
 */

import { v4 as uuidv4 } from "uuid";
import { dbAll, dbGet, dbRun } from "./core/dbConnection";
import type { ExternalContactSource } from "./externalContactDbService";

/**
 * How a crosswalk row came to exist.
 *
 * - `source_id` — the source record's own id matched an existing link. Immune to
 *   an identifier moving between people; always preferred.
 * - `email` / `phone` — deterministic CONTENT fallback, used only where no id
 *   match exists (a device swap, or a contact predating the crosswalk).
 * - `unique_name` — BACKLOG-2410: the name matched EXACTLY, appeared exactly
 *   twice across everything the user has, and those two came from different
 *   source families (one address book, one mail account). Deterministic and
 *   narrow. It is NOT the general name fallback this table was built to replace
 *   — see contactNameAutoLink.ts for why the gate makes the difference — and it
 *   is recorded distinguishably so a user reading the provenance panel can tell
 *   a name match from an identifier match and judge it for themselves.
 * - `manual` — a human asserted it.
 * - `scored` — a probabilistic guess (BACKLOG-2273). Not produced by this code.
 * - `origin` — BACKLOG-2473. NOT A MATCH AT ALL. The row records WHERE THE
 *   CONTACT CAME FROM (typed by hand, inferred from an email or text thread) so
 *   provenance has one source of truth, instead of being read from the crosswalk
 *   for imported contacts and from the `contacts.source` scalar for everyone
 *   else. It points at a synthetic `source_record_id` that JOINs nothing, and
 *   `CONTACT_SOURCE_RECORDS_SQL` must exclude it from its content-fallback gate
 *   or address resolution dies for every contact — see db/contactOriginLink.ts.
 */
export type ContactMatchMethod =
  | "source_id"
  | "email"
  | "phone"
  | "unique_name"
  | "manual"
  | "scored"
  | "origin";

export const CONTACT_MATCH_METHODS: readonly ContactMatchMethod[] = [
  "source_id",
  "email",
  "phone",
  "unique_name",
  "manual",
  "scored",
  "origin",
];

/**
 * What `contact_source_links.source_type` can hold after v61 (BACKLOG-2473).
 *
 * WIDER THAN `ExternalContactSource`, and the difference is load-bearing.
 * `ExternalContactSource` means "a source that has rows in `external_contacts`";
 * it stays at five values, which is what keeps `SOURCE_FAMILIES` in
 * contactLinkEvidence and the linker's own exhaustive maps correct. The
 * crosswalk additionally carries four ORIGIN-ONLY types — `manual`, `email`,
 * `sms`, `inferred` — which name a provenance with no external record behind it
 * and appear only on rows whose `match_method` is `origin`.
 *
 * A `contacts_app` contact's origin is spelled `macos`, not a sixth address-book
 * name: the crosswalk has always called the desktop address book `macos`, and a
 * second spelling for one source is how a filter comes to miss half its rows.
 */
export type ContactLinkSourceType =
  | ExternalContactSource
  | "manual"
  | "email"
  | "sms"
  | "inferred";

export interface ContactSourceLink {
  id: string;
  user_id: string;
  contact_id: string;
  source_type: ExternalContactSource;
  source_record_id: string;
  /**
   * macOS ZEXTERNALUUID — the CardDAV server-side identity captured beside the
   * device-local ZUNIQUEID.
   *
   * NOTHING READS THIS YET, DELIBERATELY. ZUNIQUEID is device-local (two Macs on
   * one iCloud account assign different values), so it must never become a cloud
   * sync key. ZEXTERNALUUID is the only candidate portable identifier, and its
   * portability is UNVERIFIED — confirming it needs two Macs on one account.
   * It is captured now only because capturing it later is impossible for any
   * user who has changed machines: you cannot go back and read a store that no
   * longer exists.
   */
  external_uuid: string | null;
  match_method: ContactMatchMethod;
  /** NULL for every deterministic link. Only `scored` links carry a number. */
  confidence: number | null;
  matched_at: string;
  /** NULL for now — the hook for BACKLOG-2269 evidence linking. */
  evidence_ref: string | null;
}

export interface CreateLinkInput {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  matchMethod: ContactMatchMethod;
  externalUuid?: string | null;
  confidence?: number | null;
  evidenceRef?: string | null;
}

const LINK_COLUMNS = `
  id, user_id, contact_id, source_type, source_record_id,
  external_uuid, match_method, confidence, matched_at, evidence_ref
`;

/**
 * Resolve a source record to the contact that already claims it.
 *
 * This is STEP 1 of the matching order and the whole point of the table: it is
 * immune to an identifier (a phone number, an email) moving between people,
 * because it asks "whose record is this?" rather than "who has this number?".
 */
export function findContactIdBySourceRecord(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): string | null {
  if (!sourceRecordId) return null;
  const row = dbGet<{ contact_id: string }>(
    `SELECT contact_id FROM contact_source_links
      WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
    [userId, sourceType, sourceRecordId],
  );
  return row?.contact_id ?? null;
}

/** Every source record this contact is known by, across all sources. */
export function getLinksForContact(contactId: string): ContactSourceLink[] {
  return dbAll<ContactSourceLink>(
    `SELECT ${LINK_COLUMNS} FROM contact_source_links
      WHERE contact_id = ? ORDER BY source_type, source_record_id`,
    [contactId],
  );
}

export function getLinksForUser(userId: string): ContactSourceLink[] {
  return dbAll<ContactSourceLink>(
    `SELECT ${LINK_COLUMNS} FROM contact_source_links
      WHERE user_id = ? ORDER BY source_type, source_record_id`,
    [userId],
  );
}

/**
 * The `(source_type, source_record_id)` keys already linked for this user.
 *
 * Feeds the already-imported filter, which must treat a contact as imported if
 * ANY of its crosswalk rows matches — otherwise the same person re-offers
 * itself once per source (catalogue C13).
 */
export function getLinkedSourceKeys(userId: string): Set<string> {
  const rows = dbAll<{ source_type: string; source_record_id: string }>(
    `SELECT source_type, source_record_id FROM contact_source_links WHERE user_id = ?`,
    [userId],
  );
  return new Set(rows.map((r) => sourceKey(r.source_type as ExternalContactSource, r.source_record_id)));
}

/** Canonical in-memory key. The PAIR, never the id alone. */
export function sourceKey(sourceType: ExternalContactSource, sourceRecordId: string): string {
  return `${sourceType}\u0000${sourceRecordId}`;
}

/**
 * Existing links for this contact on ONE source.
 *
 * Used by the reassignment check: a contact whose identity for a source is
 * already established, being content-matched by a DIFFERENT record of that same
 * source, is the Daniel/Lilly case and must be flagged rather than applied.
 */
export function getLinksForContactBySource(
  contactId: string,
  sourceType: ExternalContactSource,
): ContactSourceLink[] {
  return dbAll<ContactSourceLink>(
    `SELECT ${LINK_COLUMNS} FROM contact_source_links
      WHERE contact_id = ? AND source_type = ? ORDER BY source_record_id`,
    [contactId, sourceType],
  );
}

/**
 * Insert a link, or return the existing one when the source record is already
 * claimed.
 *
 * Returns `created: false` when the pair is already linked. The caller must NOT
 * treat that as a failure — it is the steady state once the crosswalk has
 * converged. A pair claimed by a DIFFERENT contact is also `created: false`
 * with the incumbent's id, never a silent re-point: re-pointing is a merge
 * (BACKLOG-2370), not a link.
 */
export function createLink(input: CreateLinkInput): { created: boolean; contactId: string; id: string | null } {
  const {
    userId,
    contactId,
    sourceType,
    sourceRecordId,
    matchMethod,
    externalUuid = null,
    confidence = null,
    evidenceRef = null,
  } = input;

  if (!sourceRecordId) {
    return { created: false, contactId, id: null };
  }

  const existing = dbGet<{ id: string; contact_id: string }>(
    `SELECT id, contact_id FROM contact_source_links
      WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
    [userId, sourceType, sourceRecordId],
  );
  if (existing) {
    // Capture the portable identifier on a row that predates it, without
    // touching the link's identity or its match_method (how it was made does
    // not change because we learned an extra field about it).
    if (externalUuid) {
      dbRun(
        `UPDATE contact_source_links
            SET external_uuid = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND external_uuid IS NULL`,
        [externalUuid, existing.id],
      );
    }
    return { created: false, contactId: existing.contact_id, id: existing.id };
  }

  const id = uuidv4();
  dbRun(
    `INSERT INTO contact_source_links
       (id, user_id, contact_id, source_type, source_record_id,
        external_uuid, match_method, confidence, evidence_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, contactId, sourceType, sourceRecordId, externalUuid, matchMethod, confidence, evidenceRef],
  );
  return { created: true, contactId, id };
}

/**
 * Drop the link for one source record. The CONTACT SURVIVES (catalogue C14).
 *
 * This is what "a source record was deleted" means: that source no longer knows
 * this person, so it stops contributing updates. Every other source's link, and
 * the contact itself with its transaction history, is untouched.
 */
export function deleteLinkBySourceRecord(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): number {
  const result = dbRun(
    `DELETE FROM contact_source_links
      WHERE user_id = ? AND source_type = ? AND source_record_id = ?`,
    [userId, sourceType, sourceRecordId],
  );
  return result.changes;
}

/**
 * Unlink by row id — the reversibility guarantee for a wrong link.
 *
 * Removes only the assertion that these two are the same person. Neither the
 * contact nor the source record is deleted.
 */
export function deleteLinkById(id: string): number {
  return dbRun(`DELETE FROM contact_source_links WHERE id = ?`, [id]).changes;
}

export function countLinksForUser(userId: string): number {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_source_links WHERE user_id = ?`,
    [userId],
  );
  return row?.n ?? 0;
}
