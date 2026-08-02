/**
 * Contact Source Linker (BACKLOG-2401)
 *
 * Decides WHICH saved contact a source record belongs to, and records the
 * decision in the `contact_source_links` crosswalk together with how it was
 * made.
 *
 * ===========================================================================
 * THE MATCHING ORDER — this is the heart of the feature, read it before editing
 * ===========================================================================
 *
 *   1. SOURCE ID FIRST. If the crosswalk already claims this
 *      (source_type, source_record_id), that is the answer. Immune to an
 *      identifier moving between people: Daniel's record id resolves to Daniel
 *      regardless of who now holds the phone number that used to be his.
 *
 *   2. CONTENT FALLBACK (email, THEN phone) ONLY WHERE NO ID MATCH EXISTS.
 *      Its legitimate uses are narrow: a device swap (macOS ZUNIQUEID and the
 *      iPhone backup row id are both device-local, so a new machine or a restore
 *      changes every id), and a contact imported before this table existed.
 *      NEVER as a tiebreaker against an id match.
 *
 *   3. A CONTENT MATCH THAT WOULD REASSIGN AN IDENTIFIER IS FLAGGED, NOT
 *      APPLIED. See the section below — this is the case that makes the naive
 *      version of this feature actively wrong.
 *
 *   4. NEVER FALL BACK TO NAME. That is the mechanism being replaced. A rename
 *      in Contacts.app must not create a second person.
 *
 * ===========================================================================
 * WHY STEP 3 EXISTS — the Daniel/Lilly case
 * ===========================================================================
 * A phone number was recorded against Daniel, then corrected: it is actually
 * Lilly's. Daniel's SAVED contact still carries that number from the first
 * import. A phone-based fallback therefore matches Lilly's source record to
 * DANIEL's saved contact — confidently, silently, and backwards.
 *
 * Content matching assumes an identifier belongs to one person forever. It does
 * not: numbers are reassigned by carriers, corrected after data-entry errors,
 * and inherited within families and businesses.
 *
 * The structural signal that distinguishes "re-link after a device swap" from
 * "an identifier moved between two people" is whether the contact's identity
 * for that source is ALREADY ESTABLISHED AND STILL LIVE:
 *
 *   - Contact has NO link for this source            -> apply (C10: pre-crosswalk contact)
 *   - Contact's existing link points at a record that
 *     NO LONGER EXISTS in the source                 -> apply (C6: device swap, ids all changed)
 *   - Contact's existing link points at a DIFFERENT
 *     record that IS still present in the source     -> FLAG (C8/C9: the identifier moved)
 *
 * The third case is the only one where two live records of the same source both
 * want the same contact, which is precisely a human decision.
 *
 * Case C7 — both people still present with their own ids — never reaches any of
 * this: both resolve at step 1 and the content fallback never fires at all.
 *
 * ===========================================================================
 * WHAT "FLAGGED" MEANS TODAY — and what it does NOT
 * ===========================================================================
 * The link is NOT created, the conflict is counted in the ingestion funnel, and
 * it is returned to the caller so it can be surfaced and asserted on.
 *
 * There is NO durable review queue for contact links, because no such substrate
 * exists: BACKLOG-2319's "Needs review" is a `match_reason` column on
 * `communications` / `ignored_communications` and is about EMAILS, not
 * contacts. Building a contact-level review surface is its own item. Until then
 * the guarantee this module makes is the important half — a suspect link is
 * never silently applied.
 *
 * ===========================================================================
 * FROZEN AUDITS
 * ===========================================================================
 * Linking only ever INSERTs crosswalk rows. It never creates, deletes, merges
 * or re-points a contact, so a frozen transaction's contact set is unchanged by
 * construction. `isContactOnFrozenTransaction` additionally makes the riskiest
 * path — the content fallback — refuse to touch a contact an exported audit
 * depends on. Per the founder's rule those contacts are updated IN PLACE and
 * therefore always have an id match, so this guard should never fire; it is
 * belt-and-braces on the one path where being wrong is unrecoverable.
 *
 * NO SCORING HERE. Every link this module writes is deterministic and its
 * `confidence` is NULL.
 */

import { dbAll, dbGet } from "./db/core/dbConnection";
import type { ExternalContactSource } from "./db/externalContactDbService";
import {
  createLink,
  findContactIdBySourceRecord,
  getLinksForContactBySource,
} from "./db/contactSourceLinkDbService";
import { toLookupKey } from "../utils/phoneNormalization";
import logService from "./logService";

/** A source record offered for linking. Names are deliberately absent. */
export interface SourceRecordCandidate {
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  /** macOS ZEXTERNALUUID. Captured, never matched on (portability unverified). */
  externalUuid?: string | null;
  emails?: string[];
  phones?: string[];
}

