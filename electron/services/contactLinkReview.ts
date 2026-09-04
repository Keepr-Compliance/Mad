/**
 * Contact Link Review — the queue, its clusters, and what an answer does
 * (BACKLOG-2410)
 *
 * ===========================================================================
 * WHY THIS SURFACE EXISTS AT ALL
 * ===========================================================================
 * Deterministic matches auto-apply. Obvious non-matches are ignored. The value
 * is in the band between, where a human decides — and until this shipped that
 * band was computed, counted, logged and thrown away on every sync.
 *
 * It is also the ONLY mechanism by which a wrong merge can be found. The
 * industry record (BACKLOG-2273) is blunt: no company proactively detects false
 * merges; the person harmed by one discovers it. Our advantage is a user who
 * will tell us — but only if we ask.
 *
 * ===========================================================================
 * AN ANSWER DOES TWO THINGS, AND THE SECOND OUTLIVES THE FIRST
 * ===========================================================================
 * Confirm  -> create the crosswalk link  AND record `same_person`.
 * Reject   -> create nothing             AND record `different_people`.
 *
 * The link is the visible effect. The verdict is the durable one: it is
 * consulted by every future linking pass (see `hasCannotLink` in
 * `contactSourceLinker` and `contactNameAutoLink`), so a rejected pair is never
 * re-proposed AND never silently linked by some later rule that reaches it by a
 * different route.
 *
 * ===========================================================================
 * CLUSTERS — ONE ANSWER, SEVERAL PAIRS
 * ===========================================================================
 * `cluster_key` groups pairs that share a single real-world question:
 *
 *   contact:<id>            several source records all want to be one contact
 *   record:<source>:<id>    one source record could be several contacts
 *   name:<normalised name>  everything sharing an exact name
 *
 * The second shape is a genuine multiple-choice: confirming one member of a
 * `record:` cluster necessarily rejects the others, because a source record
 * belongs to exactly one person. That implication is applied here rather than
 * left to the user to click through — and it is applied by writing REAL
 * verdicts for the rejected siblings, not by hiding them, so the constraint
 * survives a re-run like any other answer.
 */

import { dbAll, dbGet, dbTransaction } from "./db/core/dbConnection";
import {
  COUNT_REVIEW_QUEUE_SQL,
  REVIEW_QUEUE_SQL,
} from "./db/contactLinkReviewSql";
import type { ExternalContactSource } from "./db/externalContactDbService";
import { createLink } from "./db/contactSourceLinkDbService";
import {
  getProposalById,
  listPendingProposalsInCluster,
  parseEvidence,
  recordVerdict,
  resolveProposal,
  type IdentityAssessment,
  type LinkProposalEvidence,
  type LinkProposalReason,
  type LinkProposalRow,
  type RelationshipAssessment,
} from "./db/contactLinkReviewDbService";
import { identityPhrase, relationshipPhrase, sourceLabel } from "./contactLinkEvidence";
import { applyLinkedSourceValues } from "./contactSourceValues";
import logService from "./logService";

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

export interface ReviewQueueItem {
  proposalId: string;
  contactId: string;
  contactName: string;
  /**
   * BACKLOG-2502 R2 — the contact card's subline on the tucked review card.
   *
   * The founder's design puts a role under the name ("Client (Buyer/Seller)"),
   * borrowed from the transaction Key Contacts row. This queue is NOT scoped to
   * a transaction, so there is no role to state; the company is the identifying
   * subline a contact carries globally, and an absent one renders nothing rather
   * than a placeholder.
   */
  contactCompany: string | null;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  sourceLabel: string;
  sourceName: string | null;
  /**
   * BACKLOG-2625 — the FIRST FALLBACK when two candidate rows would read alike.
   *
   * The founder's four Bianca Okafor candidates come from ONE address book and
   * match on TWO shared values, so source-plus-value cannot separate them — and
   * two of them share a name as well. He named the field that does: they
   * *"differ by organisation"*. Selected off the `external_contacts` row the
   * queue already inner-joins, so it costs no extra query, and — like
   * `recordEmails` / `recordPhones` below — read from the RECORD AS IT STANDS
   * rather than from `evidence_json`, which is frozen at proposal time. A user
   * judging whether two records are one person must be shown what they hold now.
   *
   * Rendered ONLY on collision — see `disambiguate()` in `ReviewDuplicatesModal`.
   * He rejected showing everything (*"the card gets tall fast at four
   * candidates"*) as firmly as he rejected identical rows.
   */
  sourceCompany: string | null;
  /**
   * BACKLOG-2502 R2 — the candidate record's OWN identifiers, so the review card
   * can show the value under the source label instead of only naming the field.
   *
   * Read off the `external_contacts` row the queue already inner-joins, so this
   * costs no extra query. NOT read from `evidence_json`: that is frozen at
   * proposal time on purpose, and a value the user is asked to judge must be the
   * record as it stands now.
   */
  recordEmails: string[];
  recordPhones: string[];
  reason: LinkProposalReason;
  /** Which identifier the rule compared — `email`, `phone`, `name`. Null when
   *  the proposal records no single field (BACKLOG-2502). */
  matchedOn: string | null;
  /** Axis 1, as a phrase. Never a number. */
  identity: IdentityAssessment;
  identityPhrase: string;
  /** Axis 2, as a phrase. Never a number. */
  relationship: RelationshipAssessment;
  relationshipPhrase: string;
  evidence: LinkProposalEvidence | null;
}

