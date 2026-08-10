/**
 * Manual linking — "these two ARE the same person", said by a human
 * (BACKLOG-2426, with the `match_method` upgrade of BACKLOG-2419)
 *
 * ===========================================================================
 * THE ASYMMETRY THIS CLOSES
 * ===========================================================================
 * BACKLOG-2410 shipped `Unlink`: a user can say "these are NOT the same
 * person". Nothing anywhere said the opposite. Every link was machine-asserted
 * and the human could only veto — so a contact and an address-book record that
 * no rule connected (different name, no shared identifier) stayed two rows
 * forever, and every `Unlink` was irreversible in practice.
 *
 * Founder, 2026-08-02: *"we need the option to manually link contacts by
 * selecting one contact and ... search for other contacts to link it with"*.
 *
 * `match_method` has permitted `'manual'` since the crosswalk was created, in
 * both the schema CHECK and the TS union. Nothing wrote it from a user action.
 * Designed for, never built.
 *
 * ===========================================================================
 * SCOPE: A SAVED CONTACT + AN UNCLAIMED SOURCE RECORD. THAT IS ALL.
 * ===========================================================================
 * This is additive, destroys nothing, and is exactly what the crosswalk writes
 * automatically. `UNIQUE (user_id, source_type, source_record_id)` already
 * guarantees a source record belongs to at most one contact, so the only
 * precondition is that the target is unclaimed.
 *
 * MERGING TWO SAVED CONTACTS IS OUT OF SCOPE AND MUST STAY OUT. Both contacts
 * are real, both may have transaction history, and both may appear on exported
 * audits where a retroactively changed party set contradicts a filed document.
 * There is no contact-merge implementation anywhere in the desktop app and the
 * founder has not designed one. `linkSourceRecordToContact` REFUSES a claimed
 * record and names the incumbent; it never re-points. **If a re-point appears
 * here, that is the bug.**
 *
 * ===========================================================================
 * UNGATED, ON EVERY PLAN
 * ===========================================================================
 * Founder: *"if a user wants to manually link contact one by one they can on
 * any version, no gate protects."* There is no entitlement check in this file
 * and there must not be one. The AUTOMATIC side is gated (BACKLOG-2556); that
 * is different work and no code here touches matching or auto-detection.
 *
 * ===========================================================================
 * WHY THE WRITE IS TRANSACTIONAL, AND WHY CI CANNOT TELL YOU THAT
 * ===========================================================================
 * `linkSourceRecordToContact` writes a verdict, then a link, then copies the
 * record's addresses onto the contact. A crash between the verdict and the link
 * would leave a `same_person` verdict for a pair that is not linked — the
 * matcher would then believe the user had confirmed something the card does not
 * show.
 *
 * `writeAtomicity.guard.test.ts` (BACKLOG-2530) would catch a missing
 * `dbTransaction` — but its `DB_DIR` is `electron/services/db`, and this file is
 * a COMPOSITION service, alongside `contactLinkReview.ts` and
 * `contactProvenance.ts`, which are outside that scan for the same reason. The
 * layering is deliberate: `db/` is the data layer, and the business-rule
 * refusals below (tombstoned target, prior rejection, claimed by another) belong
 * above it. A guard's directory constant must not dictate architecture.
 *
 * The consequence is stated rather than hidden: `contactManualLink.rollback.test.ts`
 * is the ONLY check that the transaction is here. It covers removal of
 * `dbTransaction` from this function as written; it does NOT cover a new
 * multi-write added to this file later without its own crash test. Widening the
 * guard to composition services is BACKLOG-2584.
 */