export type LinkResolution =
  /** Step 1 — the crosswalk already claims this record. */
  | { outcome: "already_linked"; contactId: string; sourceRecordId: string }
  /** Step 2 — deterministic content fallback applied, link created. */
  | {
      outcome: "linked";
      contactId: string;
      sourceRecordId: string;
      method: "email" | "phone";
    }
  /** Step 3 — suspect. Not applied. */
  | {
      outcome: "flagged";
      sourceRecordId: string;
      candidateContactId: string;
      conflictingSourceRecordId: string;
      matchedOn: "email" | "phone";
      reason: "identifier_reassigned" | "frozen_audit_contact";
    }
  /** No id match and no content match — a genuinely new person. */
  | { outcome: "no_match"; sourceRecordId: string };

export interface LinkRunSummary {
  /** Records that resolved by source id — the healthy steady state. */
  idMatched: number;
  /** Links newly created from the content fallback. */
  contentMatched: number;
  /** Suspect matches withheld for review. */
  flagged: number;
  /** Records that matched nothing. */
  unmatched: number;
  resolutions: LinkResolution[];
}

/**
 * Is this contact referenced by an EXPORTED (frozen) transaction?
 *
 * `transactions.first_exported_at IS NOT NULL` is the freeze boundary
 * (BACKLOG-2013). The contact→transaction relationship is THREE-WAY and a
 * predicate that checks only the junction table under-reports:
 *   1. direct FK columns on `transactions` (buyer_agent_id, ...)
 *   2. the `transaction_contacts` junction
 *   3. the `other_contacts` JSON array
 */
export function isContactOnFrozenTransaction(contactId: string): boolean {
  // Named parameter: `contactId` appears six times and better-sqlite3 rejects
  // `?N` numbered placeholders, while six positional `?` would be an ordering
  // hazard on every future edit.
  const row = dbGet<{ hit: number }>(
    `SELECT 1 AS hit FROM transactions t
      WHERE t.first_exported_at IS NOT NULL
        AND (
          t.buyer_agent_id = @contactId
          OR t.seller_agent_id = @contactId
          OR t.escrow_officer_id = @contactId
          OR t.inspector_id = @contactId
          OR EXISTS (
            SELECT 1 FROM transaction_contacts tc
             WHERE tc.transaction_id = t.id AND tc.contact_id = @contactId
          )
          OR (
            t.other_contacts IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @contactId
            )
          )
        )
      LIMIT 1`,
    [{ contactId }],
  );
  return row !== undefined && row !== null;
}

/** Imported contacts carrying any of these emails. Exact, case-insensitive. */
function contactIdsByEmail(userId: string, emails: string[]): string[] {
  const cleaned = emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e);
  if (cleaned.length === 0) return [];
  const placeholders = cleaned.map(() => "?").join(", ");
  return dbAll<{ id: string }>(
    `SELECT DISTINCT c.id FROM contacts c
       JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ? AND LOWER(ce.email) IN (${placeholders})
      ORDER BY c.id`,
    [userId, ...cleaned],
  ).map((r) => r.id);
}

/** Imported contacts carrying any of these phones, compared as lookup keys. */
function contactIdsByPhone(userId: string, phones: string[]): string[] {
  const keys = phones.map((p) => toLookupKey(p)).filter((k) => k.length > 0);
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => "?").join(", ");
  return dbAll<{ id: string }>(
    `SELECT DISTINCT c.id FROM contacts c
       JOIN contact_phones cp ON cp.contact_id = c.id
      WHERE c.user_id = ?
        AND COALESCE(NULLIF(cp.phone_normalized, ''), cp.phone_e164) IN (${placeholders})
      ORDER BY c.id`,
    [userId, ...keys],
  ).map((r) => r.id);
}

/**
 * Does `sourceRecordId` still exist in the shadow table for this source?
 *
 * `external_contacts` IS the current source set — a sync rewrites it and prunes
 * records the source no longer returns. So "still present" distinguishes a live
 * conflict (two records of one source competing for one contact) from a stale
 * link left behind by a device change.
 */
function sourceRecordStillExists(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const row = dbGet<{ hit: number }>(
    `SELECT 1 AS hit FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`,
    [userId, sourceType, sourceRecordId],
  );
  return row !== undefined && row !== null;
}

/**
 * Resolve ONE source record to a contact, applying the full matching order.
 *
 * Pure decision + at most one INSERT. Never deletes, never re-points, never
 * touches the contact row.
 */
