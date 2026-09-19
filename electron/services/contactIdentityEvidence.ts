/**
 * The one evidence GATHERER — facts about a pair, and nothing else
 * (BACKLOG-2630, D2 piece 2 of 3, plan §3)
 *
 * ===========================================================================
 * THIS MODULE DECIDES NOTHING. THAT IS ITS ENTIRE CONTRACT.
 * ===========================================================================
 * Nothing here returns "same person", a score, a band, a threshold or a
 * boolean match. It reports what is true about two endpoints and stops:
 *
 *     "these two share a normalised phone key"
 *     "these two carry names that normalise to the same key, and that name has
 *      a generational suffix"
 *     "these two appear on the same transaction"
 *
 * Never "these are the same person". The decision function is D3 (piece 3 and
 * beyond) and it reads these facts; it does not live here. If a function in
 * this file ever returns a verdict, the file has stopped doing its job.
 *
 * Founder ruling, 2026-08-22 (Q1): identity and role are "two different
 * algorithms with different functions" on ONE shared evidence layer with TWO
 * decision functions. So the gatherer is SUBJECT-AGNOSTIC and DECISION-FREE,
 * and role inference plugs into it later with no re-scrape.
 *
 * ===========================================================================
 * IDENTITY FACTS AND RELATIONSHIP FACTS ARE SEPARATE BRANCHES, ON PURPOSE
 * ===========================================================================
 * Founder, 2026-08-02 (BACKLOG-2273): *"Every contextual signal is evidence of
 * a RELATIONSHIP. Identity is a much stronger claim."*
 *
 * The buyer and the seller on one deal max out every contextual signal this
 * product can observe — shared transaction, overlapping correspondence, the
 * same closing date — and they are emphatically not one person. A single flat
 * list of "signals" that a later matcher could add up is precisely the design
 * error that ruling forbids.
 *
 * So `identity` and `relationship` are DIFFERENT BRANCHES of the returned type,
 * and this module exports NO helper that takes both and returns a number, a
 * score or a verdict. The TYPE is what stops D3 making that mistake later;
 * `contactIdentityEvidence.test.ts` asserts the export surface to keep it that
 * way.
 *
 * ===========================================================================
 * THREE PAIR SHAPES, ONE OF WHICH HAS A PRODUCER
 * ===========================================================================
 * v69 (piece 1) gave `contact_link_proposals` / `contact_link_verdicts` the
 * ability to name three shapes — `record_contact`, `record_record`,
 * `contact_contact`. The gatherer serves all three, because the schema can hold
 * all three.
 *
 * ONLY `record_contact` HAS A LIVE PRODUCER TODAY, and that is correct.
 * Founder, 2026-08-27: *"build the shape, do not build a writer for it."* Tests
 * may call this function on the other two shapes directly; NO PRODUCTION PATH
 * CONSTRUCTS ONE until D3 / BACKLOG-2616 are authorised.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * ===========================================================================
 *  - The decision, the thresholds, the confidence bands (D3; OQ-1 is still open
 *    with the founder).
 *  - The AI-tier gate. Rows 7.3 / 6.2 / 6.5 gate the thing that ACTS. This
 *    module never acts, so it has nothing to gate — and it must not acquire
 *    one, because a gate here would gate GATHERING, which is not what was ruled.
 *  - Any UI, IPC channel or preload binding.
 *  - Transitive closure over confirmed pairs. `cluster_key` is untouched and
 *    stays "one question listing all candidates; answering yes clears the rest"
 *    (BACKLOG-2369 G2). Chaining pairwise matches is the black-hole-entity
 *    failure — BACKLOG-2941.
 *  - The name VETO. `autoLinkNameGuard.nameSupportForAutoLink` answers "may this
 *    be linked silently", which is a decision. This module supplies its INPUTS
 *    (the raw names and each endpoint's own identifier keys) and leaves the rule
 *    where it lives.
 *
 * ===========================================================================
 * EVERY KEY COMES FROM THE SITE THAT ALREADY COMPUTES IT
 * ===========================================================================
 * Nothing in this file re-derives a normalisation rule. Email keys come from
 * `contactMatchIndex.emailProbeKeys`, phone keys from
 * `phoneNormalization.toMatchingKey` (via `contactMatchIndex.phoneProbeKeys`),
 * names from `contactNameAutoLink.normalizeNameKey` and
 * `contactDisplayLabel.realContactName`, the transaction graph from
 * `contactLinkEvidence`, the tombstone predicate from `contactTombstoneSql`,
 * recency from `contactRecencySql`. A second copy of any of those is a second
 * comparison path, which is the thing BACKLOG-2630 exists to end.
 */

