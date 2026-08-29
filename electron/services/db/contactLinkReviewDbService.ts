/**
 * Contact Link Review — the queue and the verdicts (BACKLOG-2410)
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * BACKLOG-2401 taught the linker to WITHHOLD an ambiguous match rather than
 * apply it. Withholding was the correct half. This is the other half: the
 * withheld question has to be asked, and the answer has to be kept.
 *
 * ===========================================================================
 * THE TWO TABLES ARE NOT THE SAME KIND OF THING
 * ===========================================================================
 *   contact_link_proposals — DERIVED. Recomputed by every linking pass.
 *                            Losing it costs one sync.
 *   contact_link_verdicts  — NOT DERIVED. A record of what a human said.
 *                            Losing it is unrecoverable: there is no second
 *                            source of ground truth anywhere in this system,
 *                            and nothing can regenerate a person's opinion.
 *
 * Every function below is written on that asymmetry. Proposals are upserted,
 * ignored on conflict, and freely rewritten. Verdicts are only ever appended.
 *
 * ===========================================================================
 * THE "NEVER PROPOSED AGAIN" GUARANTEE HAS TWO INDEPENDENT LOCKS
 * ===========================================================================
 * 1. `UNIQUE (user_id, contact_id, source_type, source_record_id)` on the
 *    proposal, written with INSERT OR IGNORE. A pair already answered keeps its
 *    resolved row; a re-run cannot flip it back to pending.
 * 2. `getCannotLink` consulted by the linker BEFORE it links or proposes.
 *
 * THEY GUARD DIFFERENT THINGS, and the negative controls measured which:
 *
 *   Lock 1 (the UNIQUE) is the only thing stopping an UNANSWERED question being
 *   appended again on every sync. Removing it fails exactly one test — the queue
 *   grows without bound and the button's count climbs each time a sync runs.
 *
 *   Lock 2 (the verdict consult) is the only thing stopping an ANSWERED pair
 *   being silently LINKED by some other route. Removing it lets a source the
 *   user unlinked by hand come straight back on the next pass.
 *
 * Neither substitutes for the other. Lock 1 governs the queue; lock 2 governs
 * the outcome. A guarantee that only stopped the question being re-asked, while
 * letting the link be silently created, would be worse than no guarantee at all
 * — the user would believe they had been heard.
 *
 * ===========================================================================
 * TWO AXES. WORDS. NO SCORES.
 * ===========================================================================
 * Identity and relationship are separate columns with separate vocabularies
 * (founder decision, 2026-08-02):
 *
 *     identity      same_person | possibly_same_person | different_people
 *     relationship  connected   | possibly_connected   | no_known_connection
 *
 * A buyer and a seller on one deal are `connected` AND `different_people`.
 * There is deliberately no numeric column on either table. `confidence` exists
 * on `contact_source_links` for a future scored matcher; nothing here has an
 * equivalent, because a review queue that shows a user "0.82" has told them
 * nothing they can act on.
 */

import { v4 as uuidv4 } from "uuid";
import { dbAll, dbGet, dbRun } from "./core/dbConnection";
import type { ExternalContactSource } from "./externalContactDbService";
// TYPE-ONLY, and deliberately so: `contactIdentityEvidence` imports this module's
// verdict readers as VALUES, so a value import here would close a runtime require
// cycle. `import type` is erased by TypeScript and cannot.
import type { IdentityEvidenceFacts } from "../contactIdentityEvidence";
// The SAME key builder the already-imported filter compares against, so a
// released record and a linked one are keyed identically — the PAIR, never the
// id alone.
import { sourceKey } from "./contactSourceLinkDbService";

// ---------------------------------------------------------------------------
// VOCABULARY
// ---------------------------------------------------------------------------

/**
 * Reuses the pending/confirmed/rejected idiom already in this codebase
 * (`transactions.detection_status`, models.ts). Deliberately not a new one.
 */
export type LinkProposalStatus = "pending" | "confirmed" | "rejected";

/** Axis 1 — are these the same person? */
export type IdentityAssessment = "same_person" | "possibly_same_person" | "different_people";

/** Axis 2 — are these people connected? Orthogonal to axis 1, never merged into it. */
export type RelationshipAssessment = "connected" | "possibly_connected" | "no_known_connection";

