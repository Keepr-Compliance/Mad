/**
 * Contact provenance — where a saved contact came from, and how to take it back
 * apart (BACKLOG-2410 part 2)
 *
 * ===========================================================================
 * THE GAP THIS CLOSES
 * ===========================================================================
 * With the crosswalk, one saved contact can be assembled from several source
 * records — Mac address book plus Outlook plus an iPhone backup. Nothing in the
 * contact view said so.
 *
 * That matters more here than in most products. If a merge is WRONG, it is
 * currently invisible: the user sees one contact with no indication it is two
 * people fused together, and no way to separate them. In an audit product that
 * wrong merge ends up in an exported document attributed to the wrong person.
 *
 * ===========================================================================
 * SHOWING IT WITHOUT AN UNDO WOULD BE WORSE THAN NOT SHOWING IT
 * ===========================================================================
 * Founder, 2026-08-02: "showing the merge without letting someone undo it just
 * tells them about a problem they can't fix." The crosswalk makes the undo
 * lossless — remove one row, keep both the contact and the source record — so
 * there is no excuse for a read-only panel.
 *
 * ===========================================================================
 * AN UNLINK THAT THE NEXT SYNC UNDOES IS NOT AN UNLINK
 * ===========================================================================
 * THIS IS THE PART THAT IS EASY TO GET WRONG AND HARD TO NOTICE.
 *
 * Deleting the crosswalk row alone is not enough. The linker's step 1 resolves a
 * record by its existing link; with the link gone it falls through to the
 * CONTENT FALLBACK, matches the same email or phone that produced the wrong
 * merge in the first place, and recreates the link. The user's correction would
 * survive until the next sync and then silently revert — and they would have no
 * reason to look again.
 *
 * So unlinking also records a `different_people` VERDICT. That is not
 * bookkeeping; it is the thing that makes the undo stick, because
 * `hasCannotLink` is consulted by every linking rule before it links. Unlinking
 * is a human saying "this source record is not this person", which is precisely
 * what the verdict table is for.
 *
 * ===========================================================================
 * ONE SOURCE -> SHOW NOTHING
 * ===========================================================================
 * The common case is a contact from a single address book, where "where did
 * this come from" is not a question anyone is asking. The panel renders nothing
 * at all there — no badge, no empty state. That rule is enforced in the
 * renderer (`ContactPreview`), and this service reports the links honestly
 * either way so the caller can apply it.
 */

import { dbAll, dbGet, dbTransaction } from "./db/core/dbConnection";
import type { ExternalContactSource } from "./db/externalContactDbService";
import {
  deleteLinkById,
  type ContactMatchMethod,
} from "./db/contactSourceLinkDbService";
import { recordVerdict } from "./db/contactLinkReviewDbService";
import { matchMethodDescription, sourceLabel } from "./contactLinkEvidence";
import logService from "./logService";

export interface ContactSourceProvenance {
  /** The crosswalk row id — what an unlink names. */
  linkId: string;
  sourceType: ExternalContactSource;
  /** "Mac address book", "Outlook contacts". */
  sourceLabel: string;
  matchMethod: ContactMatchMethod;
  /** How the link was made, in words. Never a score. */
  matchDescription: string;
  /** What the source record calls this person right now. */
  sourceName: string | null;
  /** Whether the source still returns this record. */
  sourceRecordPresent: boolean;
  matchedAt: string | null;
  lastSyncedAt: string | null;
}

/**
 * Every source this contact was assembled from.
 *
 * LEFT JOIN, not JOIN. A link whose source record has gone (the address book
 * dropped it, an account was disconnected) is still part of how this contact
 * came to be, and hiding it would make a contact assembled from two sources look
 * like it came from one — which is exactly the invisibility this panel exists to
 * end. It is reported with `sourceRecordPresent: false` instead.
 */
export function getContactProvenance(
  userId: string,
  contactId: string,
): ContactSourceProvenance[] {
  const rows = dbAll<{
    id: string;
    source_type: ExternalContactSource;
    source_record_id: string;
    match_method: ContactMatchMethod;
    matched_at: string | null;
    source_name: string | null;
    synced_at: string | null;
    present: number | null;
  }>(
    `SELECT l.id, l.source_type, l.source_record_id, l.match_method, l.matched_at,
            ec.name AS source_name, ec.synced_at, ec.id IS NOT NULL AS present
       FROM contact_source_links l
       LEFT JOIN external_contacts ec
         ON ec.user_id = l.user_id
        AND ec.source = l.source_type
        AND ec.external_record_id = l.source_record_id
      WHERE l.user_id = ? AND l.contact_id = ?
      ORDER BY l.source_type, l.source_record_id`,
    [userId, contactId],
  );

  return rows.map((r) => ({
    linkId: r.id,
    sourceType: r.source_type,
    sourceLabel: sourceLabel(r.source_type),
    matchMethod: r.match_method,
    matchDescription: matchMethodDescription(r.match_method, r.source_type),
    sourceName: r.source_name?.trim() || null,
    sourceRecordPresent: !!r.present,
    matchedAt: r.matched_at,
    lastSyncedAt: r.synced_at,
  }));
}

export type UnlinkOutcome =
  | { ok: true; remaining: number }
  | { ok: false; error: string };

/**
 * Detach ONE source from a contact. The contact survives. So does the source
 * record. So does every other link.
 *
 * The `user_id` and `contact_id` are re-checked against the row rather than
 * trusted from the caller: this is reachable from IPC, and a link id is a UUID
 * the renderer holds — the check is what stops one user's id detaching another
 * user's link, and what stops a stale renderer detaching a link that has since
 * moved to a different contact.
 */
export function unlinkContactSource(
  userId: string,
  contactId: string,
  linkId: string,
): UnlinkOutcome {
  const row = dbGet<{
    id: string;
    user_id: string;
    contact_id: string;
    source_type: ExternalContactSource;
    source_record_id: string;
    match_method: ContactMatchMethod;
  }>(
    `SELECT id, user_id, contact_id, source_type, source_record_id, match_method
       FROM contact_source_links WHERE id = ?`,
    [linkId],
  );

  if (!row || row.user_id !== userId || row.contact_id !== contactId) {
    return { ok: false, error: "That source link no longer exists." };
  }

  return dbTransaction<UnlinkOutcome>(() => {
    // The verdict FIRST, then the delete. If only one of the two can happen, the
    // safe survivor is the constraint: a verdict without a delete leaves a link
    // the user asked to remove (visible, they can retry), while a delete without
    // a verdict leaves a correction the next sync silently reverses (invisible,
    // they will not retry because they believe it worked).
    recordVerdict({
      userId,
      contactId,
      sourceType: row.source_type,
      sourceRecordId: row.source_record_id,
      identityVerdict: "different_people",
      reason: "manual_unlink",
      matchedOn: row.match_method,
      decidedBy: "provenance_unlink",
    });

    const removed = deleteLinkById(linkId);
    if (removed === 0) {
      return { ok: false, error: "That source link no longer exists." };
    }

    const remaining = getContactProvenance(userId, contactId).length;
    logService.info(
      `[Contacts] a ${row.source_type} source was unlinked by hand; the contact and its ` +
        `${remaining} remaining source link(s) are untouched`,
      "Contacts",
    );
    return { ok: true, remaining };
  });
}