import { dbAll, dbGet } from "./db/core/dbConnection";
import {
  CONTACT_EMAILS_SQL,
  CONTACT_NAME_AND_ACTIVE_SQL,
  CONTACT_PHONES_SQL,
  EXTERNAL_RECORD_WITH_RECENCY_SQL,
  IMPORTED_CONTACT_RECENCY_SQL,
} from "./db/contactIdentityEvidenceSql";
import logService from "./logService";
import type { ExternalContactSource } from "./db/externalContactDbService";
import {
  emailProbeKeys,
  phoneProbeKeys,
  liveContactMatchIndex,
} from "./db/contactMatchIndex";
import type { ContactLinkPairKind } from "./db/contactIdentitySchemaSql";
import {
  getLatestVerdict,
  hasCannotLink,
  hasMustLink,
  type IdentityAssessment,
} from "./db/contactLinkReviewDbService";
import { normalizeNameKey } from "./contactNameAutoLink";
import { realContactName } from "../utils/contactDisplayLabel";
import { contactsShareTransaction, sharedTransactionAddresses } from "./contactLinkEvidence";
import { isContactOnFrozenTransaction } from "./db/frozenContactDbService";

// ---------------------------------------------------------------------------
// THE ENDPOINTS
// ---------------------------------------------------------------------------

/**
 * One side of a pair. A saved contact, or an external record.
 *
 * A discriminated union rather than four optional fields, because the three
 * pair shapes are then a property of the TYPE rather than of a convention every
 * caller has to remember — the same argument piece 1 used for making `pair_key`
 * a generated column instead of a call-site rule.
 */
export type EvidenceEndpoint =
  | { kind: "contact"; contactId: string }
  | { kind: "record"; sourceType: ExternalContactSource; sourceRecordId: string };

export interface GatherIdentityEvidenceInput {
  userId: string;
  /** The incumbent — the side the question is being asked FOR. */
  subject: EvidenceEndpoint;
  /** The other side. */
  candidate: EvidenceEndpoint;
  /**
   * How many records AND saved contacts share the subject's normalised name.
   *
   * SUPPLIED BY THE CALLER, NOT COMPUTED HERE, and `null` means NOT COMPUTED —
   * never zero. The tally requires normalising every name in the book, because
   * `normalizeNameKey`'s accent and punctuation folding cannot be expressed in
   * SQL; that is exactly what `contactNameAutoLink.collectNameGroups` already
   * does once per pass. Recomputing it per proposal would be O(book) per
   * question AND a second tally that can disagree with the first — the "two
   * comparison paths" failure this item exists to end. `fileNameQuestion`
   * already holds the number and passes it; the identifier paths do not have
   * one and say so.
   */
  nameHolderCount?: number | null;
}

// ---------------------------------------------------------------------------
// THE FACTS
// ---------------------------------------------------------------------------

/**
 * The identifier keys each side offers, and the ones they have in common.
 *
 * `sharedKeys` is a SET INTERSECTION, not a verdict. Two people who work at one
 * office share a phone key; that is a fact about the number, and reading it as
 * a fact about the people is the defect BACKLOG-2619 records.
 */
export interface IdentifierFacts {
  subjectKeys: string[];
  candidateKeys: string[];
  sharedKeys: string[];
  /**
   * Values held by this side that produced NO key.
   *
   * Reported separately so "no key" is never read as "no number". For phones
   * this is the digit floor doing its job (`MATCHING_DIGIT_FLOOR` = 7): an
   * extension or a four-digit fragment is stored, searchable and displayable,
   * and merely barred from the candidate set (BACKLOG-2754).
   */
  subjectUnkeyableCount: number;
  candidateUnkeyableCount: number;
}