import { dbGet, dbTransaction } from "./db/core/dbConnection";
import { ACTIVE_CONTACTS_CLAUSE_UNALIASED } from "./db/contactTombstoneSql";
import {
  createLink,
  findContactIdBySourceRecord,
  getLinkedSourceKeys,
  sourceKey,
} from "./db/contactSourceLinkDbService";
import {
  getLatestVerdict,
  listPendingProposals,
  recordVerdict,
  resolveProposal,
} from "./db/contactLinkReviewDbService";
import {
  getAllForUser,
  search as searchExternalContacts,
  type ExternalContact,
  type ExternalContactSource,
} from "./db/externalContactDbService";
import { applyLinkedSourceValues } from "./contactSourceValues";
import { sourceLabel } from "./contactLinkEvidence";
import logService from "./logService";

/**
 * `contacts.source` and `contact_source_links.source_type` are DIFFERENT
 * vocabularies — macOS is `'contacts_app'` in the first and `'macos'` in the
 * second — and only the second is valid here. An unrecognised value is refused
 * rather than written, because the CHECK constraint would reject it anyway and
 * a refusal names the problem where a constraint violation does not.
 *
 * `external_contacts.source` is `TEXT DEFAULT 'macos'` with no CHECK and no NOT
 * NULL, and the db service casts it to the union — so the type is a promise the
 * database does not keep and a null CAN arrive here at runtime.
 */
const EXTERNAL_SOURCE_TYPES: ReadonlySet<string> = new Set<ExternalContactSource>([
  "macos",
  "iphone",
  "outlook",
  "google_contacts",
  "android_sync",
]);

/** A source record the user could attach to a contact by hand. */
export interface LinkableSourceRecord {
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  name: string | null;
  sourceLabel: string;
  emails: string[];
  phones: string[];
  company: string | null;
  lastMessageAt: string | null;
}

/**
 * What happened, as a value rather than an exception.
 *
 * Every refusal below is an ORDINARY outcome the renderer must render, not an
 * error: "that record already belongs to someone else" and "you previously said
 * these were different people" are answers, and throwing for them would make
 * the caller distinguish them by message text.
 */
export type LinkSourceOutcome =
  | { ok: true; linkId: string }
  | { ok: false; reason: "contact_not_found" }
  | { ok: false; reason: "contact_removed" }
  | { ok: false; reason: "record_not_found" }
  | { ok: false; reason: "unknown_source" }
  | { ok: false; reason: "claimed"; incumbentContactId: string }
  | { ok: false; reason: "prior_rejection" };

interface LinkSourceOptions {
  /**
   * The user has been shown the earlier `different_people` verdict and chosen
   * to proceed anyway. BACKLOG-2426 rule 2: a manual link must be able to
   * overturn a prior rejection, AND MUST ASK FIRST — the founder hit this case
   * himself. Without it a mistaken unlink is permanent and unexplained.
   */
  acknowledgedPriorRejection?: boolean;
}

function toLinkable(record: ExternalContact): LinkableSourceRecord {
  return {
    sourceType: record.source,
    sourceRecordId: record.external_record_id,
    name: record.name,
    sourceLabel: sourceLabel(record.source),
    emails: record.emails,
    phones: record.phones,
    company: record.company,
    lastMessageAt: record.last_message_at,
  };
}