/**
 * Why the question is being asked. The first four mirror
 * `contactSourceLinker.FlagReason` exactly (a withheld content match); the rest
 * come from the unique-exact-name rule.
 *
 * Kept as ONE union rather than two so the queue has a single vocabulary — the
 * user does not care which module declined to guess.
 */
export type LinkProposalReason =
  // --- withheld content matches (BACKLOG-2401) ---
  | "identifier_reassigned"
  | "duplicate_source_record"
  | "ambiguous_identifier"
  | "frozen_audit_contact"
  // --- the unique-exact-name rule (BACKLOG-2410 part 3) ---
  /** 3+ records/contacts carry this name, so a name cannot identify anyone. */
  | "name_not_unique"
  /** Exactly two, but both from the same source family — a within-source dupe. */
  | "name_same_source_family"
  /** Jr / Sr / II / III on either side. The credit-bureau mixed-file pattern. */
  | "name_generational_suffix"
  /** Exactly two, cross-family, but each already belongs to a DIFFERENT saved
   *  contact. Joining them is a merge (BACKLOG-2370), not a link. */
  | "name_two_saved_contacts"
  // --- the tier gate (BACKLOG-2668) ---
  /**
   * The pair PASSED the unique-name rule — one record on each side, nobody else
   * anywhere, no generational suffix — and was not linked anyway, because
   * automatic linking is not turned on for this user.
   *
   * The only reason in this union that is not a doubt about the evidence. Every
   * other name reason says "the rule could not tell"; this one says "the rule
   * was sure and is not allowed to act on it". That is a different sentence to
   * the user and has to stay a different value: folding it into
   * `name_not_unique` would tell them their records are ambiguous when the
   * entire basis of the question is that they are not.
   */
  | "name_unique_suggestion"
  // --- the linker's NAME VETO (BACKLOG-2619 / BACKLOG-2624) ---
  //
  // Not the rule above. Those four are reasons a NAME MATCH was refused; these
  // two are reasons an IDENTIFIER match was refused, on the evidence of the
  // names. Adding them needed no migration: `contact_link_proposals.reason` is
  // `TEXT NOT NULL` with no CHECK, deliberately, unlike `source_type`.
  /** The identifier is shared but the two are saved under names that disagree —
   *  the office line, the household, the number that changed hands. */
  | "name_mismatch"
  /** The identifier is shared and one of the two has no name to check it
   *  against. A missing name is absence of evidence, not a match. */
  | "name_unknown";

/**
 * The evidence shown to the user, pre-rendered into sentences.
 *
 * BUILT IN THE MAIN PROCESS, NOT THE RENDERER, and stored rather than
 * recomputed. Two reasons, and the second is the important one:
 *   - the sentences need `contacts.display_name`, the source record's name and
 *     the transaction graph, none of which the renderer has;
 *   - a verdict is a LABELLED EXAMPLE, and a label is only usable alongside the
 *     evidence as it stood when the human saw it. Recomputing later under
 *     changed rules would silently relabel history.
 *
 * No field here is a number that could be read as a score.
 */
export interface LinkProposalEvidence {
  /** The one-sentence "why am I being asked this". */
  summary: string;
  /** Supporting statements, each already a full sentence. */
  details: string[];
  /** What to call the saved contact in the UI. */
  contactLabel: string;
  /** What to call the source ("your Outlook contacts"). */
  sourceLabel: string;
  /** The name the source record carries, if any. */
  sourceName: string | null;
  /**
   * The FACTS behind the sentences — BACKLOG-2630 D2 piece 2.
   *
   * Gathered by `contactIdentityEvidence.gatherIdentityEvidence` and frozen here
   * beside the prose, under the SAME rule the prose already follows: a verdict is
   * a labelled example, and a label is only usable alongside the evidence as it
   * stood when the human saw it. That is what makes the answered rows a usable
   * calibration set for the matcher D3 will build.
   *
   * OPTIONAL, AND THAT IS LOAD-BEARING. Every proposal and verdict written before
   * this piece landed has no facts, and they are NEVER BACKFILLED — recomputing
   * them under today's rules would silently relabel history, which is the thing
   * the frozen-evidence doctrine exists to prevent. A reader must therefore treat
   * `undefined` as "not gathered", never as "nothing found".
   *
   * `parseEvidence` gates only on `summary` being a string and returns the parsed
   * object as-is, so an older row round-trips unchanged.
   *
   * NOTHING IN HERE IS A SCORE, and nothing in here is a decision. See that
   * module's header.
   */
  facts?: IdentityEvidenceFacts;
}

