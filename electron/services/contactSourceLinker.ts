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
 *   5. A NAME IS STILL A VETO — BACKLOG-2619. Rule 4 says a name may never
 *      CREATE a link. It has been read as though it also said a name may never
 *      PREVENT one, and for three months that reading was the code: this file
 *      contained no name logic of any kind, so the content fallback linked
 *      "Marcus Ord" to a saved contact called "Priya Raman" on the strength of a
 *      shared office line, silently, and copied Marcus's addresses onto Priya as
 *      it went. See the section on the name veto below.
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
 * for that source is ALREADY ESTABLISHED AND STILL CURRENT:
 *
 *   - Contact has NO link for this source            -> apply (C10: pre-crosswalk contact)
 *   - Contact's existing link points at a record the
 *     LATEST SYNC DID NOT RETURN                     -> apply (C6: device swap, ids all changed)
 *   - Contact's existing link points at a DIFFERENT
 *     record the latest sync DID return              -> FLAG (C8/C9, and the
 *                                                      two-address-book duplicate)
 *
 * The third case is the only one where two current records of the same source
 * both want the same contact, which is precisely a human decision.
 *
 * "the latest sync did not return it" is decided by `sourceRecordIsCurrent`,
 * NOT by whether the row still exists — see that function for why. Two of the
 * five sources never prune, so existence proves nothing for them.
 *
 * Case C7 — both people still present with their own ids — never reaches any of
 * this: both resolve at step 1 and the content fallback never fires at all.
 *
 * ===========================================================================
 * WHAT "FLAGGED" MEANS — BACKLOG-2410 GAVE IT SOMEWHERE TO GO
 * ===========================================================================
 * The link is NOT created, the conflict is counted in the ingestion funnel, it
 * is returned to the caller, AND it is written to the contact-level review queue
 * (`contact_link_proposals`) with its evidence in words. Before BACKLOG-2410 the
 * last of those did not exist: a flag was counted, logged, and then nothing
 * happened, so the one band where a human adds information was discarded on
 * every sync.
 *
 * The queue write is best-effort and never throws into a sync — a sync that
 * succeeded must not be reported as failed because a question could not be
 * filed, and the next pass re-files it.
 *
 * ===========================================================================
 * THE NAME VETO — BACKLOG-2619 / BACKLOG-2624
 * ===========================================================================
 * The picker has always gated phone-based dedup on name compatibility. This
 * module never did, and the two layers therefore answered the same question
 * differently: `contacts:get-available` showed Marcus Ord and Priya Raman as two
 * separate people, correctly, while `resolveSourceRecord` merged them.
 *
 * `nameSupportForAutoLink` is consulted LAST, immediately before the link is
 * written, and it can only ever turn a would-be SILENT LINK into a QUESTION:
 *
 *   - it is not consulted at STEP 1 at all. A source-id match is knowledge, and
 *     a person who renames a card in Contacts.app must not be re-asked about it;
 *   - it runs AFTER the conflict and frozen-audit branches, so every match those
 *     already withhold keeps its own, more specific reason;
 *   - it adds no link anywhere. It is purely subtractive on the act band.
 *
 * A MISSING NAME IS ASK, NOT ACT (BACKLOG-2624). `namesAreCompatible("", x)` is
 * TRUE — an empty name cannot contradict — which would disable the veto for
 * precisely the records with the least evidence behind them. The guard module
 * states that rule, together with what else counts as "no name": the "Unknown"
 * literal five live paths still write, and the email/phone label
 * `buildContactLabel` bakes into a nameless record's name field.
 *
 * ===========================================================================
 * A REJECTED PAIR IS NEVER LINKED AND NEVER RE-ASKED
 * ===========================================================================
 * `hasCannotLink` is consulted BEFORE this module links or proposes anything on
 * the content path. A `different_people` verdict — recorded by the review queue,
 * or by unlinking a source on the contact's provenance panel — is a hard
 * constraint that outlives the rule that produced the original suggestion.
 *
 * IT MUST BAR THE LINK, NOT MERELY THE QUESTION. Suppressing only the re-ask
 * would leave the pair free to be silently LINKED the next time any rule reaches
 * it by another route, which is a worse outcome than the nagging it prevents.
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
import { createLink, getLinksForContactBySource } from "./db/contactSourceLinkDbService";
import {
  liveContactMatchIndex,
  loadContactMatchIndex,
  type ContactMatchIndex,
} from "./db/contactMatchIndex";
import { hasCannotLink, proposeLink } from "./db/contactLinkReviewDbService";
import { ORIGIN_MATCH_METHOD } from "./db/contactIdentitySchemaSql";
import { isContactOnFrozenTransaction } from "./db/frozenContactDbService";
import { buildEvidence, sourceRecordName } from "./contactLinkEvidence";
import { tryGatherIdentityEvidence } from "./contactIdentityEvidence";
import { applyLinkedSourceValues } from "./contactSourceValues";
import { toMatchingKey } from "../utils/phoneNormalization";
import { realContactName } from "../utils/contactDisplayLabel";
import { nameSupportForAutoLink } from "../utils/autoLinkNameGuard";
import logService from "./logService";

