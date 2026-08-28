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
import type {
  ContactLinkSourceType,
  ContactMatchMethod,
} from "./db/contactSourceLinkDbService";
import type {
  IdentityAssessment,
  LinkProposalEvidence,
  LinkProposalReason,
  RelationshipAssessment,
} from "./db/contactLinkReviewDbService";

// ===========================================================================
// PURE VOCABULARY — no database, safe to call from anywhere, trivially testable
// ===========================================================================

/**
 * What to call a source in a sentence. Possessive-ready ("in your Outlook
 * contacts"), because every use site is describing something the user owns.
 *
 * NOT the same vocabulary as `contacts.source`, which calls macOS
 * `'contacts_app'`. Conflating the two is the mistake the v57 CHECK exists to
 * prevent; this map is keyed on the crosswalk's own vocabulary.
 *
 * BACKLOG-2473 widened that vocabulary with four ORIGIN-ONLY types. They name a
 * provenance rather than an address book, so their labels are phrased to read
 * correctly in "where did this contact come from" — the only sentence they ever
 * appear in, since `matchMethodDescription` routes `origin` away from the
 * "Recognised by its own entry in your ..." wording that suits the other five.
 */
const SOURCE_LABELS: Record<ContactLinkSourceType, string> = {
  macos: "Mac address book",
  iphone: "iPhone",
  outlook: "Outlook contacts",
  google_contacts: "Google contacts",
  android_sync: "Android phone",
  manual: "contacts you added yourself",
  email: "your email",
  sms: "your text messages",
  inferred: "your email",
};