export interface ReviewQueueCluster {
  clusterKey: string;
  /** "Which of these is Jane Doe?" vs "Is this also Jane Doe?" */
  question: string;
  /**
   * True when the cluster is a multiple-choice over ONE source record, so
   * confirming one member logically rejects the rest.
   */
  exclusive: boolean;
  items: ReviewQueueItem[];
}

/**
 * Only questions whose BOTH SIDES still exist are askable.
 *
 * The join is the filter. A proposal whose contact was deleted, or whose source
 * record vanished from the address book, is a question with no answer — and a
 * queue that shows unanswerable questions is one the user stops opening. The
 * rows are left in place rather than deleted: if the record comes back, so does
 * the question, and the pair's answer history is untouched either way.
 *
 * The count on the button and the contents of the modal MUST come from the same
 * predicate. "Review 12 possible duplicates" opening onto 9 is the kind of small
 * lie that costs a feature its credibility.
 */

/**
 * `emails_json` / `phones_json` off an `external_contacts` row.
 *
 * Same shape as `contactCompare.ts`'s private reader, deliberately duplicated
 * rather than exported across: it is four lines of JSON defence, and the two
 * files already state their own rules about the crosswalk on purpose. A bad blob
 * yields no values rather than throwing — the queue must still render the rest
 * of the question.
 */
function parseValueArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

export function countReviewQueue(userId: string): number {
  const row = dbGet<{ n: number }>(COUNT_REVIEW_QUEUE_SQL, [userId]);
  return row?.n ?? 0;
}

export function getReviewQueue(userId: string): ReviewQueueCluster[] {
  const rows = dbAll<
    LinkProposalRow & {
      source_name: string | null;
      source_company: string | null;
      source_emails_json: string | null;
      source_phones_json: string | null;
      contact_name: string | null;
      contact_company: string | null;
    }
  >(
    REVIEW_QUEUE_SQL,
    [userId],
  );

  const byCluster = new Map<string, ReviewQueueCluster>();

  for (const row of rows) {
    const evidence = parseEvidence(row.evidence_json);
    const item: ReviewQueueItem = {
      proposalId: row.id,
      contactId: row.contact_id,
      contactName: row.contact_name?.trim() || evidence?.contactLabel || "this contact",
      contactCompany: row.contact_company?.trim() || null,
      sourceType: row.source_type,
      sourceRecordId: row.source_record_id,
      sourceLabel: sourceLabel(row.source_type),
      sourceName: row.source_name?.trim() || evidence?.sourceName || null,
      sourceCompany: row.source_company?.trim() || null,
      recordEmails: parseValueArray(row.source_emails_json),
      recordPhones: parseValueArray(row.source_phones_json),
      reason: row.reason,
      // BACKLOG-2502: WHAT MATCHED, as a value rather than as prose.
      //
      // Selected from the row since BACKLOG-2410 and never copied out — it
      // reached the UI only baked into `evidence.details`, one of the sentences
      // the readable list moves behind `Why`. The row is specified as "the two
      // names, the source, and the field that matched, in a few words", so
      // taking the prose away would take the matched field with it.
      matchedOn: row.matched_on,
      identity: row.identity_assessment,
      identityPhrase: identityPhrase(row.identity_assessment),
      relationship: row.relationship_assessment,
      relationshipPhrase: relationshipPhrase(row.relationship_assessment),
      evidence,
    };

    let cluster = byCluster.get(row.cluster_key);
    if (!cluster) {
      cluster = {
        clusterKey: row.cluster_key,
        question: "",
        exclusive: row.cluster_key.startsWith("record:"),
        items: [],
      };
      byCluster.set(row.cluster_key, cluster);
    }
    cluster.items.push(item);
  }

  for (const cluster of byCluster.values()) {
    cluster.question = clusterQuestion(cluster);
  }

  return [...byCluster.values()];
}