/**
 * Source records the user could attach — everything NOT already claimed.
 *
 * "Unclaimed" is `getLinkedSourceKeys`, THE SAME DEFINITION the import picker
 * uses (`contacts:get-available`). Deriving it differently is how a record comes
 * to be offered here and hidden there, or worse, offered in both and then
 * refused by the UNIQUE constraint.
 *
 * KNOWN LIMITATION, deliberately not fixed here (BACKLOG-2585): a record claimed
 * by a TOMBSTONED contact reads as claimed, because `getLinkedSourceKeys` does
 * not filter removed contacts. Such a record is invisible here and cannot be
 * attached to the live contact the user actually wants. Releasing claims on
 * removal is a founder question, not an implementation detail.
 *
 * ===========================================================================
 * NO QUERY, NO LIMIT — AND WHAT THAT COSTS (BACKLOG-2591)
 * ===========================================================================
 * This used to take `(query, limit = 25)` and run a SQL `LIKE` per keystroke.
 * The renderer now filters in memory through `ContactSearchList`, exactly like
 * the transaction pickers, so this returns the WHOLE unclaimed set ONCE per
 * panel open. That kills the per-keystroke IPC and a second search dialect.
 *
 * THE COST IS REAL AND IS STATED RATHER THAN ABSORBED. `getAllForUser` is a
 * plain synchronous `dbAll` with no LIMIT, on the main process, and its own
 * comment cites ~1000 contacts as the working scale. The transaction pickers
 * move the same volume through a WORKER (TASK-1956; `contacts:get-available`
 * was measured at ~3.7s at 1000+ contacts) — this path does not.
 *
 * MEASURED, not assumed: see `contactManualLink.scale.test.ts`, which seeds a
 * realistic address book and records the wall time of one call. If that number
 * ever approaches the worker path's, the mitigation is to move this read behind
 * the same worker rather than to reinstate a limit — a limit would silently
 * hide linkable records, which is the one thing this function may never do.
 */
export function findLinkableSourceRecords(userId: string): LinkableSourceRecord[] {
  const candidates = getAllForUser(userId);
  const claimed = getLinkedSourceKeys(userId);

  const out: LinkableSourceRecord[] = [];
  for (const record of candidates) {
    if (!record.external_record_id) continue;
    if (!record.source || !EXTERNAL_SOURCE_TYPES.has(record.source)) continue;
    if (claimed.has(sourceKey(record.source, record.external_record_id))) continue;
    out.push(toLinkable(record));
  }
  return out;
}

/**
 * Attach one source record to one saved contact, because a human said so.
 *
 * ORDER MATTERS. Every refusal runs BEFORE any write, so a rejected attempt
 * leaves the database exactly as it found it — no verdict, no link, no copied
 * addresses:
 *
 *   1. the contact exists and is not tombstoned;
 *   2. the record exists and its source is one the crosswalk accepts;
 *   3. the record is not already claimed by a DIFFERENT contact (the merge
 *      guard — return the incumbent, never re-point);
 *   4. any prior `different_people` verdict has been shown to the user and
 *      acknowledged;
 *   5. record `same_person`, so a later automatic pass cannot undo this
 *      (`hasMustLink`); no delete is needed, because `recordVerdict` only
 *      appends and `getLatestVerdict` takes the newest;
 *   6. write the link as `manual` — ASSERTED, so it also upgrades a weaker
 *      incumbent method rather than being silently discarded (BACKLOG-2419);
 *   7. copy the record's emails and phones onto the contact NOW, not at the
 *      next app start (BACKLOG-2423) — the same call `confirmProposal` makes;
 *   8. retire any pending question about THIS pair, because the user just
 *      answered it by acting (BACKLOG-2596).
 *
 * ===========================================================================
 * STEP 8 — A LINK MUST NOT LAND WITH ITS OWN QUESTION STILL PENDING
 * ===========================================================================
 * `PENDING_JOIN` (contactLinkReview.ts) selects on `p.status = 'pending'` and
 * reads neither `contact_link_verdicts` nor `contact_source_links`. So writing
 * `same_person` and creating the link left any pending proposal for that pair
 * exactly where it was, and every unit test about verdicts still passed.
 *
 * The state that produced: the user links Pat to a record, the question "are
 * these the same person?" stays on the queue, and answering it later — the only
 * honest answer being *"Not this person"*, since the queue shows no sign the
 * pair is already linked — appends `different_people` and removes NO link.
 * `hasCannotLink` then reports TRUE FOR A LIVE LINK. The matcher believes the
 * pair is barred while the crosswalk holds it, the record reads as released
 * while it is claimed, and the card shows a record its own latest verdict
 * rejects. Two answers to one question, and the app believes both.
 *
 * THIS IS NOT A NEW RULE. `confirmContactSources` (contactCompare.ts, PR D,
 * shipped in #2260) already resolves the pending proposals for the pairs it
 * confirms, in the same transaction, matched by pair. This is that rule
 * reaching the one writer that was missed.
 *
 * SCOPE — ONLY THIS PAIR, and the boundary is the whole point (SR ruling on
 * BACKLOG-2596). Retiring a CLUSTER SIBLING'S question would decide a pair the
 * user never acted on: they attached one record, which says nothing about
 * whether the other candidate is the same person. That is product policy and
 * belongs to the founder. Resolving only what the user actually did is
 * engineering correctness, which is why this could ship without him.
 *
 * MATCHED BY PAIR, NEVER BY CLUSTER KEY. `proposeLink` has two production
 * callers — `resolveSourceRecord` (`cluster_key: record:%`) and
 * `fileNameQuestion` (`name:%`) — so one pair can hold more than one pending
 * question, from different producers. The loop takes every one of them;
 * filtering on a key prefix would silently leave the name-rule question
 * standing, which is the same defect with a smaller blast radius.
 *
 * COUNTED FROM `resolveProposal`'s RETURN VALUE, never from the number of rows
 * examined. It is guarded on `status = 'pending'`, so a concurrent answer in
 * another window resolves it exactly once and this call correctly counts zero.
 *
 * INSIDE THE EXISTING TRANSACTION. A link that commits while its question is
 * still pending IS the state being removed, so the two cannot be separable.
 */