export interface LinkProposalRow {
  id: string;
  user_id: string;
  contact_id: string;
  source_type: ExternalContactSource;
  source_record_id: string;
  status: LinkProposalStatus;
  reason: LinkProposalReason;
  matched_on: string | null;
  identity_assessment: IdentityAssessment;
  relationship_assessment: RelationshipAssessment;
  cluster_key: string;
  evidence_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ProposeLinkInput {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  reason: LinkProposalReason;
  matchedOn?: string | null;
  identityAssessment: IdentityAssessment;
  relationshipAssessment: RelationshipAssessment;
  clusterKey: string;
  evidence: LinkProposalEvidence;
}

export interface LinkVerdictRow {
  id: string;
  user_id: string;
  contact_id: string;
  source_type: ExternalContactSource;
  source_record_id: string;
  identity_verdict: IdentityAssessment;
  relationship_verdict: RelationshipAssessment | null;
  reason: string | null;
  matched_on: string | null;
  evidence_json: string | null;
  decided_at: string;
  decided_by: string;
}

export interface RecordVerdictInput {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  identityVerdict: IdentityAssessment;
  relationshipVerdict?: RelationshipAssessment | null;
  reason?: string | null;
  matchedOn?: string | null;
  evidence?: LinkProposalEvidence | null;
  decidedBy?: string;
}

const PROPOSAL_COLUMNS = `
  id, user_id, contact_id, source_type, source_record_id, status, reason,
  matched_on, identity_assessment, relationship_assessment, cluster_key,
  evidence_json, created_at, resolved_at
`;

const VERDICT_COLUMNS = `
  id, user_id, contact_id, source_type, source_record_id, identity_verdict,
  relationship_verdict, reason, matched_on, evidence_json, decided_at, decided_by
`;

// ---------------------------------------------------------------------------
// PROPOSALS
// ---------------------------------------------------------------------------

/**
 * Put a pair on the queue, or leave an already-answered one alone.
 *
 * INSERT OR IGNORE against the pair UNIQUE is the whole mechanism. It is chosen
 * over "delete pending rows then re-insert" — the obvious way to keep a derived
 * queue fresh — precisely BECAUSE that pattern cannot distinguish a stale
 * pending row from a resolved one without an extra predicate that is easy to get
 * wrong on a later edit. Here, being answered is structurally protective: the
 * row exists, so the insert is a no-op, so the answer stands.
 *
 * Returns `created: false` for an already-queued or already-answered pair. That
 * is the steady state, not a failure.
 */
export function proposeLink(input: ProposeLinkInput): { created: boolean; id: string | null } {
  if (!input.sourceRecordId || !input.contactId) {
    return { created: false, id: null };
  }

  const id = uuidv4();
  const result = dbRun(
    `INSERT OR IGNORE INTO contact_link_proposals
       (id, user_id, contact_id, source_type, source_record_id, status, reason,
        matched_on, identity_assessment, relationship_assessment, cluster_key, evidence_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.contactId,
      input.sourceType,
      input.sourceRecordId,
      input.reason,
      input.matchedOn ?? null,
      input.identityAssessment,
      input.relationshipAssessment,
      input.clusterKey,
      JSON.stringify(input.evidence),
    ],
  );

  return result.changes > 0 ? { created: true, id } : { created: false, id: null };
}

/** Everything still waiting on a human, oldest cluster first. */
export function listPendingProposals(userId: string): LinkProposalRow[] {
  return dbAll<LinkProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals
      WHERE user_id = ? AND status = 'pending'
      ORDER BY cluster_key, created_at, id`,
    [userId],
  );
}

/**
 * The number on the button.
 *
 * Counts PAIRS, not clusters. The founder's wording is "Review 12 possible
 * duplicates" — twelve things that might be wrong, however few questions it
 * takes to resolve them.
 */
export function countPendingProposals(userId: string): number {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_link_proposals
      WHERE user_id = ? AND status = 'pending'`,
    [userId],
  );
  return row?.n ?? 0;
}

export function getProposalById(id: string): LinkProposalRow | null {
  return (
    dbGet<LinkProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals WHERE id = ?`, [
      id,
    ]) ?? null
  );
}