/** A source record offered for linking. */
export interface SourceRecordCandidate {
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  /** macOS ZEXTERNALUUID. Captured, never matched on (portability unverified). */
  externalUuid?: string | null;
  emails?: string[];
  phones?: string[];
  /**
   * The record's name, for the VETO only — never to match on (BACKLOG-2619).
   *
   * OPTIONAL, AND THE OMISSION IS NOT A BYPASS. A caller that leaves it out gets
   * the name read from `external_contacts` instead (see `resolveSourceRecord`),
   * so the guard cannot be switched off by forgetting a field — which is exactly
   * how the `sourceRecordIsCurrent` precondition went quietly dead for one source
   * and is documented at length below.
   */
  name?: string | null;
}

/**
 * Why a content match was withheld. Recorded distinguishably because the causes
 * have different remedies, and because "how a link came to be" cannot be
 * reconstructed after the fact — the same argument that put `match_method` on
 * the crosswalk row.
 */
export type FlagReason =
  /**
   * The identifier has MOVED between people: the incumbent source record no
   * longer carries it. The Daniel/Lilly case. Genuinely suspect.
   */
  | "identifier_reassigned"
  /**
   * ONE PERSON IN TWO PLACES within a single source — both records still assert
   * the identifier. Routine once BACKLOG-2392 reads every address book (iCloud
   * + Exchange). Benign; the linking policy for it belongs to BACKLOG-2370.
   */
  | "duplicate_source_record"
  /** The identifier is held by more than one saved contact; picking is guessing. */
  | "ambiguous_identifier"
  /** The candidate contact is referenced by an exported (frozen) audit. */
  | "frozen_audit_contact"
  /**
   * BACKLOG-2619 — the identifier is shared, but the two are saved under names
   * that disagree. The office line, the household, the reassigned number.
   */
  | "name_mismatch"
  /**
   * BACKLOG-2624 — the identifier is shared and one of the two has no name to
   * check it against. Absence of evidence, not evidence of a match.
   */
  | "name_unknown";

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
      reason: FlagReason;
    }
  /**
   * BACKLOG-2410 — the user has already said these are different people.
   *
   * Distinct from `no_match` (nothing matched) and from `flagged` (we do not
   * know): here we DO know, because we were told. Reporting it as `no_match`
   * would lose the distinction between "never asked" and "asked and answered",
   * which is the same "nothing found vs never looked" ambiguity that runs
   * through this whole epic.
   */
  | {
      outcome: "declined";
      sourceRecordId: string;
      contactId: string;
      matchedOn: "email" | "phone";
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
  /**
   * BACKLOG-2410 — content matches refused because the user has already said
   * "different people". Counted separately from `unmatched` so the funnel can
   * tell a question nobody has been asked from one that has been answered.
   */
  declined: number;
  resolutions: LinkResolution[];
}

/**
 * Is this contact referenced by an EXPORTED (frozen) transaction?
 *
 * MOVED to `db/frozenContactDbService.ts` (BACKLOG-2427) and re-exported here so
 * every existing import keeps working. It now has a second caller —
 * `contactSourceValues`, which refuses to REMOVE an address from a contact an
 * exported document depends on — and this module imports that one, so leaving
 * the predicate here would have made the two require each other.
 */
export { isContactOnFrozenTransaction };