/**
 * The headline for a cluster.
 *
 * Written from the cluster's SHAPE rather than from its reason, because the
 * shape is what determines how many answers are needed: a multiple-choice over
 * one record is one question with several options; several records wanting one
 * contact is several yes/no questions that happen to share a subject.
 */
function clusterQuestion(cluster: ReviewQueueCluster): string {
  const first = cluster.items[0];
  if (!first) return "Possible duplicate";

  if (cluster.exclusive && cluster.items.length > 1) {
    const who = first.sourceName ? `"${first.sourceName}"` : `this ${first.sourceLabel} entry`;
    return `Which of these is ${who}?`;
  }
  if (cluster.clusterKey.startsWith("name:") && cluster.items.length > 1) {
    return `Several records share the name ${first.sourceName ?? first.contactName}`;
  }
  if (cluster.items.length > 1) {
    return `Are these also ${first.contactName}?`;
  }
  /*
    NO ARTICLE BEFORE AN INTERPOLATED VALUE — BACKLOG-2673.

    This read `a ${first.sourceLabel} entry`. Composed over the five labels this
    table's CHECK constraint actually admits, three of the five were wrong:
    "a iPhone entry", "a Outlook contacts entry", "a Android phone entry".
    ("a Mac address book entry" and "a Google contacts entry" were right, which
    is why it survived — the template is correct for the values its author had
    in mind.)

    The article now binds to `entry`, a word this code owns, and the label moves
    behind the preposition where nothing has to agree with it. Deliberately not a
    vowel check: pronunciation is not recoverable from a string, and a rule that
    is usually right is worse here than one that cannot be wrong.

    Line 278 above (`this ${first.sourceLabel} entry`) is CONSIDERED AND LEFT
    ALONE: "this" does not inflect on the sound that follows it.
  */
  const who = first.sourceName ? `"${first.sourceName}"` : `an entry in your ${first.sourceLabel}`;
  return `Is ${who} the same person as ${first.contactName}?`;
}

// ---------------------------------------------------------------------------
// WRITE
// ---------------------------------------------------------------------------

export type ReviewDecisionOutcome =
  | { ok: true; linked: boolean; alsoRejected: number }
  | { ok: false; error: string };

/**
 * Confirm: these are the same person.
 *
 * One transaction covering the verdict, the link and the sibling rejections.
 * The verdict is what a later pass reads, so a crash between "link created" and
 * "verdict written" would leave a link the constraint layer does not know about
 * — recoverable, but it would make the labelled set quietly incomplete, and an
 * incomplete ground-truth set is worse than an obviously empty one because
 * nothing announces it.
 */
