/**
 * Contact Link Evidence — turning a withheld match into a question a person can
 * answer (BACKLOG-2410)
 *
 * ===========================================================================
 * WORDS, NEVER A SCORE
 * ===========================================================================
 * "0.82 confidence" tells a user nothing they can act on. What they can act on
 * is:
 *
 *     Both appear on the 123 Oak St thread; the other participant matched by
 *     exact email.
 *
 * Every string produced here is a full sentence naming the actual identifier,
 * the actual source, and the actual reason the match was withheld. Nothing in
 * this file emits a number that could be read as a likelihood. The one number
 * that does appear — how many records share a name — is a COUNT of things the
 * user owns, not a measure of belief, and it is always written out in the
 * sentence alongside what it counts.
 *
 * ===========================================================================
 * IDENTIFIERS ARE PARTIALLY MASKED
 * ===========================================================================
 * The sentence has to name the identifier or the user cannot check it. It does
 * not have to reproduce it in full: the queue is a screen the user may have open
 * while sharing their display with support, and the diagnostics work
 * (BACKLOG-2394) already established that contact PII must not leak into places
 * it was not asked for. Enough to recognise, not enough to harvest.
 */

import { dbAll, dbGet } from "./db/core/dbConnection";
import type { ExternalContactSource } from "./db/externalContactDbService";
import type { ContactMatchMethod } from "./db/contactSourceLinkDbService";
import type {
  IdentityAssessment,
  LinkProposalEvidence,
  LinkProposalReason,
  RelationshipAssessment,
} from "./db/contactLinkReviewDbService";

// BACKLOG-2459 — the database-free sentences (masking, `summaryForReason`,
// `describeIdentifier`) moved to a renderer-safe module so the picker's own
// collapse can be explained in the SAME words. This file cannot be imported from
// the renderer: `dbConnection` above would pull better-sqlite3 into the Vite
// bundle. Nothing about the sentences changed in the move, and they are
// re-exported below so every existing caller is unchanged.
import { describeIdentifier, summaryForReason } from "./contactLinkEvidenceVocabulary";

export {
  describeIdentifier,
  maskEmail,
  maskPhone,
  summaryForReason,
} from "./contactLinkEvidenceVocabulary";

// ===========================================================================
// PURE VOCABULARY — no database, safe to call from anywhere, trivially testable
// ===========================================================================

/**
 * What to call a source in a sentence. Possessive-ready ("in your Outlook
 * contacts"), because every use site is describing something the user owns.
 *
 * NOT the same vocabulary as `contacts.source`, which calls macOS
 * `'contacts_app'`. Conflating the two is the mistake the v57 CHECK exists to
 * prevent; this map is keyed on `ExternalContactSource` only.
 */
const SOURCE_LABELS: Record<ExternalContactSource, string> = {
  macos: "Mac address book",
  iphone: "iPhone",
  outlook: "Outlook contacts",
  google_contacts: "Google contacts",
  android_sync: "Android phone",
};