export function resolveSourceRecord(
  userId: string,
  candidate: SourceRecordCandidate,
): LinkResolution {
  const { sourceType, sourceRecordId, externalUuid = null } = candidate;

  // ---- STEP 1: source id. Always wins. -----------------------------------
  const linkedContactId = findContactIdBySourceRecord(userId, sourceType, sourceRecordId);
  if (linkedContactId) {
    // Opportunistically capture the portable identifier on a row that predates
    // it. Does not change the link or how it was made.
    if (externalUuid) {
      createLink({
        userId,
        contactId: linkedContactId,
        sourceType,
        sourceRecordId,
        matchMethod: "source_id",
        externalUuid,
      });
    }
    return { outcome: "already_linked", contactId: linkedContactId, sourceRecordId };
  }

  // ---- STEP 2: content fallback, email THEN phone. -----------------------
  // Email first: it is the stronger identifier of the two and far less prone to
  // being reassigned between people than a phone number.
  const byEmail = contactIdsByEmail(userId, candidate.emails ?? []);
  const byPhone = byEmail.length > 0 ? [] : contactIdsByPhone(userId, candidate.phones ?? []);
  const matchedOn: "email" | "phone" = byEmail.length > 0 ? "email" : "phone";
  const matches = byEmail.length > 0 ? byEmail : byPhone;

  if (matches.length === 0) {
    return { outcome: "no_match", sourceRecordId };
  }

  // An identifier shared by several saved contacts cannot pick one of them
  // without guessing, and guessing is what this design refuses to do.
  if (matches.length > 1) {
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId: matches[0],
      conflictingSourceRecordId: "",
      matchedOn,
      reason: "identifier_reassigned",
    };
  }

  const candidateContactId = matches[0];

  // ---- STEP 3: is this content match a REASSIGNMENT? ---------------------
  const existingLinks = getLinksForContactBySource(candidateContactId, sourceType);
  const liveConflict = existingLinks.find(
    (l) =>
      l.source_record_id !== sourceRecordId &&
      sourceRecordStillExists(userId, sourceType, l.source_record_id),
  );
  if (liveConflict) {
    logService.info(
      `[Contacts] link withheld for review: a second ${sourceType} record content-matched a contact whose ${sourceType} identity is already live`,
      "Contacts",
    );
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId,
      conflictingSourceRecordId: liveConflict.source_record_id,
      matchedOn,
      reason: "identifier_reassigned",
    };
  }

  // Belt-and-braces: never let the fallback bind a contact an exported audit
  // depends on. Per the in-place rule those contacts always have an id match,
  // so reaching here means an assumption broke — withhold rather than guess.
  if (isContactOnFrozenTransaction(candidateContactId)) {
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId,
      conflictingSourceRecordId: "",
      matchedOn,
      reason: "frozen_audit_contact",
    };
  }

  createLink({
    userId,
    contactId: candidateContactId,
    sourceType,
    sourceRecordId,
    matchMethod: matchedOn,
    externalUuid,
  });

  return { outcome: "linked", contactId: candidateContactId, sourceRecordId, method: matchedOn };
}

/**
 * Link a batch of source records — the opportunistic pass that runs during a
 * normal sync.
 *
 * There is deliberately NO one-time backfill migration (founder, 2026-08-02).
 * Contacts imported before the crosswalk existed get linked here instead: less
 * code, no upgrade path to get wrong, self-healing as syncs run, and it also
 * covers contacts created AFTER this ships that somehow lack a link — which a
 * one-time migration would not.
 */
export function linkSourceRecords(
  userId: string,
  candidates: SourceRecordCandidate[],
): LinkRunSummary {
  const summary: LinkRunSummary = {
    idMatched: 0,
    contentMatched: 0,
    flagged: 0,
    unmatched: 0,
    resolutions: [],
  };

  for (const candidate of candidates) {
    if (!candidate.sourceRecordId) continue;
    const resolution = resolveSourceRecord(userId, candidate);
    summary.resolutions.push(resolution);
    switch (resolution.outcome) {
      case "already_linked":
        summary.idMatched++;
        break;
      case "linked":
        summary.contentMatched++;
        break;
      case "flagged":
        summary.flagged++;
        break;
      default:
        summary.unmatched++;
    }
  }

  return summary;
}

/**
 * The opportunistic pass, run after a sync has refreshed the shadow table.
 *
 * `external_contacts` IS the current source set, so every row in it is a
 * candidate. Records already claimed by the crosswalk resolve on one indexed
 * lookup and cost nothing more; only the genuinely unlinked ones reach the
 * content fallback, and only until they converge.
 */
export function linkExternalContactsForUser(userId: string): LinkRunSummary {
  const rows = dbAll<{
    external_record_id: string;
    source: ExternalContactSource;
    emails_json: string | null;
    phones_json: string | null;
    external_uuid: string | null;
  }>(
    `SELECT external_record_id, source, emails_json, phones_json, external_uuid
       FROM external_contacts
      WHERE user_id = ? AND external_record_id IS NOT NULL
      ORDER BY source, external_record_id`,
    [userId],
  );

  const candidates: SourceRecordCandidate[] = rows.map((r) => ({
    sourceType: r.source,
    sourceRecordId: r.external_record_id,
    externalUuid: r.external_uuid,
    emails: safeJsonArray(r.emails_json),
    phones: safeJsonArray(r.phones_json),
  }));

  return linkSourceRecords(userId, candidates);
}

function safeJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