/**
 * ===========================================================================
 * THE THREE PROBES MOVED TO `db/contactMatchIndex.ts` — BACKLOG-2620
 * ===========================================================================
 * `contactIdsByEmail`, `contactIdsByPhone` and the crosswalk lookup used to
 * live here as three per-record queries. They now sit behind a
 * `ContactMatchIndex`, which has two implementations:
 *
 *   - the LIVE one, one statement per probe — what `resolveSourceRecord` uses
 *     when it is called for a single record, which is unchanged behaviour;
 *   - the BATCH one, which reads each relation ONCE for a whole pass.
 *
 * The queries themselves are transcribed verbatim into that module, including
 * the unary `+c.user_id` from BACKLOG-2621 and the reasoning for it.
 *
 * WHY: this module fed every row of `external_contacts` to a per-record
 * resolver on every sync, and 1,153 of the founder's 1,169 records matched
 * nothing and so paid three statements each, every pass, permanently. Read
 * `contactMatchIndex.ts`'s header for why the fix is batch recomputation rather
 * than a remembered "no match".
 */

/**
 * Does this source record still carry any of `values` in its email/phone list?
 *
 * Used only to CLASSIFY a withheld link (see the call site): an incumbent that
 * still holds the matched identifier is a duplicate of the same person; one that
 * no longer holds it has had that identifier move away to someone else.
 * Comparison mirrors the matching queries — lowercased email, last-10 phone key.
 */
function sourceRecordCarriesIdentifier(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
  kind: "email" | "phone",
  values: string[],
): boolean {
  const row = dbGet<{ emails_json: string | null; phones_json: string | null }>(
    `SELECT emails_json, phones_json FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`,
    [userId, sourceType, sourceRecordId],
  );
  if (!row) return false;

  if (kind === "email") {
    const held = new Set(safeJsonArray(row.emails_json).map((e) => e.trim().toLowerCase()));
    return values.some((v) => v && held.has(v.trim().toLowerCase()));
  }
  // BACKLOG-2630 slice 1 / BACKLOG-2754: `toMatchingKey` on BOTH sides. This is
  // the content fallback that decides a source record and a contact are the same
  // person on a shared identifier alone, so a below-floor value — an extension,
  // a fragment — must not be able to carry that decision. Both sides use the
  // same function: flooring only one would silently make the comparison
  // asymmetric.
  const held = new Set(safeJsonArray(row.phones_json).map((ph) => toMatchingKey(ph)));
  return values.some((v) => {
    const key = toMatchingKey(v);
    return key.length > 0 && held.has(key);
  });
}