export function confirmProposal(userId: string, proposalId: string): ReviewDecisionOutcome {
  const proposal = getProposalById(proposalId);
  if (!proposal || proposal.user_id !== userId) {
    return { ok: false, error: "That review item no longer exists." };
  }
  if (proposal.status !== "pending") {
    return { ok: false, error: "That review item has already been answered." };
  }

  return dbTransaction<ReviewDecisionOutcome>(() => {
    // Guarded on status inside the transaction: this is what makes a
    // double-click, a stale renderer, or two windows answering at once produce
    // ONE link rather than two.
    if (!resolveProposal(proposalId, "confirmed")) {
      return { ok: false, error: "That review item has already been answered." };
    }

    const evidence = parseEvidence(proposal.evidence_json);

    recordVerdict({
      userId,
      contactId: proposal.contact_id,
      sourceType: proposal.source_type,
      sourceRecordId: proposal.source_record_id,
      identityVerdict: "same_person",
      relationshipVerdict: proposal.relationship_assessment,
      reason: proposal.reason,
      matchedOn: proposal.matched_on,
      evidence,
      decidedBy: "review_queue",
    });

    // `manual` is the honest match_method: a human asserted this, and the
    // provenance panel will say so in exactly those words.
    //
    // BACKLOG-2419: until `assertMethod` existed, that comment described
    // behaviour THE CODE DID NOT HAVE. The pair is usually ALREADY linked by
    // the opportunistic matcher, and `createLink` discarded the incoming method
    // and returned the incumbent — so confirming a question left the panel
    // still reading "Matched by an email address you already had for this
    // person" after a human had agreed it was the same person. Asserting the
    // method is what makes the sentence true.
    const link = createLink({
      userId,
      contactId: proposal.contact_id,
      sourceType: proposal.source_type,
      sourceRecordId: proposal.source_record_id,
      matchMethod: "manual",
      assertMethod: true,
    });

    const linkedElsewhere = !link.created && link.contactId !== proposal.contact_id;
    if (linkedElsewhere) {
      // The record was claimed by someone else between the question being asked
      // and answered. Re-pointing it is a MERGE (BACKLOG-2370), not a link, and
      // this surface does not do merges. The verdict stands — the user's opinion
      // is still true and still worth keeping — but no link is created and the
      // caller is told plainly rather than shown a success that did nothing.
      logService.warn(
        `[Contacts] confirm did not link: that ${proposal.source_type} record is already ` +
          `claimed by a different contact`,
        "Contacts",
      );
      return { ok: true, linked: false, alsoRejected: 0 };
    }

    // BACKLOG-2423: confirming a question is a link, and a link is also a copy.
    // This is the surface where the delay was most visible — the user answers
    // "yes, same person" and the addresses that answer justified would not have
    // reached the contact until the next app start.
    applyLinkedSourceValues(userId, proposal.contact_id);

    const alsoRejected = proposal.cluster_key.startsWith("record:")
      ? rejectSiblings(userId, proposal)
      : 0;

    return { ok: true, linked: true, alsoRejected };
  });
}

/**
 * Reject: these are different people. The durable cannot-link.
 *
 * No link is created and none is removed — a rejection is about a link that was
 * never made. Unlinking an EXISTING link is the provenance panel's job
 * (`contactProvenance.unlinkContactSource`), and it records the same verdict by
 * a different route.
 */
export function rejectProposal(userId: string, proposalId: string): ReviewDecisionOutcome {
  const proposal = getProposalById(proposalId);
  if (!proposal || proposal.user_id !== userId) {
    return { ok: false, error: "That review item no longer exists." };
  }
  if (proposal.status !== "pending") {
    return { ok: false, error: "That review item has already been answered." };
  }

  return dbTransaction<ReviewDecisionOutcome>(() => {
    if (!resolveProposal(proposalId, "rejected")) {
      return { ok: false, error: "That review item has already been answered." };
    }

    recordVerdict({
      userId,
      contactId: proposal.contact_id,
      sourceType: proposal.source_type,
      sourceRecordId: proposal.source_record_id,
      identityVerdict: "different_people",
      // "Different people" says nothing about whether they are connected — that
      // is the whole reason the axes are separate. The system's reading of the
      // relationship is preserved unchanged.
      relationshipVerdict: proposal.relationship_assessment,
      reason: proposal.reason,
      matchedOn: proposal.matched_on,
      evidence: parseEvidence(proposal.evidence_json),
      decidedBy: "review_queue",
    });

    return { ok: true, linked: false, alsoRejected: 0 };
  });
}

/**
 * A source record belongs to exactly one person, so confirming one candidate in
 * a `record:` cluster asserts that every other candidate is NOT that person.
 *
 * Written as real verdicts, not as a UI filter. If the siblings were merely
 * hidden, the next linking pass would re-derive the same ambiguity and ask again
 * — the user would have answered and been asked anyway, which is the exact
 * failure the durable store exists to prevent.
 */
function rejectSiblings(userId: string, confirmed: LinkProposalRow): number {
  const siblings = listPendingProposalsInCluster(userId, confirmed.cluster_key).filter(
    (s) => s.id !== confirmed.id && s.source_record_id === confirmed.source_record_id,
  );

  let rejected = 0;
  for (const sibling of siblings) {
    if (!resolveProposal(sibling.id, "rejected")) continue;
    recordVerdict({
      userId,
      contactId: sibling.contact_id,
      sourceType: sibling.source_type,
      sourceRecordId: sibling.source_record_id,
      identityVerdict: "different_people",
      relationshipVerdict: sibling.relationship_assessment,
      reason: sibling.reason,
      matchedOn: sibling.matched_on,
      evidence: parseEvidence(sibling.evidence_json),
      // Deduced from the user's answer, not answered directly. A calibration set
      // that cannot tell a deduction from a decision would treat one click as
      // several independent human judgements.
      decidedBy: "review_queue_implied",
    });
    rejected++;
  }
  return rejected;
}