/** One side's name, as it is and as it normalises. No comparison, no verdict. */
export interface EndpointNameFacts {
  /** Exactly what the column holds. Never substituted, never defaulted. */
  raw: string | null;
  /**
   * `raw` with the machine sentinels removed (`realContactName`), or `null`.
   *
   * `schema.sql` declares `display_name NOT NULL`, so five live write paths
   * store the literal "Unknown" instead of nothing. That string is not a name
   * and must not be compared as one.
   */
  real: string | null;
  /** `normalizeNameKey`'s key, or `null` when the name cannot yield first+last. */
  normalizedKey: string | null;
  tokenCount: number;
  /**
   * The last token is a generational suffix.
   *
   * SUFFIXES ARE NOT STRIPPED, here or in `normalizeNameKey`. Normalisation
   * that removes a suffix makes a father and a son identical, which is a wrong
   * merge in an audit product. The flag reports the fact; it decides nothing.
   */
  hasGenerationalSuffix: boolean;
}

export interface NameFacts {
  subject: EndpointNameFacts;
  candidate: EndpointNameFacts;
  /**
   * Both sides normalised to a key AND the two keys are equal.
   *
   * `false` when either side has no key — two absences are not an agreement.
   * A missing name is absence of evidence, not evidence of a match
   * (BACKLOG-2624).
   */
  normalizedKeysEqual: boolean;
  /** See `GatherIdentityEvidenceInput.nameHolderCount`. `null` = not computed. */
  holderCount: number | null;
}

/** What the crosswalk already knows about a record endpoint. */
export interface CrosswalkFacts {
  /** The saved contact that already owns the subject record, if it is a record. */
  subjectOwnerContactId: string | null;
  candidateOwnerContactId: string | null;
}

/** Claims about SAMENESS. Never summed with the branch below. */
export interface IdentityFactGroup {
  emails: IdentifierFacts;
  phones: IdentifierFacts;
  name: NameFacts;
  crosswalk: CrosswalkFacts;
}

/**
 * Claims about CONNECTION — which is not sameness, and is frequently its
 * opposite. A shared transaction is the strongest connection this product can
 * observe and the one most likely to mean RELATED, NOT THE SAME.
 */
export interface RelationshipFactGroup {
  /**
   * `null` when either endpoint is not a saved contact: the transaction graph is
   * contact-keyed, so for a record endpoint the question cannot be asked at all.
   * `null` is "cannot be asked", NOT "no".
   */
  shareTransaction: boolean | null;
  /** How many of the shared transactions were readable (capped at 3 by the probe). */
  sharedTransactionAddressCount: number | null;
  subjectLastCommunicationAt: string | null;
  candidateLastCommunicationAt: string | null;
}

/** Whether each side is even eligible to be a candidate. */
export interface EligibilityFactGroup {
  subjectExists: boolean;
  candidateExists: boolean;
  /**
   * Tombstoned or removed. ONE predicate
   * (`contactTombstoneSql.ACTIVE_CONTACTS_CLAUSE_UNALIASED`) and NO redirect to
   * a survivor — a removed contact is excluded from candidate sets, it is not
   * silently replaced by whoever absorbed it.
   */
  subjectRemoved: boolean;
  candidateRemoved: boolean;
  subjectOnFrozenTransaction: boolean;
  candidateOnFrozenTransaction: boolean;
}

/**
 * What a human already answered about this pair.
 *
 * `readable: false` means NOBODY CAN LOOK, not "nobody has answered". The
 * verdict readers that exist today (`getLatestVerdict`, `hasCannotLink`,
 * `hasMustLink`) are keyed on `(contact_id, source_type, source_record_id)`, so
 * they can only answer for a `record_contact` pair. The unordered pair-keyed
 * readers are plan §4 — piece 3 — and reporting their absence as "no prior
 * answer" would be exactly the false negative that keeps costing this project
 * real work.
 */
export interface PriorAnswerFactGroup {
  readable: boolean;
  latestIdentityVerdict: IdentityAssessment | null;
  hasCannotLink: boolean;
  hasMustLink: boolean;
}

/**
 * Everything the gatherer knows about one pair, frozen onto the proposal row.
 *
 * `schemaVersion` exists so a later reader can tell a bundle gathered under
 * today's rules from one gathered under tomorrow's. It is NOT a migration hook:
 * historical rows are never backfilled, because a verdict is a labelled example
 * and relabelling history under changed rules is the thing the frozen-evidence
 * doctrine forbids.
 */