/**
 * Was `sourceRecordId` present in the MOST RECENT sync of this source?
 *
 * ===========================================================================
 * WHY THIS IS NOT "does the row still exist" — BACKLOG-2401 SR review
 * ===========================================================================
 * The first version asked only whether the shadow row was still there, on the
 * stated precondition that "external_contacts IS the current source set — a
 * sync rewrites it and prunes records the source no longer returns."
 *
 * THAT PRECONDITION IS FALSE FOR TWO OF THE FIVE SOURCES:
 *
 *   macos            fullSync -> deleteStaleContactsBySource   PRUNES
 *   outlook          syncOutlookContacts -> same               PRUNES
 *   google_contacts  syncGoogleContacts -> same                PRUNES
 *   android_sync     prunes ONLY on a full snapshot; an incremental
 *                    diff is upsert-only                       PARTIAL
 *   iphone           deleteStaleIPhoneContacts EXISTS AND HAS
 *                    ZERO CALLERS (BACKLOG-2396);
 *                    iPhoneSyncStorageService only upserts     NEVER PRUNES
 *
 * So for `iphone` the old row lives forever, "still exists" was permanently
 * true, and the device-swap branch was STRUCTURALLY UNREACHABLE for the source
 * the task body names as the worst case. A user with a new iPhone had every
 * contact flagged instead of re-linked — and flagged has no review queue, so
 * the flags were dropped and their saved contacts silently stopped updating.
 *
 * ===========================================================================
 * THE FIX: ask the question THE PRUNE ITSELF ASKS
 * ===========================================================================
 * `deleteStaleContactsBySource` is literally
 *     DELETE ... WHERE source = ? AND synced_at < <this sync's start>
 * so `synced_at` is already this codebase's canonical "was this record present
 * in the latest sync" marker, and the highest value per source is that sync's
 * watermark.
 *
 * Testing `synced_at = MAX(synced_at)` therefore asks "would the prune have
 * kept this row?", which is the question that was meant all along:
 *   - for a pruning source it agrees with existence, because stale rows are
 *     already gone and every survivor carries the watermark;
 *   - for a non-pruning source it gives the right answer anyway, WITHOUT
 *     changing any sync's behaviour.
 *
 * That last point is why this was chosen over wiring up the dead iPhone prune:
 * making the precondition true would change iPhone sync behaviour and collide
 * with BACKLOG-2396, which is not this task's to ship.
 *
 * ===========================================================================
 * THE PRECONDITION THIS DEPENDS ON — **NOT A UNIVERSAL**, do not read it as one
 * ===========================================================================
 * The rule is only as good as the stamping underneath it. It requires that
 *
 *     EVERY record the source still returns carries the LATEST stamp
 *     for that source.
 *
 * A FULL sync satisfies this by construction: it upserts everything the source
 * returned, and one `const now = new Date().toISOString()` per call stamps the
 * whole batch. An INCREMENTAL diff does NOT — it upserts only what CHANGED, so
 * unchanged rows keep an older stamp and read as "not current" even though the
 * source still returns them. For such a source this guard is not merely weaker,
 * it is STRUCTURALLY DISABLED between full snapshots, and it fails in the BAD
 * direction: a withheld link becomes a silently WRONG link, into a table with
 * no unlink UI. (An earlier revision of this comment asserted the batch-stamp
 * property of "every upsert path" as a universal. It was not one, and that
 * false universal is exactly how this bug would be rebuilt.)
 *
 * One path here is incremental — `android_sync` in `localSyncService`
 * (BACKLOG-2208: upsert-only, deliberately no prune). It is made to satisfy the
 * precondition by calling `externalContactDbService.markSourceRecordsCurrent`
 * immediately after its upsert, re-stamping every row of that source. THAT CALL
 * IS LOAD-BEARING FOR CORRECTNESS HERE, not bookkeeping.
 *
 * IF YOU ADD AN INCREMENTAL OR PARTIAL SYNC PATH FOR ANY SOURCE, it must do the
 * same, or this guard goes quietly dead for that source. No predicate over
 * `external_contacts` alone can detect the difference: "unchanged, still there"
 * and "gone from the source" are byte-identical in the shadow table. The rule is
 * right; what it needs is for the data beneath it to be complete.
 *
 * A NULL `synced_at` (a legacy row no sync has refreshed) is treated as
 * CURRENT: freshness cannot be established, and the safe direction is to
 * withhold a link rather than create a wrong one.
 */
function sourceRecordIsCurrent(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const row = dbGet<{ hit: number }>(
    `SELECT 1 AS hit FROM external_contacts ec
      WHERE ec.user_id = ? AND ec.source = ? AND ec.external_record_id = ?
        AND (
          ec.synced_at IS NULL
          OR ec.synced_at = (
            SELECT MAX(w.synced_at) FROM external_contacts w
             WHERE w.user_id = ec.user_id AND w.source = ec.source
          )
        )
      LIMIT 1`,
    [userId, sourceType, sourceRecordId],
  );
  return row !== undefined && row !== null;
}

/**
 * File a withheld match as a question, with its evidence in words.
 *
 * NEVER THROWS. A sync that succeeded must not be reported as failed because a
 * question could not be filed, and the pass is idempotent — the pair is re-offered
 * on the next sync, where `proposeLink`'s INSERT OR IGNORE makes a retry free.
 * This is the same stance `runOpportunisticLinking` takes one level up, for the
 * same reason.
 */