export function linkSourceRecordToContact(
  userId: string,
  contactId: string,
  sourceType: string,
  sourceRecordId: string,
  options: LinkSourceOptions = {},
): LinkSourceOutcome {
  if (!EXTERNAL_SOURCE_TYPES.has(sourceType)) {
    return { ok: false, reason: "unknown_source" };
  }
  const source = sourceType as ExternalContactSource;

  return dbTransaction<LinkSourceOutcome>(() => {
    // ---- 1. The contact exists, and is not tombstoned ----------------------
    // `contactTombstoneSql` states plainly that dedup and matching lookups are
    // NOT tombstone-filtered and that `getContactById` MUST keep returning
    // removed contacts. So nothing upstream stops a link onto a removed
    // contact: it would be invisible in the list, still holding the record, and
    // the UNIQUE constraint would then block the live contact the user wanted.
    // The review queue guards this with its own join; NEW CODE DOES NOT INHERIT
    // THAT, so the filter is spelled out here using the shared clause.
    const contact = dbGet<{ id: string }>(
      `SELECT id FROM contacts WHERE id = ? AND user_id = ?${ACTIVE_CONTACTS_CLAUSE_UNALIASED}`,
      [contactId, userId],
    );
    if (!contact) {
      const exists = dbGet<{ id: string }>(
        `SELECT id FROM contacts WHERE id = ? AND user_id = ?`,
        [contactId, userId],
      );
      return { ok: false, reason: exists ? "contact_removed" : "contact_not_found" };
    }

    // ---- 2. The record exists -------------------------------------------
    const record = dbGet<{ id: string }>(
      `SELECT id FROM external_contacts
        WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`,
      [userId, source, sourceRecordId],
    );
    if (!record) {
      return { ok: false, reason: "record_not_found" };
    }

    // ---- 3. THE MERGE GUARD ---------------------------------------------
    // A record another contact claims is NOT linkable here. Re-pointing it
    // would join two saved contacts, which is out of scope across this whole
    // epic and has no design. Name the incumbent so the renderer can say whose
    // it is rather than failing opaquely.
    const incumbent = findContactIdBySourceRecord(userId, source, sourceRecordId);
    if (incumbent && incumbent !== contactId) {
      return { ok: false, reason: "claimed", incumbentContactId: incumbent };
    }

    // ---- 4. Ask before overturning a rejection ---------------------------
    const latest = getLatestVerdict(userId, contactId, source, sourceRecordId);
    if (latest?.identity_verdict === "different_people" && !options.acknowledgedPriorRejection) {
      return { ok: false, reason: "prior_rejection" };
    }

    // ---- 5. The durable half ---------------------------------------------
    recordVerdict({
      userId,
      contactId,
      sourceType: source,
      sourceRecordId,
      identityVerdict: "same_person",
      reason: "manual_link",
      decidedBy: "manual_link",
    });

    // ---- 6. The visible half ---------------------------------------------
    const link = createLink({
      userId,
      contactId,
      sourceType: source,
      sourceRecordId,
      matchMethod: "manual",
      assertMethod: true,
    });

    // ---- 7. The addresses travel with the record -------------------------
    applyLinkedSourceValues(userId, contactId);

    // ---- 8. The question is answered, so take it off the queue -----------
    // Only this pair. See the header — a sibling's question is the founder's
    // to decide, not this function's.
    let proposalsResolved = 0;
    for (const proposal of listPendingProposals(userId)) {
      if (proposal.contact_id !== contactId) continue;
      if (proposal.source_type !== source) continue;
      if (proposal.source_record_id !== sourceRecordId) continue;
      if (resolveProposal(proposal.id, "confirmed")) proposalsResolved += 1;
    }

    logService.info(
      `[Contacts] manual link: contact ${contactId} <- ${source} record ` +
        `(created=${link.created}, ${proposalsResolved} pending question(s) retired)`,
      "Contacts",
    );

    return { ok: true, linkId: link.id ?? "" };
  });
}