export function sourceLabel(source: ExternalContactSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Which family a source belongs to, for the unique-exact-name rule.
 *
 * The founder's condition is "one record from email and one from the phone
 * book". The strength of that pairing is not that two records agree — it is that
 * they agree ACROSS two independently maintained lists. Two records inside one
 * address book agreeing on a name is a duplicate, a different problem with a
 * different remedy (BACKLOG-2370).
 */
export type SourceFamily = "email" | "phone";

const SOURCE_FAMILIES: Record<ExternalContactSource, SourceFamily> = {
  // Address books that live on a device the user carries.
  macos: "phone",
  iphone: "phone",
  android_sync: "phone",
  // Contact lists that come attached to a mail account.
  outlook: "email",
  google_contacts: "email",
};

export function sourceFamily(source: ExternalContactSource): SourceFamily {
  return SOURCE_FAMILIES[source];
}

/**
 * How a crosswalk link was made, in words. Shown on the provenance screen —
 * the only place a wrongly merged contact can be seen and undone, so the
 * wording has to be specific enough that a user can tell whether it is wrong.
 *
 * "Matched by email" is checkable. "High confidence" is not.
 */
export function matchMethodDescription(
  method: ContactMatchMethod,
  source: ExternalContactSource,
): string {
  switch (method) {
    case "source_id":
      return `Recognised by its own entry in your ${sourceLabel(source)}`;
    case "email":
      return "Matched by an email address you already had for this person";
    case "phone":
      return "Matched by a phone number you already had for this person";
    case "unique_name":
      return "Matched by a full name that appears exactly once in your address book and once in your email contacts";
    case "manual":
      return "You confirmed this yourself";
    case "scored":
      return "Suggested by a similarity match";
    default:
      return "Linked";
  }
}

/** The two axes, stated in the founder's words rather than as enum values. */
export function identityPhrase(assessment: IdentityAssessment): string {
  switch (assessment) {
    case "same_person":
      return "the same person";
    case "different_people":
      return "different people";
    default:
      return "possibly the same person";
  }
}

export function relationshipPhrase(assessment: RelationshipAssessment): string {
  switch (assessment) {
    case "connected":
      return "connected";
    case "no_known_connection":
      return "no known connection";
    default:
      return "possibly connected";
  }
}

// ===========================================================================
// DATABASE-BACKED CONTEXT
// ===========================================================================

export function contactDisplayName(contactId: string): string {
  const row = dbGet<{ display_name: string | null }>(
    `SELECT display_name FROM contacts WHERE id = ?`,
    [contactId],
  );
  const name = row?.display_name?.trim();
  return name && name.length > 0 ? name : "this contact";
}

export function sourceRecordName(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): string | null {
  const row = dbGet<{ name: string | null }>(
    `SELECT name FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`,
    [userId, sourceType, sourceRecordId],
  );
  const name = row?.name?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * Do these two saved contacts appear on the same transaction?
 *
 * THE THREE-WAY RELATIONSHIP AGAIN. A contact reaches a transaction by a direct
 * FK column, by the junction table, or by the `other_contacts` JSON array, and a
 * predicate that checks only one of the three under-reports — the same trap
 * `isContactOnFrozenTransaction` documents. Under-reporting here is not
 * cosmetic: it is what turns "connected, different people" into "no known
 * connection", which is the reading that makes a buyer and a seller on one deal
 * look like a duplicate.
 */
export function contactsShareTransaction(contactA: string, contactB: string): boolean {
  if (!contactA || !contactB || contactA === contactB) return false;
  const onTransaction = `(
      t.buyer_agent_id = @c
      OR t.seller_agent_id = @c
      OR t.escrow_officer_id = @c
      OR t.inspector_id = @c
      OR EXISTS (
        SELECT 1 FROM transaction_contacts tc
         WHERE tc.transaction_id = t.id AND tc.contact_id = @c
      )
      OR (
        t.other_contacts IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @c
        )
      )
    )`;
  const row = dbGet<{ hit: number }>(
    `SELECT 1 AS hit FROM transactions t
      WHERE ${onTransaction.replace(/@c/g, "@a")}
        AND ${onTransaction.replace(/@c/g, "@b")}
      LIMIT 1`,
    [{ a: contactA, b: contactB }],
  );
  return row !== undefined && row !== null;
}

/** Every transaction address the two sides share, for the "both appear on" line. */
function sharedTransactionAddresses(contactA: string, contactB: string): string[] {
  if (!contactA || !contactB || contactA === contactB) return [];
  const onTransaction = `(
      t.buyer_agent_id = @c
      OR t.seller_agent_id = @c
      OR t.escrow_officer_id = @c
      OR t.inspector_id = @c
      OR EXISTS (
        SELECT 1 FROM transaction_contacts tc
         WHERE tc.transaction_id = t.id AND tc.contact_id = @c
      )
      OR (
        t.other_contacts IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(t.other_contacts) j WHERE j.value = @c
        )
      )
    )`;
  return dbAll<{ property_address: string | null }>(
    `SELECT t.property_address FROM transactions t
      WHERE ${onTransaction.replace(/@c/g, "@a")}
        AND ${onTransaction.replace(/@c/g, "@b")}
      ORDER BY t.property_address
      LIMIT 3`,
    [{ a: contactA, b: contactB }],
  )
    .map((r) => r.property_address?.trim())
    .filter((a): a is string => !!a);
}

export interface EvidenceRequest {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  reason: LinkProposalReason;
  matchedOn?: "email" | "phone" | "name" | null;
  /** The actual identifier values the match was made on, unmasked. */
  matchedValues?: string[];
  /** For the name rules: how many holders share the name, and what it reads as. */
  nameHolderCount?: number;
  nameText?: string | null;
  /**
   * OTHER SAVED CONTACTS implicated in the same question — the rival candidates
   * for an ambiguous identifier, or the other people sharing a name.
   *
   * This, and NOT the conflicting source record, is what the relationship axis
   * is computed from, and the distinction is easy to get backwards. A withheld
   * duplicate/reassignment names an incumbent source record that BY
   * CONSTRUCTION already belongs to the very contact being asked about — the
   * conflict is what makes it a question — so comparing the two would always be
   * comparing a contact with itself, and the axis would be permanently dead in
   * the "connected" direction while looking fully implemented.
   *
   * Rival candidates are different people by construction, which is exactly the
   * pair worth asking "are these two connected?" about — and the answer that
   * matters is a buyer and a seller on one deal.
   */
  relatedContactIds?: string[];
}

export interface BuiltEvidence {
  evidence: LinkProposalEvidence;
  identityAssessment: IdentityAssessment;
  relationshipAssessment: RelationshipAssessment;
}

/**
 * Assemble the question.
 *
 * THE IDENTITY AXIS IS ALWAYS `possibly_same_person` HERE, and that is not
 * laziness — it is the definition of the queue. Anything the system could call
 * `same_person` was linked without asking; anything it could call
 * `different_people` was never a candidate. What reaches this function is
 * exactly the band where the system does not know, and saying so plainly is more
 * honest than manufacturing a gradient inside it.
 *
 * THE RELATIONSHIP AXIS IS REAL AND IS COMPUTED. It is the axis that stops the
 * queue reading as "these are probably duplicates": a pair that shares a
 * transaction is reported as CONNECTED, which is the fact that makes "different
 * people" the likely answer rather than the surprising one.
 */
export function buildEvidence(req: EvidenceRequest): BuiltEvidence {
  const contactLabel = contactDisplayName(req.contactId);
  const label = sourceLabel(req.sourceType);
  const srcName = sourceRecordName(req.userId, req.sourceType, req.sourceRecordId);

  const identifierPhrase = describeIdentifier(req.matchedOn, req.matchedValues ?? []);

  const summary = summaryForReason(req.reason, {
    contactLabel,
    sourceLabel: label,
    identifierPhrase,
    nameHolderCount: req.nameHolderCount,
    nameText: req.nameText ?? srcName,
  });

  const details: string[] = [];
  if (srcName) {
    details.push(`The ${label} entry is saved as "${srcName}".`);
  } else {
    details.push(`The ${label} entry has no name on it.`);
  }

  // The relationship axis. A shared transaction is the strongest connection this
  // product can observe, and the one most likely to mean RELATED, NOT THE SAME —
  // so it is checked first and it overrides the reason's default reading.
  let relationshipAssessment: RelationshipAssessment = defaultRelationshipFor(req.reason);

  for (const otherContactId of req.relatedContactIds ?? []) {
    if (!otherContactId || otherContactId === req.contactId) continue;
    const addresses = sharedTransactionAddresses(req.contactId, otherContactId);
    if (addresses.length === 0) continue;
    relationshipAssessment = "connected";
    details.push(
      `${contactLabel} and ${contactDisplayName(otherContactId)} both appear on the ` +
        `${addresses.join(" and ")} ${addresses.length === 1 ? "transaction" : "transactions"} — ` +
        `so they are connected, which is not the same as being one person.`,
    );
    break;
  }

  if (identifierPhrase && req.matchedOn && req.matchedOn !== "name") {
    details.push(
      `They were compared on ${identifierPhrase}, matched exactly — not approximately.`,
    );
  }

  details.push(
    `Nothing has been linked. ${contactLabel} and this ${label} entry are still separate.`,
  );

  return {
    evidence: {
      summary,
      details,
      contactLabel,
      sourceLabel: label,
      sourceName: srcName,
    },
    // See the block comment above: everything that reaches the queue is, by
    // construction, the band where the system cannot tell.
    identityAssessment: "possibly_same_person",
    relationshipAssessment,
  };
}

/**
 * The relationship reading implied by the reason alone, before any transaction
 * evidence is consulted.
 *
 * `name_not_unique` is the one that earns `no_known_connection`: two strangers
 * who happen to share a name have nothing tying them together, and reporting
 * anything warmer would be inventing a relationship out of a coincidence. The
 * identifier-based reasons all imply at least a possible connection, because a
 * shared phone number or email means SOMETHING even when it does not mean
 * sameness — a household, a firm, a reassigned line.
 */
function defaultRelationshipFor(reason: LinkProposalReason): RelationshipAssessment {
  switch (reason) {
    case "duplicate_source_record":
      // Both records still assert the same identifier at the same time. Whatever
      // else is true, these two are tied to each other.
      return "connected";
    case "identifier_reassigned":
    case "ambiguous_identifier":
    case "frozen_audit_contact":
    case "name_generational_suffix":
    case "name_same_source_family":
    case "name_two_saved_contacts":
      return "possibly_connected";
    case "name_not_unique":
      return "no_known_connection";
    default:
      return "possibly_connected";
  }
}