function recordProposal(args: {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  reason: FlagReason;
  matchedOn: "email" | "phone";
  matchedValues: string[];
  clusterKey: string;
  relatedContactIds?: string[];
}): void {
  try {
    const built = buildEvidence({
      userId: args.userId,
      contactId: args.contactId,
      sourceType: args.sourceType,
      sourceRecordId: args.sourceRecordId,
      reason: args.reason,
      matchedOn: args.matchedOn,
      matchedValues: args.matchedValues,
      relatedContactIds: args.relatedContactIds ?? [],
    });
    // BACKLOG-2630 D2 piece 2 — the FACTS behind the sentence, frozen alongside
    // it. This changes NO DECISION: the gatherer is read-only and its output is
    // consulted by nothing in this file. The branches above chose this pair, and
    // they choose it identically with or without the facts. Wiring it here rather
    // than in D3 is deliberate — it exercises the gatherer on every existing
    // production path while changing nothing, so the matcher inherits a substrate
    // that has already run.
    //
    // `nameHolderCount` is absent on purpose: an identifier match has no name
    // tally, and `null` says "not computed", never "zero".
    const facts = tryGatherIdentityEvidence({
      userId: args.userId,
      subject: { kind: "contact", contactId: args.contactId },
      candidate: {
        kind: "record",
        sourceType: args.sourceType,
        sourceRecordId: args.sourceRecordId,
      },
    });
    proposeLink({
      userId: args.userId,
      contactId: args.contactId,
      sourceType: args.sourceType,
      sourceRecordId: args.sourceRecordId,
      reason: args.reason,
      matchedOn: args.matchedOn,
      identityAssessment: built.identityAssessment,
      relationshipAssessment: built.relationshipAssessment,
      clusterKey: args.clusterKey,
      evidence: { ...built.evidence, facts },
    });
  } catch (error) {
    logService.warn(
      `[Contacts] could not file a link review question: ${error}`,
      "Contacts",
    );
  }
}

/**
 * The saved contact's `display_name`, raw.
 *
 * DELIBERATELY NOT `contactLinkEvidence.contactDisplayName`, which substitutes
 * the words "this contact" when the column is empty. That substitution is
 * correct for a sentence and catastrophic for a comparison: it would turn every
 * nameless contact into one called "this contact", and two of them would then
 * read as an exact name match. The guard needs the truth, including its absence.
 */
function savedContactName(contactId: string): string | null {
  const row = dbGet<{ display_name: string | null }>(
    `SELECT display_name FROM contacts WHERE id = ?`,
    [contactId],
  );
  return row?.display_name ?? null;
}

/**
 * Resolve ONE source record to a contact, applying the full matching order.
 *
 * Pure decision + at most one INSERT. Never deletes, never re-points, never
 * touches the contact row.
 *
 * `index` (BACKLOG-2620) is where the three identifier probes come from. Omit
 * it and every probe is a live query, which is what a single-record caller
 * wants; `linkSourceRecords` passes a batch index it loaded once for the whole
 * pass. The two are pinned to identical answers by the parity control in
 * `contactSourceLinker.convergence-2620.test.ts`.
 */