/** One record's identity, as the batch receives it. */
export interface SourceRecordRef {
  sourceType: string;
  sourceRecordId: string;
}

/**
 * Attach SEVERAL source records to one contact (BACKLOG-2591).
 *
 * ===========================================================================
 * A LOOP OF N TRANSACTIONS — NEVER ONE TRANSACTION OVER N RECORDS
 * ===========================================================================
 * Each record goes through `linkSourceRecordToContact`, which opens its OWN
 * `dbTransaction` and keeps its own all-or-nothing guarantee.
 *
 * BE PRECISE ABOUT WHAT THIS BUYS, because the obvious rationale is wrong. A
 * REFUSAL — claimed, tombstoned, prior_rejection — is RETURNED, never thrown,
 * so an outer transaction would commit exactly the same rows. Refusals are not
 * what separates the two shapes, and a control built on one shows no difference
 * (measured: it does not go red).
 *
 * What separates them is a THROW mid-batch: a disk error, a constraint
 * violation, anything genuinely exceptional on record 3 of 5.
 *
 *   - LOOP (this): records 1-2 are already committed and SURVIVE; the throw
 *     propagates and the caller reports a partial result honestly.
 *   - ONE TRANSACTION: records 1-2 are rolled back too. The user picked five
 *     people, four were fine, and they get nothing because the fifth hit a
 *     disk error.
 *
 * `outcomes[i]` corresponds to `records[i]`, SAME ORDER, so the caller can name
 * which record did what without matching on identity.
 *
 * The prior-rejection disclosure is BATCHED by the same property: the first
 * pass returns `prior_rejection` for the affected records and writes nothing
 * for them, while the others link normally. The caller lists them once, asks
 * once, and re-calls with those pairs acknowledged — instead of interrupting
 * the user record by record.
 */
export function linkSourceRecordsToContact(
  userId: string,
  contactId: string,
  records: SourceRecordRef[],
  options: { acknowledgedPriorRejections?: SourceRecordRef[] } = {},
): LinkSourceOutcome[] {
  const acknowledged = new Set(
    (options.acknowledgedPriorRejections ?? []).map(
      (r) => `${r.sourceType}\u0000${r.sourceRecordId}`,
    ),
  );

  return records.map((record) =>
    linkSourceRecordToContact(userId, contactId, record.sourceType, record.sourceRecordId, {
      acknowledgedPriorRejection: acknowledged.has(
        `${record.sourceType}\u0000${record.sourceRecordId}`,
      ),
    }),
  );
}