export interface IdentityEvidenceFacts {
  schemaVersion: 1;
  /** ISO-8601, when these facts were read. */
  gatheredAt: string;
  pairKind: ContactLinkPairKind;
  identity: IdentityFactGroup;
  relationship: RelationshipFactGroup;
  eligibility: EligibilityFactGroup;
  priorAnswers: PriorAnswerFactGroup;
}

export const IDENTITY_EVIDENCE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// READS — one per endpoint kind, nothing clever
// ---------------------------------------------------------------------------

/** Raw values held by one endpoint, before any key rule is applied. */
interface EndpointValues {
  exists: boolean;
  removed: boolean;
  name: string | null;
  emails: string[];
  phones: string[];
  /** The contact that owns this record, for a record endpoint. */
  ownerContactId: string | null;
  onFrozenTransaction: boolean;
  lastCommunicationAt: string | null;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A corrupt blob is missing evidence, not a reason to fail a sync.
    return [];
  }
}

function readContactEndpoint(userId: string, contactId: string): EndpointValues {
  // ONE tombstone predicate, shared with every other reader
  // (`contactTombstoneSql.ACTIVE_CONTACTS_CLAUSE_UNALIASED`) rather than a
  // second hand-written `removed_at IS NULL`. A removed contact is EXCLUDED, and
  // there is deliberately no redirect to whichever contact absorbed it —
  // reporting a survivor here would answer a question nobody asked.
  const row = dbGet<{ display_name: string | null; is_active: number }>(
    CONTACT_NAME_AND_ACTIVE_SQL,
    [{ id: contactId, userId }],
  );

  if (!row) {
    return {
      exists: false,
      removed: false,
      name: null,
      emails: [],
      phones: [],
      ownerContactId: null,
      onFrozenTransaction: false,
      lastCommunicationAt: null,
    };
  }

  const emails = dbAll<{ email: string | null }>(
    CONTACT_EMAILS_SQL,
    [contactId],
  )
    .map((r) => r.email)
    .filter((e): e is string => typeof e === "string");

  // `phone_e164`, NOT `phone_normalized`, and the difference is deliberate.
  //
  // The stored key is written by `toLookupKey`, which has NO digit floor — it is
  // the JOIN key for search, short codes and `phone_last_message`. Keying the
  // contact side from `phone_e164` through `toMatchingKey` applies the SAME
  // floored rule the record side gets, so both sides of `sharedKeys` are
  // computed by one function.
  //
  // This cannot change which keys are SHARED. `toMatchingKey` is `toLookupKey`
  // with a floor, so an above-floor value keys identically to `phone_normalized`;
  // a below-floor value keys to "" here and is dropped, and it could never have
  // matched an above-floor probe key anyway (they differ in length) — which is
  // the property `contactMatchIndex.phoneProbeKeys` documents. What it DOES
  // change is the reported `unkeyableCount`, which is the honest fact: this
  // contact holds a number that may not be used to propose a match.
  const phones = dbAll<{ phone_e164: string | null }>(
    CONTACT_PHONES_SQL,
    [contactId],
  )
    .map((r) => r.phone_e164)
    .filter((p): p is string => typeof p === "string");

  const recency = dbGet<{ last_communication_at: string | null }>(
    IMPORTED_CONTACT_RECENCY_SQL,
    [contactId],
  );

  return {
    exists: true,
    removed: row.is_active === 0,
    name: row.display_name,
    emails,
    phones,
    ownerContactId: null,
    onFrozenTransaction: isContactOnFrozenTransaction(contactId),
    lastCommunicationAt: recency?.last_communication_at ?? null,
  };
}

function readRecordEndpoint(
  userId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): EndpointValues {
  const row = dbGet<{
    name: string | null;
    emails_json: string | null;
    phones_json: string | null;
    last_message_at: string | null;
  }>(
    EXTERNAL_RECORD_WITH_RECENCY_SQL,
    [userId, sourceType, sourceRecordId],
  );

  const linked = liveContactMatchIndex().linkedRecord(userId, sourceType, sourceRecordId);

  if (!row) {
    return {
      exists: false,
      removed: false,
      name: null,
      emails: [],
      phones: [],
      ownerContactId: linked?.contactId ?? null,
      onFrozenTransaction: false,
      lastCommunicationAt: null,
    };
  }

  return {
    exists: true,
    // An external record has no tombstone: `external_contacts` is a mirror of
    // an address book and a deleted card is deleted, not marked.
    removed: false,
    name: row.name,
    emails: parseJsonArray(row.emails_json),
    phones: parseJsonArray(row.phones_json),
    ownerContactId: linked?.contactId ?? null,
    onFrozenTransaction: false,
    lastCommunicationAt: row.last_message_at ?? null,
  };
}