/** Every proposal in one cluster that is still pending — the cluster answer's scope. */
export function listPendingProposalsInCluster(
  userId: string,
  clusterKey: string,
): LinkProposalRow[] {
  return dbAll<LinkProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals
      WHERE user_id = ? AND cluster_key = ? AND status = 'pending'
      ORDER BY created_at, id`,
    [userId, clusterKey],
  );
}

/**
 * Move a proposal out of the queue.
 *
 * Guarded on `status = 'pending'` so a double-click, a stale renderer, or two
 * windows answering the same question cannot rewrite a decision that has
 * already been made and acted on. Returns whether THIS call was the one that
 * resolved it — the caller uses that to decide whether to perform the side
 * effect (create the link), so the side effect runs exactly once.
 */
export function resolveProposal(id: string, status: Exclude<LinkProposalStatus, "pending">): boolean {
  const result = dbRun(
    `UPDATE contact_link_proposals
        SET status = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`,
    [status, id],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// VERDICTS — append only
// ---------------------------------------------------------------------------

/**
 * Write down what the human said. Never updates, never deletes.
 *
 * `decidedBy` distinguishes routes to the same conclusion — a queue answer and
 * a provenance unlink both mean "not the same person", but only one of them was
 * a question the user chose to answer, and a calibration set that cannot tell
 * them apart will read an unprompted correction as a prompted one.
 */
export function recordVerdict(input: RecordVerdictInput): string {
  const id = uuidv4();
  dbRun(
    `INSERT INTO contact_link_verdicts
       (id, user_id, contact_id, source_type, source_record_id, identity_verdict,
        relationship_verdict, reason, matched_on, evidence_json, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.contactId,
      input.sourceType,
      input.sourceRecordId,
      input.identityVerdict,
      input.relationshipVerdict ?? null,
      input.reason ?? null,
      input.matchedOn ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.decidedBy ?? "user",
    ],
  );
  return id;
}

/**
 * The most recent thing the user said about this exact pair, or null.
 *
 * LATEST WINS, resolved here rather than by a UNIQUE constraint, because a user
 * is allowed to change their mind and the earlier answer is still history worth
 * keeping.
 *
 * `decided_at` has second granularity in SQLite, so `rowid` breaks ties between
 * two decisions inside the same second. THAT IS DELIBERATE AND IT IS THE ONLY
 * CORRECT CHOICE HERE: `rowid` is insertion order, so it is chronological, while
 * `recordVerdict` assigns a `uuidv4()` — ordering by `id` would be RANDOM, and a
 * reversal made inside the same second as the answer it reverses would take
 * effect or not by chance.
 *
 * This comment used to say the opposite — that `id` broke the tie and that rowid
 * order was "by accident" — while the SQL below has always read `rowid`. It is
 * corrected rather than deleted (BACKLOG-2471 PR F) because the danger is not
 * the stale sentence: it is the next reader making the SQL match the prose.
 *
 * Anything that resolves "latest verdict" elsewhere MUST order the same way, or
 * two surfaces will disagree about the same pair. `getRejectedSourceKeys` below
 * and `getReviewStateByContact` in `contactSourceSets.ts` both do.
 */
export function getLatestVerdict(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): LinkVerdictRow | null {
  return (
    dbGet<LinkVerdictRow>(
      `SELECT ${VERDICT_COLUMNS} FROM contact_link_verdicts
        WHERE user_id = ? AND contact_id = ? AND source_type = ? AND source_record_id = ?
        ORDER BY decided_at DESC, rowid DESC
        LIMIT 1`,
      [userId, contactId, sourceType, sourceRecordId],
    ) ?? null
  );
}

/**
 * Is this pair barred? THE LOAD-BEARING READ OF THIS WHOLE FEATURE.
 *
 * Called by the linker before it links OR proposes. A `different_people` verdict
 * is a hard constraint: no rule, present or future, may create this link or ask
 * about it again. `possibly_same_person` is NOT a bar — it means the user looked
 * and could not tell, which is a reason to stop asking today, not forever.
 */
