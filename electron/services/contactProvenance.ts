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
  type ContactLinkSourceType,
  type ContactMatchMethod,
} from "./db/contactSourceLinkDbService";
import { recordVerdict } from "./db/contactLinkReviewDbService";
import { ORIGIN_MATCH_METHOD } from "./db/contactIdentitySchemaSql";
import { matchMethodDescription, sourceLabel } from "./contactLinkEvidence";
import { removeUnlinkedSourceValues } from "./contactSourceValues";
import logService from "./logService";

export interface ContactSourceProvenance {
  /** The crosswalk row id — what an unlink names. */
  linkId: string;
  /**
   * BACKLOG-2473: wider than `ExternalContactSource`, because the panel now also
   * shows the ORIGIN row — "you added this contact yourself", "found in your
   * text messages" — which names a provenance with no address-book record
   * behind it. An entry with `matchMethod === 'origin'` is not detachable; see
   * the guard in `unlinkContactSource`.
   */
  sourceType: ContactLinkSourceType;
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
 * Every EXTERNAL RECORD this contact was assembled from.
 *
 * LEFT JOIN, not JOIN. A link whose source record has gone (the address book
 * dropped it, an account was disconnected) is still part of how this contact
 * came to be, and hiding it would make a contact assembled from two sources look
 * like it came from one — which is exactly the invisibility this panel exists to
 * end. It is reported with `sourceRecordPresent: false` instead.
 *
 * ===========================================================================
 * ORIGIN ROWS ARE EXCLUDED, AND THAT IS THE WHOLE ANSWER TO SR's BLOCKER 2
 * ===========================================================================
 * This function feeds exactly two callers, and BOTH want "records I could
 * detach", not "everything the crosswalk knows":
 *
 *   `contacts:get-sources` -> the Sources panel, whose threshold is
 *     `sourceList.length > 1` and whose heading reads "This contact was put
 *     together from more than one place". Its stated purpose is to make a WRONG
 *     MERGE visible and undoable.
 *   `unlinkContactSource`'s `remaining` count, reported to the caller and
 *     logged — "how many sources are still attached".
 *
 * v61 gives every created contact an origin row, so counting them broke both.
 * An ordinary Mac-address-book contact reaches TWO rows in the normal course
 * (its origin row, plus the record-backed row the next linking pass writes when
 * it matches the real card), and the panel then opened on a single-address-book
 * contact announcing it came from more than one place and listing "Mac address
 * book" twice. That is precisely the noise BACKLOG-2410 set the threshold at two
 * to prevent. `remaining` was wrong the same way: unlinking a contact's last
 * real source reported 1, not 0.
 *
 * An origin row can never be a wrong merge and can never be detached, so it has
 * nothing to offer either caller. Filtering HERE rather than in the renderer
 * fixes both in one place and keeps the panel's behaviour identical to before
 * this PR — a data-layer change should not silently redesign a screen.
 *
 * The crosswalk is still the one source of truth for PROVENANCE; this reader
 * answers the narrower question the merge-review UI asks. The unlink guard in
 * `unlinkContactSource` stays as defence in depth: a link id is a UUID the
 * renderer holds, so a stale one can still arrive by IPC.
 */
export function getContactProvenance(
  userId: string,
  contactId: string,
): ContactSourceProvenance[] {
  const rows = dbAll<{
    id: string;
    source_type: ContactLinkSourceType;
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
        AND l.match_method <> ?
      ORDER BY l.source_type, l.source_record_id`,
    [userId, contactId, ORIGIN_MATCH_METHOD],
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
  | {
      ok: true;
      remaining: number;
      /**
       * BACKLOG-2427 — what the unlink TOOK BACK, not just what it detached.
       *
       * Reported rather than left implicit because "the link is gone" and "the
       * rejected person's address is gone" are different claims, and the UI has
       * until now made the first while the user reasonably heard the second.
       */
      removedEmails: number;
      removedPhones: number;
      /**
       * Set when addresses that WOULD have been removed were deliberately kept.
       * `frozen_transaction`: the contact is on an exported audit, so removing
       * them would silently change what a re-export searches. Absent means
       * nothing was withheld.
       */
      retainedReason?: "frozen_transaction";
    }
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

  // AN ORIGIN LINK CANNOT BE DETACHED (BACKLOG-2473).
  //
  // "Not this person" is an assertion about an EXTERNAL RECORD: this contact is
  // not the same human as that Outlook entry. An origin row makes no such claim
  // — it records that the contact was typed in by hand, or inferred from a
  // thread. There is nothing to be wrong about and nobody to reject.
  //
  // Two concrete things break without this guard, and neither is cosmetic:
  //
  //  1. `recordVerdict` below writes into `contact_link_verdicts`, whose
  //     `source_type` CHECK deliberately still admits only the five external
  //     sources. Unlinking an origin row whose type is `manual`/`email`/`sms`/
  //     `inferred` throws a CHECK violation out of the transaction.
  //  2. Succeeding would put the contact straight back into the link-less state
  //     v61 exists to eliminate, re-opening the two-answers-to-one-question
  //     defect for that contact — and the next sync would not repair it,
  //     because nothing recreates an origin row outside the migration and the
  //     create path.
  if (row.match_method === ORIGIN_MATCH_METHOD) {
    return {
      ok: false,
      error:
        "This is where the contact came from, not a linked record — it can't be removed.",
    };
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

    // BACKLOG-2427 — AN UNLINK MUST ALSO REVERSE THE COPY.
    //
    // Deleting the crosswalk row was only ever half the action. The backfill had
    // already copied this record's emails and phones onto the contact, and
    // nothing reversed that — so the address of a person the user had just
    // called "somebody else" stayed on a contact who is a party to a
    // transaction, and the audit sweep went on searching for it
    // (`getContactEmailsForTransaction` reads `contact_emails`).
    //
    // AFTER the delete, deliberately: the removal decides what to keep by
    // reading the links that REMAIN, so it must run once this one is gone.
    // Inside the same transaction, so a contact can never be left detached from
    // a source while still carrying its addresses.
    const takenBack = removeUnlinkedSourceValues(
      userId,
      contactId,
      row.source_type,
      row.source_record_id,
    );

    const remaining = getContactProvenance(userId, contactId).length;
    logService.info(
      `[Contacts] a ${row.source_type} source was unlinked by hand; the contact and its ` +
        `${remaining} remaining source link(s) are untouched, and ` +
        `${takenBack.removedEmails} email(s) / ${takenBack.removedPhones} phone(s) ` +
        `contributed only by that source were taken back`,
      "Contacts",
    );
    return {
      ok: true,
      remaining,
      removedEmails: takenBack.removedEmails,
      removedPhones: takenBack.removedPhones,
      ...(takenBack.retainedReason ? { retainedReason: takenBack.retainedReason } : {}),
    };
  });
}