function readEndpoint(userId: string, endpoint: EvidenceEndpoint): EndpointValues {
  return endpoint.kind === "contact"
    ? readContactEndpoint(userId, endpoint.contactId)
    : readRecordEndpoint(userId, endpoint.sourceType, endpoint.sourceRecordId);
}

// ---------------------------------------------------------------------------
// FACT ASSEMBLY — set arithmetic and string normalisation, no judgement
// ---------------------------------------------------------------------------

function identifierFacts(
  subjectValues: string[],
  candidateValues: string[],
  toKeys: (values: string[]) => string[],
): IdentifierFacts {
  const subjectRawKeys = toKeys(subjectValues);
  const candidateRawKeys = toKeys(candidateValues);
  const subjectKeys = unique(subjectRawKeys);
  const candidateKeys = unique(candidateRawKeys);
  const candidateSet = new Set(candidateKeys);

  return {
    subjectKeys,
    candidateKeys,
    sharedKeys: subjectKeys.filter((k) => candidateSet.has(k)),
    // Counted against the RAW values, BEFORE de-duplication, so a value that
    // yields no key is visible as a held-but-unusable number rather than
    // vanishing. `emailProbeKeys` / `phoneProbeKeys` both drop empty keys, so
    // the difference is exactly the count of values that produced none.
    subjectUnkeyableCount: subjectValues.length - subjectRawKeys.length,
    candidateUnkeyableCount: candidateValues.length - candidateRawKeys.length,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function endpointNameFacts(raw: string | null): EndpointNameFacts {
  const real = realContactName(raw) || null;
  const normalized = normalizeNameKey(real);
  return {
    raw,
    real,
    normalizedKey: normalized?.key ?? null,
    tokenCount: normalized?.tokens.length ?? 0,
    hasGenerationalSuffix: normalized?.hasGenerationalSuffix ?? false,
  };
}

/**
 * Which of the three shapes this pair is.
 *
 * The vocabulary is `contactIdentitySchemaSql.CONTACT_LINK_PAIR_KINDS`, imported
 * as a type rather than restated, so the gatherer and the CHECK constraint
 * cannot drift on the spelling.
 */
export function pairKindFor(
  subject: EvidenceEndpoint,
  candidate: EvidenceEndpoint,
): ContactLinkPairKind {
  if (subject.kind === "contact" && candidate.kind === "contact") return "contact_contact";
  if (subject.kind === "record" && candidate.kind === "record") return "record_record";
  return "record_contact";
}

// ---------------------------------------------------------------------------
// THE ONE ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Gather the facts about one pair. Pure read plus assembly — NO WRITES.
 *
 * Being read-only is what makes this assertable by exact ID set and reusable by
 * role inference with no retrofit, and it is why wiring it into the two existing
 * proposal writers cannot change a single decision they make.
 */
export function gatherIdentityEvidence(
  input: GatherIdentityEvidenceInput,
): IdentityEvidenceFacts {
  const { userId, subject, candidate } = input;

  const subjectValues = readEndpoint(userId, subject);
  const candidateValues = readEndpoint(userId, candidate);

  const subjectName = endpointNameFacts(subjectValues.name);
  const candidateName = endpointNameFacts(candidateValues.name);

  // The transaction graph is CONTACT-keyed, so this question can only be asked
  // of two saved contacts. For any pair with a record on it the answer is
  // `null` — "cannot be asked" — never `false`.
  const contactPair =
    subject.kind === "contact" && candidate.kind === "contact"
      ? { a: subject.contactId, b: candidate.contactId }
      : null;

  return {
    schemaVersion: IDENTITY_EVIDENCE_SCHEMA_VERSION,
    gatheredAt: new Date().toISOString(),
    pairKind: pairKindFor(subject, candidate),

    identity: {
      emails: identifierFacts(subjectValues.emails, candidateValues.emails, emailProbeKeys),
      phones: identifierFacts(subjectValues.phones, candidateValues.phones, phoneProbeKeys),
      name: {
        subject: subjectName,
        candidate: candidateName,
        // Both sides must HAVE a key. Two absences are not an agreement.
        normalizedKeysEqual:
          subjectName.normalizedKey !== null &&
          subjectName.normalizedKey === candidateName.normalizedKey,
        holderCount: input.nameHolderCount ?? null,
      },
      crosswalk: {
        subjectOwnerContactId: subjectValues.ownerContactId,
        candidateOwnerContactId: candidateValues.ownerContactId,
      },
    },

    relationship: {
      shareTransaction: contactPair
        ? contactsShareTransaction(contactPair.a, contactPair.b)
        : null,
      sharedTransactionAddressCount: contactPair
        ? sharedTransactionAddresses(contactPair.a, contactPair.b).length
        : null,
      subjectLastCommunicationAt: subjectValues.lastCommunicationAt,
      candidateLastCommunicationAt: candidateValues.lastCommunicationAt,
    },

    eligibility: {
      subjectExists: subjectValues.exists,
      candidateExists: candidateValues.exists,
      subjectRemoved: subjectValues.removed,
      candidateRemoved: candidateValues.removed,
      subjectOnFrozenTransaction: subjectValues.onFrozenTransaction,
      candidateOnFrozenTransaction: candidateValues.onFrozenTransaction,
    },

    priorAnswers: priorAnswerFacts(userId, subject, candidate),
  };
}

/**
 * Prior answers, for the ONE shape whose readers exist.
 *
 * `readable: false` on the two new shapes is the honest report. See
 * `PriorAnswerFactGroup`.
 */
function priorAnswerFacts(
  userId: string,
  subject: EvidenceEndpoint,
  candidate: EvidenceEndpoint,
): PriorAnswerFactGroup {
  const contactEnd =
    subject.kind === "contact" ? subject : candidate.kind === "contact" ? candidate : null;
  const recordEnd =
    subject.kind === "record" ? subject : candidate.kind === "record" ? candidate : null;

  if (!contactEnd || !recordEnd) {
    return {
      readable: false,
      latestIdentityVerdict: null,
      hasCannotLink: false,
      hasMustLink: false,
    };
  }

  const latest = getLatestVerdict(
    userId,
    contactEnd.contactId,
    recordEnd.sourceType,
    recordEnd.sourceRecordId,
  );

  return {
    readable: true,
    latestIdentityVerdict: latest?.identity_verdict ?? null,
    hasCannotLink: hasCannotLink(
      userId,
      contactEnd.contactId,
      recordEnd.sourceType,
      recordEnd.sourceRecordId,
    ),
    hasMustLink: hasMustLink(
      userId,
      contactEnd.contactId,
      recordEnd.sourceType,
      recordEnd.sourceRecordId,
    ),
  };
}

/**
 * Gather the facts for a `record_contact` pair without throwing.
 *
 * The two production proposal writers are both best-effort by design — a sync
 * that succeeded must not be reported as failed because a question could not be
 * filed — so the facts must never be the thing that breaks them. On any failure
 * the proposal is still written, with its sentences, and without facts.
 * `undefined` is a real state: rows written before this piece landed have no
 * facts either, and they are never backfilled.
 *
 * THE FAILURE IS LOGGED, NOT SWALLOWED SILENTLY. A gather that throws every time
 * would otherwise leave every proposal factless while every suite stayed green —
 * the shape of failure this project keeps paying for. In a TEST that means the
 * fixture must carry the tables `contactRecencySql` reads (`emails`,
 * `email_participants`, `phone_last_message`); a suite that only needs the
 * decisions and not the facts may leave them out and will see this warning.
 */
export function tryGatherIdentityEvidence(
  input: GatherIdentityEvidenceInput,
): IdentityEvidenceFacts | undefined {
  try {
    return gatherIdentityEvidence(input);
  } catch (error) {
    logService.warn(
      `[Contacts] could not gather identity evidence: ${error}`,
      "Contacts",
    );
    return undefined;
  }
}

// This module deliberately exports NO function that takes both the identity and
// the relationship branch, and no function whose name or return type reads as a
// verdict. See the header: the founder's 2026-08-02 ruling is enforced by the
// ABSENCE, and `contactIdentityEvidence.test.ts` asserts the export surface so
// the absence cannot be filled in by accident.