export function hasCannotLink(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const verdict = getLatestVerdict(userId, contactId, sourceType, sourceRecordId);
  return verdict?.identity_verdict === "different_people";
}

/** The opposite constraint: the user has asserted these ARE the same person. */
export function hasMustLink(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const verdict = getLatestVerdict(userId, contactId, sourceType, sourceRecordId);
  return verdict?.identity_verdict === "same_person";
}

/**
 * The labelled set — every verdict ever recorded, newest first.
 *
 * This is the calibration and regression-test corpus named in the acceptance
 * criteria. It is exposed as a plain read with no filtering so a future
 * threshold-tuning or matcher-regression job takes the whole thing and decides
 * for itself what is relevant; a "useful subset" chosen now would bake in
 * today's idea of which features matter.
 */
export function listVerdicts(userId: string): LinkVerdictRow[] {
  return dbAll<LinkVerdictRow>(
    `SELECT ${VERDICT_COLUMNS} FROM contact_link_verdicts
      WHERE user_id = ?
      ORDER BY decided_at DESC, rowid DESC`,
    [userId],
  );
}

/**
 * Source records the user has RELEASED — BACKLOG-2427 / BACKLOG-2416.
 *
 * Every `(source_type, source_record_id)` whose LATEST verdict for some contact
 * is `different_people`, as `sourceKey()` strings.
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND WHY IT HAD TO EXIST
 * ===========================================================================
 * Founder QA, 2026-08-02. He pressed "Not this person" on the Outlook source of
 * his saved contact Casey Lane. The link went and the verdict was recorded —
 * and the released record then vanished from the import picker entirely. It
 * could not be re-imported, assigned, or acted on, and a forced re-import did
 * not bring it back.
 *
 * The picker's already-imported filter inferred ownership from a PHONE NUMBER:
 * the released record carries `4085550101`, the saved Casey carries it too (the
 * backfill copied it there), so the record was filtered as "already imported"
 * because of the very data the unlink had failed to remove.
 *
 * Note what does NOT fix this. The released record's name is "Casey Lane" —
 * identical to the contact's — so a name-compatibility rule still hides it. And
 * the phone is genuinely present on the still-linked macOS card, so the
 * BACKLOG-2427 removal correctly keeps it. Only the user's own recorded answer
 * distinguishes "this record is that person" from "this record merely shares
 * that person's office line", which is why the filter must consult THIS.
 *
 * ===========================================================================
 * LATEST WINS, PER PAIR
 * ===========================================================================
 * A user may change their mind, and `recordVerdict` never updates or deletes —
 * it appends. So the newest row per (contact, source record) pair is resolved
 * first and only then filtered, exactly as `getLatestVerdict` does for one pair.
 * Ranking by `decided_at DESC, rowid DESC` matches it: `decided_at` has second
 * granularity in SQLite, so `rowid` is what breaks a tie between two decisions
 * inside the same second — without it a reversal can silently fail to take
 * effect.
 *
 * A record rejected from contact A may still be legitimately linked to contact
 * B. That is not this function's problem to solve: the caller checks the
 * CROSSWALK first and a linked record never reaches the content-based checks
 * this set guards.
 */
export function getRejectedSourceKeys(userId: string): Set<string> {
  const rows = dbAll<{ source_type: string; source_record_id: string }>(
    `SELECT source_type, source_record_id FROM (
       SELECT source_type, source_record_id, identity_verdict,
              ROW_NUMBER() OVER (
                PARTITION BY contact_id, source_type, source_record_id
                ORDER BY decided_at DESC, rowid DESC
              ) AS rn
         FROM contact_link_verdicts
        WHERE user_id = ?
     )
     WHERE rn = 1 AND identity_verdict = 'different_people'`,
    [userId],
  );
  return new Set(rows.map((r) => sourceKey(r.source_type as ExternalContactSource, r.source_record_id)));
}

export function countVerdicts(userId: string): number {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_link_verdicts WHERE user_id = ?`,
    [userId],
  );
  return row?.n ?? 0;
}

/** Parse an `evidence_json` blob back into its object, tolerating corruption. */
export function parseEvidence(raw: string | null): LinkProposalEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LinkProposalEvidence;
    return typeof parsed?.summary === "string" ? parsed : null;
  } catch {
    return null;
  }
}