export function resolveSourceRecord(
  userId: string,
  candidate: SourceRecordCandidate,
  index: ContactMatchIndex = liveContactMatchIndex(),
): LinkResolution {
  const { sourceType, sourceRecordId, externalUuid = null } = candidate;

  // ---- STEP 1: source id. Always wins. -----------------------------------
  const linkedRecord = index.linkedRecord(userId, sourceType, sourceRecordId);
  const linkedContactId = linkedRecord?.contactId ?? null;
  if (linkedContactId) {
    // Opportunistically capture the portable identifier on a row that predates
    // it. Does not change the link or how it was made.
    //
    // THIS CALL DELIBERATELY DOES NOT SET `assertMethod` (BACKLOG-2419). The
    // `source_id` below describes THE CALL — "found by looking the record up by
    // its id" — not how the LINK was made; the pair is already linked, by
    // whatever rule made it. Asserting it here would relabel every
    // content-matched link as `source_id` on the next sync pass, which prints a
    // more certain provenance sentence than the truth AND, through
    // `contactSourceAffordances.isAttachedSource`, withdraws the Unlink button
    // and the whole Sources panel from single-source contacts. See the
    // `assertMethod` docblock in contactSourceLinkDbService.ts.
    //
    // BACKLOG-2620 — AND ONLY WHEN IT WOULD ADD SOMETHING. `createLink` on an
    // existing row is a SELECT plus, when a uuid is supplied, an UPDATE whose
    // `external_uuid` is COALESCE'd: on a row that already carries one the
    // write changes nothing but `updated_at`, which no query in this repo
    // reads. Skipping it removes two statements INCLUDING A WRITE per
    // id-matched record per pass — and in the healthy steady state every record
    // is id-matched, so that is the cost this feature settles into.
    if (externalUuid && !linkedRecord?.hasExternalUuid) {
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
  const byEmail = index.contactIdsByEmail(userId, candidate.emails ?? []);
  const byPhone = byEmail.length > 0 ? [] : index.contactIdsByPhone(userId, candidate.phones ?? []);
  const matchedOn: "email" | "phone" = byEmail.length > 0 ? "email" : "phone";
  const allMatches = byEmail.length > 0 ? byEmail : byPhone;
  const matchedValues = matchedOn === "email" ? (candidate.emails ?? []) : (candidate.phones ?? []);

  if (allMatches.length === 0) {
    return { outcome: "no_match", sourceRecordId };
  }

  // ---- BACKLOG-2410: honour the user's own answers before anything else. ----
  //
  // A `different_people` verdict removes that contact from consideration
  // entirely — it is not a tiebreaker, it is a deletion from the candidate set.
  // Doing it HERE, before the ambiguity test, means a rejection is not merely
  // remembered but USEFUL: rejecting one of two contacts that share a phone
  // number leaves one candidate, and the record can finally be resolved instead
  // of being flagged forever.
  const matches = allMatches.filter(
    (contactId) => !hasCannotLink(userId, contactId, sourceType, sourceRecordId),
  );

  if (matches.length === 0) {
    // Everything this record could have matched has been ruled out by hand.
    //
    // `contactId` names `allMatches[0]` — AN ARBITRARY PICK when several
    // candidates were each rejected, because there is no "the" contact to name.
    // Nothing consumes the field today (the funnel counts declines; the queue
    // reads verdicts), and the honest alternative would be to return the whole
    // set. Kept as one id for shape-compatibility with the other outcomes; if a
    // caller ever needs to know WHICH contacts were ruled out, widen it rather
    // than trusting this one.
    return { outcome: "declined", sourceRecordId, contactId: allMatches[0], matchedOn };
  }

  // An identifier shared by several saved contacts cannot pick one of them
  // without guessing, and guessing is what this design refuses to do.
  if (matches.length > 1) {
    // Every candidate is offered, sharing ONE cluster key, so the user answers
    // "which of these is it?" once rather than being asked the same question
    // once per candidate. The resolution still names matches[0] — the caller's
    // contract from BACKLOG-2401 is one resolution per record, and the queue,
    // not the resolution, is where the full candidate set lives.
    const clusterKey = `record:${sourceType}:${sourceRecordId}`;
    for (const contactId of matches) {
      recordProposal({
        userId,
        contactId,
        sourceType,
        sourceRecordId,
        reason: "ambiguous_identifier",
        matchedOn,
        matchedValues,
        clusterKey,
        // The rival candidates. If two of them are a buyer and a seller on one
        // deal, the queue must say CONNECTED and DIFFERENT PEOPLE rather than
        // letting the shared identifier read as evidence of sameness.
        relatedContactIds: matches.filter((id) => id !== contactId),
      });
    }
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId: matches[0],
      conflictingSourceRecordId: "",
      matchedOn,
      reason: "ambiguous_identifier",
    };
  }

  const candidateContactId = matches[0];

  // ---- STEP 3: is another record of this source already claiming them? ----
  const existingLinks = getLinksForContactBySource(candidateContactId, sourceType);
  const liveConflict = existingLinks.find(
    (l) =>
      // BACKLOG-2473 — an ORIGIN row is not a claim on a source record, so it
      // cannot conflict with one. It reaches this list at all because a
      // `contacts_app`/`iphone`/`outlook` contact's origin row carries the same
      // external spelling in `source_type`.
      //
      // EXPLICIT, NOT INCIDENTAL. Today `sourceRecordIsCurrent` below already
      // excludes it, because `origin:<contactId>` matches nothing in
      // `external_contacts` — but that is a lucky consequence of an unrelated
      // lookup, not a decision. Relax or reorder that check and every
      // address-book contact created through `contacts:create` starts being
      // reported as a reassignment conflict against itself. One line, and it
      // does not depend on another function's failure mode.
      l.match_method !== ORIGIN_MATCH_METHOD &&
      l.source_record_id !== sourceRecordId &&
      sourceRecordIsCurrent(userId, sourceType, l.source_record_id),
  );
  if (liveConflict) {
    // WHICH conflict this is, is knowable — and by this task's own principle
    // (how a link was made cannot be reconstructed later) it must be recorded
    // now, even though the policy for one of them is deferred to BACKLOG-2370.
    //
    // The discriminator is whether the INCUMBENT record still carries the
    // identifier we matched on:
    //
    //   still carries it -> both records assert the same identifier for the
    //     same person. That is ONE PERSON IN TWO PLACES within a single source
    //     — the iCloud + Exchange case that BACKLOG-2392's every-address-book
    //     read makes routine. Benign, and emphatically not a reassignment.
    //
    //   no longer carries it -> the identifier has MOVED from the incumbent to
    //     this record. That is the Daniel/Lilly case: Daniel's saved contact
    //     still holds the number from the first import, but Daniel's own source
    //     record no longer does, because it is now Lilly's.
    //
    // Both are withheld. Labelling them the same would poison the funnel and
    // any future review queue with benign duplicates.
    const incumbentStillHoldsIdentifier = sourceRecordCarriesIdentifier(
      userId,
      sourceType,
      liveConflict.source_record_id,
      matchedOn,
      matchedOn === "email" ? (candidate.emails ?? []) : (candidate.phones ?? []),
    );
    const reason: FlagReason = incumbentStillHoldsIdentifier
      ? "duplicate_source_record"
      : "identifier_reassigned";

    logService.info(
      `[Contacts] link withheld for review (${reason}): a second ${sourceType} record ` +
        `content-matched a contact whose ${sourceType} identity is already current`,
      "Contacts",
    );
    recordProposal({
      userId,
      contactId: candidateContactId,
      sourceType,
      sourceRecordId,
      reason,
      matchedOn,
      matchedValues,
      // One contact, several source records wanting to be it: one question.
      clusterKey: `contact:${candidateContactId}`,
    });
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId,
      conflictingSourceRecordId: liveConflict.source_record_id,
      matchedOn,
      reason,
    };
  }

  // Belt-and-braces: never let the fallback bind a contact an exported audit
  // depends on. Per the in-place rule those contacts always have an id match,
  // so reaching here means an assumption broke — withhold rather than guess.
  if (isContactOnFrozenTransaction(candidateContactId)) {
    recordProposal({
      userId,
      contactId: candidateContactId,
      sourceType,
      sourceRecordId,
      reason: "frozen_audit_contact",
      matchedOn,
      matchedValues,
      clusterKey: `contact:${candidateContactId}`,
    });
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId,
      conflictingSourceRecordId: "",
      matchedOn,
      reason: "frozen_audit_contact",
    };
  }

  // ---- STEP 4: the names have to agree. BACKLOG-2619 / BACKLOG-2624. -------
  //
  // Everything above this line decided that ONE saved contact holds the
  // identifier this record carries, that nobody has ruled the pair out, that no
  // other current record of this source is claiming that contact, and that no
  // exported audit depends on them. All of which is true of Marcus Ord and Priya
  // Raman, who are not the same person and merely share an office line.
  //
  // The record's own name is preferred, but a candidate that carries none falls
  // back to the shadow table rather than to a free pass — see the field's
  // docblock. `realContactName` is applied first so a candidate carrying the
  // "Unknown" literal consults the row too, instead of being taken at its word.
  const recordName =
    realContactName(candidate.name) ||
    sourceRecordName(userId, sourceType, sourceRecordId);

  const nameSupport = nameSupportForAutoLink({
    recordName,
    contactName: savedContactName(candidateContactId),
    // The record's own identifiers, so a label baked out of one of them is
    // recognised as the absence of a name rather than read as one.
    identifiers: { emails: candidate.emails, phones: candidate.phones },
  });

  if (!nameSupport.supportsLink) {
    logService.info(
      `[Contacts] link withheld for review (${nameSupport.reason}): a ${sourceType} record ` +
        `content-matched a contact on ${matchedOn}, but the names do not support linking them`,
      "Contacts",
    );
    recordProposal({
      userId,
      contactId: candidateContactId,
      sourceType,
      sourceRecordId,
      reason: nameSupport.reason,
      matchedOn,
      matchedValues,
      // One contact, several source records wanting to be it: one question.
      clusterKey: `contact:${candidateContactId}`,
    });
    return {
      outcome: "flagged",
      sourceRecordId,
      candidateContactId,
      // No incumbent record is involved — nothing else is claiming this contact.
      // The other single-pair branches (`ambiguous_identifier`,
      // `frozen_audit_contact`) report the same empty string for the same reason.
      conflictingSourceRecordId: "",
      matchedOn,
      reason: nameSupport.reason,
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

  // BACKLOG-2423 — the copy happens AT THE LINK, not at the next app start.
  //
  // The session-gated `backfillImportedContactsFromExternal` used to be the only
  // thing that moved a source's addresses onto a contact, and it runs once per
  // user per session. A source linked after it had run contributed nothing until
  // the next launch: a transaction created in that window swept an incomplete
  // address set, and nothing re-swept when the addresses later arrived.
  applyLinkedSourceValues(userId, candidateContactId);

  // BACKLOG-2620 — THE COPY ABOVE JUST CHANGED A RELATION THE INDEX IS BUILT
  // FROM, and a later record in this same pass may legitimately match this
  // contact through an address the pass itself added. With per-record queries
  // that came for free; with a batch index it has to be said. This is the only
  // in-pass invalidation there is: linking writes crosswalk rows, review-queue
  // rows and these values, and only these values are read by the index.
  index.noteContactValuesChanged(candidateContactId);

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
 *
 * BACKLOG-2620 — the identifier probes come from ONE `ContactMatchIndex` loaded
 * for the whole batch, so their SQL cost is four statements for the pass rather
 * than three per record. Pass an index in to share one across several batches;
 * the default loads a fresh one, which is what makes every pass see the current
 * contact set rather than a remembered verdict.
 */
export function linkSourceRecords(
  userId: string,
  candidates: SourceRecordCandidate[],
  index: ContactMatchIndex = loadContactMatchIndex(userId),
): LinkRunSummary {
  const summary: LinkRunSummary = {
    idMatched: 0,
    contentMatched: 0,
    flagged: 0,
    unmatched: 0,
    declined: 0,
    resolutions: [],
  };

  for (const candidate of candidates) {
    if (!candidate.sourceRecordId) continue;
    const resolution = resolveSourceRecord(userId, candidate, index);
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
      case "declined":
        summary.declined++;
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
 * candidate.
 *
 * ===========================================================================
 * THE COST MODEL — the old one here was FALSE, and BACKLOG-2620 is the bill
 * ===========================================================================
 * This docblock used to say: "Records already claimed by the crosswalk resolve
 * on one indexed lookup and cost nothing more; only the genuinely unlinked ones
 * reach the content fallback, AND ONLY UNTIL THEY CONVERGE."
 *
 * The last clause was wrong, and it was wrong in the direction that hurts. A
 * record that matches nothing has nothing written about it, so it converges on
 * nothing: it re-enters the content fallback on the next pass and on every pass
 * after, forever. The founder's log at `71ddcbb0` — 1,169 records, 10
 * id-matched, 1,153 unmatched — is 1,153 records paying three statements each
 * per pass, and passes are frequent.
 *
 * What is true now: the pass reads its three relations ONCE
 * (`loadContactMatchIndex`), so the identifier SQL is **four statements per
 * pass, independent of how many records match nothing**. Records still all get
 * looked at — the per-record work is a `Map.get`, not a query. Nothing is
 * remembered between passes, which is deliberate: a remembered "no match" is
 * only correct with an invalidation signal, and the honest ones cost as much as
 * simply reading the data again. `contactMatchIndex.ts` argues that out in full.
 */
export function linkExternalContactsForUser(userId: string): LinkRunSummary {
  const rows = dbAll<{
    external_record_id: string;
    source: ExternalContactSource;
    name: string | null;
    emails_json: string | null;
    phones_json: string | null;
    external_uuid: string | null;
  }>(
    // BACKLOG-2619 added `name`, for the veto only. It is never matched on.
    `SELECT external_record_id, source, name, emails_json, phones_json, external_uuid
       FROM external_contacts
      WHERE user_id = ? AND external_record_id IS NOT NULL
      ORDER BY source, external_record_id`,
    [userId],
  );

  const candidates: SourceRecordCandidate[] = rows.map((r) => ({
    sourceType: r.source,
    sourceRecordId: r.external_record_id,
    externalUuid: r.external_uuid,
    name: r.name,
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