export function sourceLabel(source: ContactLinkSourceType): string {
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
  source: ContactLinkSourceType,
): string {
  switch (method) {
    // BACKLOG-2473 — an origin row is not a match, so it must not be described
    // as one. Every other branch below says "this contact was joined to that
    // record because ..."; this one answers "where did this contact come from?",
    // which for these four is the only question with an answer.
    case "origin":
      switch (source) {
        case "manual":
          return "You added this contact yourself";
        case "email":
        case "inferred":
          return "Found in your email";
        case "sms":
          return "Found in your text messages";
        default:
          return `Imported from your ${sourceLabel(source)}`;
      }
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

/** `jane.smith@example.com` -> `ja…@example.com`. Recognisable, not harvestable. */
export function maskEmail(email: string): string {
  const trimmed = (email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed ? "an email address" : "an email address";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  if (local.length <= 2) return `${local}${domain}`;
  return `${local.slice(0, 2)}…${domain}`;
}

/** `+1 (415) 555-0134` -> `…0134`. The last four is what people recognise. */
export function maskPhone(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 0) return "a phone number";
  if (digits.length <= 4) return `…${digits}`;
  return `…${digits.slice(-4)}`;
}

/**
 * The sentence a user reads first. One per reason, and each one names what
 * actually happened rather than describing a category.
 */
export function summaryForReason(
  reason: LinkProposalReason,
  ctx: {
    contactLabel: string;
    sourceLabel: string;
    identifierPhrase: string | null;
    nameHolderCount?: number;
    nameText?: string | null;
  },
): string {
  const who = ctx.contactLabel;
  const ident = ctx.identifierPhrase;
  switch (reason) {
    case "identifier_reassigned":
      return (
        `A record in your ${ctx.sourceLabel} carries ${ident ?? "an identifier"}, which you also have ` +
        `saved against ${who} — but ${who}'s own entry in that ${ctx.sourceLabel} no longer lists it. ` +
        `That usually means the ${ident ?? "identifier"} moved to a different person.`
      );
    case "duplicate_source_record":
      return (
        `Two entries in your ${ctx.sourceLabel} both list ${ident ?? "the same details"}, and you already ` +
        `have ${who} saved from one of them. This is usually one person saved twice.`
      );
    case "ambiguous_identifier":
      return (
        `${ident ?? "This identifier"} appears on more than one of your saved contacts, so there is no way ` +
        `to tell which of them this ${ctx.sourceLabel} entry belongs to. ${who} is one of the candidates.`
      );
    case "frozen_audit_contact":
      return (
        `${who} appears on an audit you have already exported. Nothing is linked to an exported audit ` +
        `automatically, so this one is being left to you.`
      );
    case "name_not_unique":
      return (
        `${ctx.nameHolderCount ?? "Several"} separate records carry the name ` +
        `${ctx.nameText ?? who}. A name shared by that many people cannot say which is which.`
      );
    case "name_same_source_family":
      return (
        `Two entries named ${ctx.nameText ?? who} both come from your ${ctx.sourceLabel}. A name repeated ` +
        `inside one address book is a duplicate to clean up, not a link between two lists.`
      );
    case "name_generational_suffix":
      return (
        `One of these is written with a generational suffix (Jr, Sr, II, III) and the other is not. ` +
        `That is most often a parent and a child, who share a surname and often an address and a phone.`
      );
    case "name_two_saved_contacts":
      return (
        `${ctx.nameText ?? who} appears once in your address book and once in your email contacts, but ` +
        `each is already saved as its own contact. Joining them would merge two saved people, which is ` +
        `more than a link.`
      );
    // BACKLOG-2619 / BACKLOG-2624 — the linker's name veto. Both sentences name
    // the identifier AND say what the names did, because the identifier alone is
    // what made this look like a match in the first place.
    case "name_mismatch":
      return (
        `A record in your ${ctx.sourceLabel} lists ${ident ?? "an identifier"} that you also have saved ` +
        `against ${who} — but it is saved under a different name` +
        `${ctx.nameText ? `, "${ctx.nameText}"` : ""}. A shared number or address often means an office, ` +
        `a household, or a line that changed hands, rather than one person.`
      );
    case "name_unknown":
      return (
        `A record in your ${ctx.sourceLabel} lists ${ident ?? "an identifier"} that you also have saved ` +
        `against ${who}, but one of the two has no name on it — so there is nothing to check the match ` +
        `against. A missing name is not evidence that these are the same person.`
      );
    default:
      return `This match was not applied automatically.`;
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
  // BACKLOG-2366: the transaction_contacts branch below is DELIBERATELY NOT
  // filtered by removed_at, unlike the "who is on this deal now" readers. Two
  // contacts appearing on the same transaction is evidence they are DIFFERENT
  // PEOPLE — you do not put one human on a deal twice — so this is an anti-merge
  // signal, and it stays true after one of them is taken off the deal. Filtering
  // here would DISCARD evidence and make a wrong merge more likely: the
  // under-reporting trap this module's own docblock warns about. Historical
  // co-occurrence is still co-occurrence.
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

/**
 * Every transaction address the two sides share, for the "both appear on" line.
 *
 * EXPORTED for `contactIdentityEvidence` (BACKLOG-2630 D2 piece 2). The gatherer
 * reports the COUNT as a relationship fact and renders no sentence of its own, so
 * the sentence built below and the fact gathered there cannot disagree about
 * which transactions the two sides share.
 */
export function sharedTransactionAddresses(contactA: string, contactB: string): string[] {
  if (!contactA || !contactB || contactA === contactB) return [];
  // BACKLOG-2366: the transaction_contacts branch below is DELIBERATELY NOT
  // filtered by removed_at, unlike the "who is on this deal now" readers. Two
  // contacts appearing on the same transaction is evidence they are DIFFERENT
  // PEOPLE — you do not put one human on a deal twice — so this is an anti-merge
  // signal, and it stays true after one of them is taken off the deal. Filtering
  // here would DISCARD evidence and make a wrong merge more likely: the
  // under-reporting trap this module's own docblock warns about. Historical
  // co-occurrence is still co-occurrence.
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
 * BACKLOG-2459: exported so the renderer's mirror
 * (`src/utils/contactCollapseVocabulary.ts`) can be pinned against it by a
 * parity test. It is duplicated rather than imported because this repository has
 * no module location both processes can compile — see that file's header.
 */
export function describeIdentifier(
  matchedOn: "email" | "phone" | "name" | null | undefined,
  values: string[],
): string | null {
  const first = values.find((v) => typeof v === "string" && v.trim().length > 0);
  if (!first) return null;
  if (matchedOn === "email") return `the email address ${maskEmail(first)}`;
  if (matchedOn === "phone") return `the phone number ${maskPhone(first)}`;
  if (matchedOn === "name") return `the name "${first.trim()}"`;
  return null;
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
    // BACKLOG-2619 — a shared phone or email means SOMETHING even when the names
    // say it is not one person. The office line that produced the mismatch is
    // itself the connection, and `contactsShareTransaction` can still upgrade
    // this to `connected`.
    case "name_mismatch":
    case "name_unknown":
      return "possibly_connected";
    case "name_not_unique":
      return "no_known_connection";
    default:
      return "possibly_connected";
  }
}
